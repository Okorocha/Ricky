import { db } from "@workspace/db";
import { signals, activeSetups, activeTrades, telegramLog } from "@workspace/db";
import { eq, and, desc, gte } from "drizzle-orm";

const TOKEN = process.env.TELEGRAM_TOKEN || "";
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";
const POLL_INTERVAL = 30000; // 30 seconds

// ── Scan result ───────────────────────────────────────────────────────────────
export interface ScanResult {
  setupFound: boolean;
  count: number;
  reason: string;
}

// ── In-memory signal cooldown per zone (prevent duplicate signals) ────────────
const zoneCooldowns = new Map<string, number>();
const ZONE_COOLDOWN_MS = 20 * 60 * 1000; // 20 minutes

function isZoneOnCooldown(zoneKey: string): boolean {
  const last = zoneCooldowns.get(zoneKey);
  if (!last) return false;
  return Date.now() - last < ZONE_COOLDOWN_MS;
}
function markZoneCooldown(zoneKey: string): void {
  zoneCooldowns.set(zoneKey, Date.now());
}

// ── DB-level cooldown check (survives server restarts) ────────────────────────
async function isZoneOnCooldownDB(zoneKey: string): Promise<boolean> {
  try {
    const cutoff = new Date(Date.now() - ZONE_COOLDOWN_MS);
    const recent = await db
      .select({ id: signals.id })
      .from(signals)
      .where(and(eq(signals.zoneKey, zoneKey), gte(signals.createdAt, cutoff)))
      .limit(1);
    return recent.length > 0;
  } catch {
    return false; // fail open — let in-memory cooldown handle it
  }
}

// ── Price history for multi-tick confirmation ─────────────────────────────────
interface PriceTick {
  price: number;
  spread: number;
  ts: number;
}
const priceHistory: PriceTick[] = [];
const PRICE_HISTORY_MAX = 20;

function recordPriceTick(price: number, spread: number): void {
  priceHistory.push({ price, spread, ts: Date.now() });
  if (priceHistory.length > PRICE_HISTORY_MAX) {
    priceHistory.shift();
  }
}

function getPriceContext(): {
  velocity: number;
  spreadAvg: number;
  consistent: boolean;
  tickCount: number;
} {
  if (priceHistory.length < 2) {
    return { velocity: 0, spreadAvg: priceHistory[0]?.spread ?? 0.5, consistent: false, tickCount: priceHistory.length };
  }
  const recent = priceHistory.slice(-Math.min(priceHistory.length, 8));
  const deltas = recent.slice(1).map((t, i) => t.price - recent[i]!.price);
  const velocity = deltas.reduce((a, b) => a + b, 0) / deltas.length;
  const spreadAvg = recent.reduce((a, t) => a + t.spread, 0) / recent.length;
  const positives = deltas.filter(d => d > 0).length;
  const negatives = deltas.filter(d => d < 0).length;
  const consistent = positives >= Math.ceil(deltas.length * 0.7) || negatives >= Math.ceil(deltas.length * 0.7);
  return { velocity, spreadAvg, consistent, tickCount: recent.length };
}

// ── Twelve Data OHLC Fetching (real-time XAU/USD spot) ───────────────────────
const TWELVE_DATA_KEY = process.env.TWELVE_DATA_API_KEY || "";

interface OHLCCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

// interval examples: "1min", "5min", "1h", "1day"
async function fetchTwelveDataOHLC(interval: string, outputsize: number): Promise<OHLCCandle[]> {
  const url = `https://api.twelvedata.com/time_series?symbol=XAU/USD&interval=${interval}&outputsize=${outputsize}&apikey=${TWELVE_DATA_KEY}`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (resp.status !== 200) throw new Error(`Twelve Data HTTP ${resp.status}`);
  const j = await resp.json() as { status?: string; message?: string; values?: { datetime: string; open: string; high: string; low: string; close: string }[] };
  if (j.status === "error") throw new Error(`Twelve Data: ${j.message}`);
  type TDRow = { datetime: string; open: string; high: string; low: string; close: string };
  const values: TDRow[] = j.values || [];
  // Twelve Data returns newest-first — reverse so array is oldest→newest
  return values
    .reverse()
    .map(v => ({
      time: new Date(v.datetime.replace(" ", "T") + "Z").getTime(),
      open: parseFloat(v.open),
      high: parseFloat(v.high),
      low: parseFloat(v.low),
      close: parseFloat(v.close),
    }))
    .filter(c => c.high > 0);
}

// ── 1-minute candle cache (for pattern detection) ─────────────────────────────
let minuteCandleCache: { candles: OHLCCandle[]; fetchedAt: number } | null = null;
const MINUTE_CACHE_TTL = 45_000; // 45 seconds

let fiveMinuteCandleCache: { candles: OHLCCandle[]; fetchedAt: number } | null = null;
const FIVE_MINUTE_CACHE_TTL = 2 * 60 * 1000; // 2 minutes

// ── Asian Session High/Low tracking ──────────────────────────────────────────
let asianSessionRange: { high: number; low: number; date: string } | null = null;

export async function getRecentMinuteCandles(): Promise<OHLCCandle[]> {
  const now = Date.now();
  if (minuteCandleCache && now - minuteCandleCache.fetchedAt < MINUTE_CACHE_TTL) {
    return minuteCandleCache.candles;
  }
  try {
    const candles = await fetchTwelveDataOHLC("1min", 60);
    minuteCandleCache = { candles, fetchedAt: now };
    return candles;
  } catch {
    return minuteCandleCache?.candles ?? [];
  }
}

export async function getRecentFiveMinuteCandles(): Promise<OHLCCandle[]> {
  const now = Date.now();
  if (fiveMinuteCandleCache && now - fiveMinuteCandleCache.fetchedAt < FIVE_MINUTE_CACHE_TTL) {
    return fiveMinuteCandleCache.candles;
  }
  try {
    const candles = await fetchTwelveDataOHLC("5min", 100);
    fiveMinuteCandleCache = { candles, fetchedAt: now };
    return candles;
  } catch {
    return fiveMinuteCandleCache?.candles ?? [];
  }
}

// ── Dynamic Level Computation ────────────────────────────────────────────────
// Fallback static levels used until the first successful refresh
let LEVELS: Record<string, { price: number; label: string; tier: string }> = {
  pp:  { price: 4060.00, label: "Daily Pivot",          tier: "major" },
  r1:  { price: 4080.00, label: "Daily R1",             tier: "key"   },
  r2:  { price: 4110.00, label: "Daily R2",             tier: "major" },
  r3:  { price: 4130.00, label: "Daily R3",             tier: "key"   },
  s1:  { price: 4040.00, label: "Daily S1",             tier: "key"   },
  s2:  { price: 4010.00, label: "Daily S2",             tier: "major" },
  s3:  { price: 3990.00, label: "Daily S3",             tier: "key"   },
  sh1: { price: 4120.00, label: "Swing High 1",         tier: "major" },
  sl1: { price: 4000.00, label: "Swing Low 1",          tier: "major" },
};

let levelsRefreshedAt = 0;
const LEVELS_REFRESH_INTERVAL = 4 * 60 * 60 * 1000; // 4 hours

async function refreshDynamicLevels(): Promise<void> {
  try {
    const [dailyCandles, hourlyCandles, fiveMinCandles] = await Promise.allSettled([
      fetchTwelveDataOHLC("1day", 5),
      fetchTwelveDataOHLC("1h", 120),
      fetchTwelveDataOHLC("5min", 300),
    ]);

    const daily = dailyCandles.status === "fulfilled" ? dailyCandles.value : [];
    const hourly = hourlyCandles.status === "fulfilled" ? hourlyCandles.value : [];
    const fiveMin = fiveMinCandles.status === "fulfilled" ? fiveMinCandles.value : [];

    // Compute Asian Session High/Low (00:00 - 07:00 UTC)
    const todayStr = new Date().toISOString().split("T")[0]!;
    const asianCandles = fiveMin.filter(c => {
      const d = new Date(c.time);
      const h = d.getUTCHours();
      return h >= 0 && h < 7;
    });
    if (asianCandles.length > 0) {
      asianSessionRange = {
        high: Math.max(...asianCandles.map(c => c.high)),
        low: Math.min(...asianCandles.map(c => c.low)),
        date: todayStr
      };
    }

    if (daily.length < 2) {
      console.warn("[Bot] Not enough daily data to compute pivots — keeping current levels");
      return;
    }

    // Use previous completed day (second-to-last; last candle may be in-progress)
    const prev = daily[daily.length - 2]!;
    const PP = (prev.high + prev.low + prev.close) / 3;
    const R1 = 2 * PP - prev.low;
    const R2 = PP + (prev.high - prev.low);
    const R3 = prev.high + 2 * (PP - prev.low);
    const S1 = 2 * PP - prev.high;
    const S2 = PP - (prev.high - prev.low);
    const S3 = prev.low - 2 * (prev.high - PP);

    const round2 = (n: number) => Math.round(n * 100) / 100;

    const newLevels: Record<string, { price: number; label: string; tier: string }> = {
      pp: { price: round2(PP), label: "Daily Pivot",  tier: "major" },
      r1: { price: round2(R1), label: "Daily R1",     tier: "key"   },
      r2: { price: round2(R2), label: "Daily R2",     tier: "major" },
      r3: { price: round2(R3), label: "Daily R3",     tier: "key"   },
      s1: { price: round2(S1), label: "Daily S1",     tier: "key"   },
      s2: { price: round2(S2), label: "Daily S2",     tier: "major" },
      s3: { price: round2(S3), label: "Daily S3",     tier: "key"   },
    };

    // Detect swing highs/lows from 1h data (3-bar pivot rule)
    if (hourly.length >= 7) {
      const lookback = 3;
      const swingHighs: number[] = [];
      const swingLows: number[]  = [];

      for (let i = lookback; i < hourly.length - lookback; i++) {
        const c = hourly[i]!;
        const leftH  = hourly.slice(i - lookback, i);
        const rightH = hourly.slice(i + 1, i + lookback + 1);
        if (leftH.every(x => x.high <= c.high) && rightH.every(x => x.high <= c.high)) {
          swingHighs.push(c.high);
        }
        if (leftH.every(x => x.low >= c.low) && rightH.every(x => x.low >= c.low)) {
          swingLows.push(c.low);
        }
      }

      // Most recent 3 swings, deduplicated within $2 of each other
      const dedup = (arr: number[]): number[] =>
        arr.filter((v, i, a) => !a.slice(0, i).some(u => Math.abs(u - v) < 2));

      dedup(swingHighs).slice(-3).forEach((h, i) => {
        newLevels[`sh${i + 1}`] = {
          price: round2(h),
          label: `Hourly Swing High ${i + 1}`,
          tier: i === 0 ? "major" : "minor",
        };
      });
      dedup(swingLows).slice(-3).forEach((l, i) => {
        newLevels[`sl${i + 1}`] = {
          price: round2(l),
          label: `Hourly Swing Low ${i + 1}`,
          tier: i === 0 ? "major" : "minor",
        };
      });
    }

    // Psychological $50 round numbers within $200 of current price
    const currentPrice = priceHistory.length > 0
      ? priceHistory[priceHistory.length - 1]!.price
      : PP;
    const roundStep = 50;
    const base = Math.floor(currentPrice / roundStep) * roundStep;
    for (let i = -4; i <= 4; i++) {
      const r = base + i * roundStep;
      // Only add if no existing level is within $5
      if (!Object.values(newLevels).some(v => Math.abs(v.price - r) < 5)) {
        newLevels[`rnd${r}`] = {
          price: r,
          label: `Psychological $${r}`,
          tier: "minor",
        };
      }
    }

    // Add Asian High/Low as key levels if available
    if (asianSessionRange && asianSessionRange.date === todayStr) {
      newLevels["asian_high"] = { price: asianSessionRange.high, label: "Asian Session High", tier: "major" };
      newLevels["asian_low"]  = { price: asianSessionRange.low,  label: "Asian Session Low",  tier: "major" };
    }

    LEVELS = newLevels;
    levelsRefreshedAt = Date.now();
    console.log(`[Bot] Dynamic levels refreshed — ${Object.keys(newLevels).length} zones | PP: $${PP.toFixed(2)} | Prev day H/L: $${prev.high.toFixed(2)}/$${prev.low.toFixed(2)}`);
  } catch (err) {
    console.error("[Bot] Failed to refresh dynamic levels:", err);
  }
}

export async function ensureLevelsRefreshed(): Promise<void> {
  if (Date.now() - levelsRefreshedAt > LEVELS_REFRESH_INTERVAL) {
    await refreshDynamicLevels();
  }
}

function getZoneThreshold(tier: string): { entering: number; atLevel: number; sweep: number } {
  switch (tier) {
    case "major": return { entering: 10.0, atLevel: 3.0, sweep: 1.5 };
    case "key":   return { entering: 8.0,  atLevel: 2.5, sweep: 1.2 };
    default:      return { entering: 6.0,  atLevel: 2.0, sweep: 1.0 };
  }
}

function get5mStructure(candles: OHLCCandle[]): "bullish" | "bearish" | "neutral" {
  if (candles.length < 10) return "neutral";
  
  const recent = candles.slice(-20);
  const highs = recent.map(c => c.high);
  const lows = recent.map(c => c.low);
  
  // Simple BoS (Break of Structure) detection
  const lastHigh = Math.max(...highs.slice(-10, -2));
  const lastLow = Math.min(...lows.slice(-10, -2));
  
  const currentHigh = Math.max(...highs.slice(-2));
  const currentLow = Math.min(...lows.slice(-2));
  
  if (currentHigh > lastHigh) return "bullish";
  if (currentLow < lastLow) return "bearish";
  
  // Fallback to Higher Highs / Lower Lows
  let hh = 0, ll = 0;
  for (let i = 1; i < recent.length; i++) {
    if (recent[i]!.high > recent[i-1]!.high) hh++;
    if (recent[i]!.low < recent[i-1]!.low) ll++;
  }
  
  if (hh > ll + 3) return "bullish";
  if (ll > hh + 3) return "bearish";
  
  return "neutral";
}

// ── Candlestick / Price-action confirmation ──────────────────────────────────
type CandlePattern = "pin_bar" | "engulfing" | "rejection" | "momentum" | "weak";

interface CandleSignal {
  pattern: CandlePattern;
  strength: "strong" | "moderate" | "weak";
  confirmed: boolean;
}

/** Detect patterns from real 1-min OHLC candles. Falls back to velocity when candles unavailable. */
function detectCandleSignal(
  price: number,
  spread: number,
  zoneDist: number,
  zoneStatus: string,
  direction: "LONG" | "SHORT",
  candles: OHLCCandle[] = []
): CandleSignal {
  const isLong = direction === "LONG";

  // ── Real candle analysis (requires at least 3 candles) ──────────────────
  if (candles.length >= 3) {
    const recent = candles.slice(-6); // last 6 one-minute candles
    const last   = recent[recent.length - 1]!;
    const prev   = recent[recent.length - 2]!;

    const body       = Math.abs(last.close - last.open);
    const range      = last.high - last.low;
    const upperWick  = last.high - Math.max(last.open, last.close);
    const lowerWick  = Math.min(last.open, last.close) - last.low;
    const bullishBar = last.close > last.open;
    const bearishBar = last.close < last.open;

    // ── Pin Bar ─────────────────────────────────────────────────────────────
    // Long tail into zone with small body
    if (range > 0) {
      const wickRatio = isLong ? lowerWick / range : upperWick / range;
      const bodyRatio = body / range;
      if (wickRatio >= 0.55 && bodyRatio <= 0.35) {
        const isBullishPin = isLong && bullishBar;
        const isBearishPin = !isLong && bearishBar;
        if (isBullishPin || isBearishPin) {
          return { pattern: "pin_bar", strength: "strong", confirmed: true };
        }
        // Opposite-colour pin still valid but moderate
        if (wickRatio >= 0.65) {
          return { pattern: "pin_bar", strength: "moderate", confirmed: true };
        }
      }
    }

    // ── Engulfing ───────────────────────────────────────────────────────────
    const prevBody = Math.abs(prev.close - prev.open);
    const prevBull = prev.close > prev.open;
    const engulfsBull = isLong  && bullishBar && !prevBull && last.open <= prev.close && last.close >= prev.open;
    const engulfsBear = !isLong && bearishBar && prevBull  && last.open >= prev.close && last.close <= prev.open;
    if ((engulfsBull || engulfsBear) && body >= prevBody * 1.1) {
      return { pattern: "engulfing", strength: body >= prevBody * 1.5 ? "strong" : "moderate", confirmed: true };
    }

    // ── Momentum (3-candle run) ──────────────────────────────────────────────
    if (recent.length >= 3) {
      const last3 = recent.slice(-3);
      const allBull = last3.every(c => c.close > c.open);
      const allBear = last3.every(c => c.close < c.open);
      if ((isLong && allBull) || (!isLong && allBear)) {
        // Confirm bodies are not shrinking (not a weakening push)
        const bodies = last3.map(c => Math.abs(c.close - c.open));
        const growing = bodies[2]! >= bodies[0]! * 0.7;
        return { pattern: "momentum", strength: growing ? "strong" : "moderate", confirmed: true };
      }
    }

    // ── Rejection wick (any candle with a wick back into zone) ──────────────
    if (range > 0) {
      const rejectionWick = isLong ? lowerWick / range : upperWick / range;
      if (rejectionWick >= 0.4 && zoneDist <= 4) {
        return { pattern: "rejection", strength: "moderate", confirmed: true };
      }
    }

    // ── SWEEP with any reversal-direction close ──────────────────────────────
    if (zoneStatus === "SWEEP") {
      const reversalClose = isLong ? last.close > last.open : last.close < last.open;
      if (reversalClose) {
        return { pattern: "rejection", strength: body > spread * 1.5 ? "moderate" : "weak", confirmed: true };
      }
    }

    // Candles available but no pattern confirmed
    return { pattern: "weak", strength: "weak", confirmed: false };
  }

  // ── Velocity fallback (no candle data) ───────────────────────────────────
  const ctx = getPriceContext();
  const spreadActive   = spread > 2.0;
  const spreadModerate = spread >= 1.0 && spread <= 2.0;
  const spreadQuiet    = spread < 1.0;
  const veryClose      = zoneDist <= 1.5;
  const closeToZone    = zoneDist <= 3.5;
  const velocityReverts = isLong ? ctx.velocity > 0.05 : ctx.velocity < -0.05;
  const strongMomentum  = Math.abs(ctx.velocity) > 0.15 && ctx.consistent;

  if (zoneStatus === "SWEEP") {
    if (spreadActive && veryClose && velocityReverts) return { pattern: "pin_bar",   strength: "strong",   confirmed: true };
    if ((spreadActive || spreadModerate) && closeToZone) return { pattern: "rejection", strength: "moderate", confirmed: true };
    return { pattern: "rejection", strength: "moderate", confirmed: true };
  }
  if (zoneStatus === "AT_LEVEL") {
    if (spreadActive && veryClose && velocityReverts)   return { pattern: "engulfing", strength: "strong",   confirmed: true };
    if (spreadActive && closeToZone && strongMomentum)  return { pattern: "momentum",  strength: "strong",   confirmed: true };
    if (spreadActive && closeToZone)                    return { pattern: "momentum",  strength: "moderate", confirmed: true };
    if (spreadModerate && closeToZone && velocityReverts) return { pattern: "pin_bar", strength: "moderate", confirmed: true };
    if (spreadModerate && closeToZone)                  return { pattern: "rejection", strength: "moderate", confirmed: true };
    if (spreadQuiet && veryClose && velocityReverts)    return { pattern: "pin_bar",   strength: "weak",     confirmed: true };
    return { pattern: "weak", strength: "weak", confirmed: false };
  }
  // ENTERING
  if (strongMomentum && closeToZone && velocityReverts) return { pattern: "momentum", strength: "strong",   confirmed: true };
  if (spreadActive && closeToZone)                      return { pattern: "momentum", strength: "strong",   confirmed: true };
  if (spreadModerate && closeToZone && velocityReverts) return { pattern: "momentum", strength: "moderate", confirmed: true };
  if (spreadModerate && closeToZone)                    return { pattern: "momentum", strength: "moderate", confirmed: true };
  if (spreadQuiet && closeToZone)                       return { pattern: "momentum", strength: "weak",     confirmed: true };
  return { pattern: "weak", strength: "weak", confirmed: false };
}

// ── Market Structure Analysis ────────────────────────────────────────────────
async function analyzeMarketStructure(
  priceData: { price: number; spread: number }
): Promise<{
  htfBias: "bullish" | "bearish" | "neutral";
  pullbackEnding: boolean;
  momentum: "strong" | "moderate" | "weak";
}> {
  const price = priceData.price;
  const spread = priceData.spread;

  const fiveMinCandles = await getRecentFiveMinuteCandles();
  const htfBias = get5mStructure(fiveMinCandles);
  const ctx = getPriceContext();

  // Nearest level distance
  let nearestDist = Infinity;
  for (const [, info] of Object.entries(LEVELS)) {
    const dist = Math.abs(price - info.price);
    if (dist < nearestDist) nearestDist = dist;
  }

  const pullbackEnding = ctx.tickCount >= 3 && ctx.consistent && nearestDist < 5;
  let momentum: "strong" | "moderate" | "weak" = "weak";
  if (Math.abs(ctx.velocity) > 0.2 && ctx.consistent) momentum = "strong";
  else if (Math.abs(ctx.velocity) > 0.08 || spread > 1.5) momentum = "moderate";

  return { htfBias, pullbackEnding, momentum };
}

export function getSessionInfo(): { session: string; priority: string; note: string } {
  const now = new Date();
  const hour = now.getUTCHours();
  const min = now.getUTCMinutes();
  
  // More precise session mapping (UTC)
  if (hour >= 0 && hour < 8)   return { session: "Asian Session",       priority: "LOW",    note: "Range-bound, watch Asian H/L sweeps" };
  if (hour >= 8 && hour < 12)  return { session: "London Open",          priority: "HIGH",   note: "High volatility, trend starts" };
  if (hour >= 12 && hour < 16) return { session: "London-NY Overlap",    priority: "BEST",   note: "Maximum liquidity, news events" };
  if (hour >= 16 && hour < 21) return { session: "NY Session",           priority: "HIGH",   note: "Momentum continuation" };
  return { session: "Dead Zone", priority: "LOW", note: "Low volume, avoid trading" };
}

export function isNewsSafe(): { safe: boolean; message: string } {
  const now  = new Date();
  const day  = now.getUTCDay(); // 0=Sun, 1=Mon, ..., 5=Fri, 6=Sat
  const hour = now.getUTCHours();
  const date = now.getUTCDate();

  // Weekend
  if (day === 0 || day === 6) return { safe: false, message: "Market Closed" };
  
  // Friday Close (Avoid holding over weekend)
  if (day === 5 && hour >= 20) return { safe: false, message: "Friday Market Close approaching" };

  // Hardcoded High-Impact Events (UTC)
  // FOMC (Usually Wed 18:00 or 19:00 UTC)
  if (day === 3 && hour >= 17 && hour <= 20) return { safe: false, message: "FOMC Window — Extreme Volatility" };
  
  // NFP (First Friday of month 12:30 or 13:30 UTC)
  if (day === 5 && date <= 7 && hour >= 12 && hour <= 15) return { safe: false, message: "NFP Window — NO TRADES" };
  
  // CPI / PPI (Mid-month 12:30 UTC)
  if (date >= 10 && date <= 16 && hour >= 12 && hour <= 14) return { safe: false, message: "Inflation Data Window — Caution" };
  
  return { safe: true, message: "No news events — safe to trade" };
}

// ── Telegram Sender ─────────────────────────────────────────────────────────
export async function sendTelegram(text: string, type: string = "signal"): Promise<boolean> {
  try {
    const resp = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: "HTML", disable_web_page_preview: true }),
    });
    const success = resp.status === 200;
    try {
      await db.insert(telegramLog).values({ type, content: text.substring(0, 4000), success });
    } catch (dbErr) {
      console.error("[Bot] Failed to log telegram message:", dbErr);
    }
    return success;
  } catch (e) {
    try {
      await db.insert(telegramLog).values({ type, content: `Error: ${e}`, success: false });
    } catch {}
    return false;
  }
}

// ── Fetch Price ─────────────────────────────────────────────────────────────
// Try all three sources in parallel; return the first successful result.
export async function fetchGoldData(): Promise<{ price: number; bid: number; ask: number; spread: number; source: string } | null> {
  type PriceData = { price: number; bid: number; ask: number; spread: number; source: string };

  const trySwissquote = async (): Promise<PriceData> => {
    const resp = await fetch(
      "https://forex-data-feed.swissquote.com/public-quotes/bboquotes/instrument/XAU/USD",
      { signal: AbortSignal.timeout(4000) }
    );
    if (resp.status !== 200) throw new Error("non-200");
    const j = await resp.json() as Array<{ spreadProfilePrices: Array<{ bid: string; ask: string }> }>;
    const profiles = j?.[0]?.spreadProfilePrices || [];
    if (!profiles.length) throw new Error("no profiles");
    const bid = parseFloat(profiles[0].bid);
    const ask = parseFloat(profiles[0].ask);
    if (!bid || !ask) throw new Error("bad prices");
    return { price: (bid + ask) / 2, bid, ask, spread: ask - bid, source: "Swissquote" };
  };

  const tryGoldprice = async (): Promise<PriceData> => {
    const resp = await fetch(
      "https://data-asg.goldprice.org/dbXRates/USD",
      { signal: AbortSignal.timeout(4000) }
    );
    if (resp.status !== 200) throw new Error("non-200");
    const j = await resp.json() as { items?: Array<{ xauPrice: string }> };
    const price = parseFloat(j?.items?.[0]?.xauPrice ?? "");
    if (!price) throw new Error("no price");
    return { price, bid: price, ask: price + 0.5, spread: 0.5, source: "goldprice.org" };
  };

  const tryFrankfurter = async (): Promise<PriceData> => {
    const resp = await fetch(
      "https://api.frankfurter.app/latest?from=XAU&to=USD",
      { signal: AbortSignal.timeout(4000) }
    );
    if (resp.status !== 200) throw new Error("non-200");
    const j = await resp.json() as { rates?: { USD?: number } };
    const price = parseFloat(String(j?.rates?.USD ?? ""));
    if (!price) throw new Error("no price");
    return { price, bid: price, ask: price + 0.5, spread: 0.5, source: "frankfurter" };
  };

  // Race all three — fastest successful one wins
  const result = await Promise.any([trySwissquote(), tryGoldprice(), tryFrankfurter()]).catch(() => null);
  if (result) {
    recordPriceTick(result.price, result.spread);
    return result;
  }
  return null;
}

// ── Format Messages ─────────────────────────────────────────────────────────
export function formatSignal(
  direction: string, zoneLabel: string, tier: string,
  entry: number, sl: number, slDist: number,
  tp1: number, tp2: number, tp3: number,
  currentPrice: number, session: string, priority: string,
  reason: string, status: string
): string {
  const isLong = direction.includes("LONG");
  const arrow = isLong ? "🟢" : "🔴";
  const action = isLong ? "BUY NOW" : "SELL NOW";
  const sessionShort = session.split(" ")[0];

  return `<b>🚨 ${arrow} XAU/USD — ${action}</b>
<b>Zone:</b> ${zoneLabel} (${status === "SWEEP" ? "Liquidity Sweep" : "At Level"})
<b>Entry:</b> $${entry.toFixed(2)} | <b>SL:</b> $${sl.toFixed(2)}
<b>TP1:</b> $${tp1.toFixed(2)} | <b>TP2:</b> $${tp2.toFixed(2)} | <b>TP3:</b> $${tp3.toFixed(2)}
<b>Session:</b> ${sessionShort} (${priority})`;
}

export function formatTPHit(trade: { direction: string; entry: number; tp1: number; tp2: number; tp3: number }, tpLevel: string, currentPrice: number): string {
  const arrow = trade.direction.includes("LONG") ? "🟢" : "🔴";
  const tpField = tpLevel.toLowerCase() as "tp1" | "tp2" | "tp3";
  const action = tpLevel === "TP1" ? "Close half, SL to BE" : tpLevel === "TP3" ? "🏆 TRADE COMPLETE" : "Let it run";
  return `<b>✅ ${tpLevel} HIT — $${currentPrice.toFixed(2)}</b>
${arrow} ${trade.direction} @ $${trade.entry.toFixed(2)}
${tpLevel}: $${trade[tpField].toFixed(2)}
${action}`;
}

export function formatSLHit(trade: { direction: string; entry: number }, currentPrice: number): string {
  return `<b>❌ SL HIT — $${currentPrice.toFixed(2)}</b>
🔴 ${trade.direction} @ $${trade.entry.toFixed(2)}
Wait for next A+ setup. Do NOT revenge trade.`;
}

// ── Trade Constraints ────────────────────────────────────────────────────────
async function getTradeConstraints(): Promise<{
  blockedDirections: Set<string>;
  blockedZoneKeys: Set<string>;
}> {
  const openTrades = await db
    .select()
    .from(activeTrades)
    .where(eq(activeTrades.closed, false));

  const directionCounts = new Map<string, number>();
  const blockedZoneKeys = new Set<string>();

  for (const trade of openTrades) {
    const dir = trade.direction.includes("LONG") ? "LONG" : "SHORT";
    directionCounts.set(dir, (directionCounts.get(dir) || 0) + 1);
    blockedZoneKeys.add(trade.zone);
  }

  const blockedDirections = new Set<string>();
  for (const [dir, count] of directionCounts.entries()) {
    if (count >= 2) blockedDirections.add(dir);
  }

  return { blockedDirections, blockedZoneKeys };
}

// ── Calculate TP/SL from zone level ─────────────────────────────────────────
// SL minimum 5.0 pts — gold spread alone can be 0.5-2 pts, so anything
// tighter than 5 pts gets taken out before price even moves.
function calculateLevels(
  direction: "LONG" | "SHORT",
  zonePrice: number,
  spread: number,
  recentCandles: OHLCCandle[] = []
): { entry: number; sl: number; slDistance: number; tp1: number; tp2: number; tp3: number } {
  // Dynamic ATR-based buffer from recent candle ranges
  let atrBuffer = 0;
  if (recentCandles.length >= 5) {
    const last5 = recentCandles.slice(-5);
    const avgRange = last5.reduce((a, c) => a + (c.high - c.low), 0) / last5.length;
    atrBuffer = avgRange * 0.6; // 60% of avg candle range
  }
  // Hard minimum: 5 pts. Covers worst-case gold spread + noise.
  const slBuffer = Math.max(spread * 3, atrBuffer, 5.0);
  const isLong = direction === "LONG";

  // Entry just inside the zone (don't chase — enter at zone edge)
  const entry = isLong ? zonePrice + spread * 0.2 : zonePrice - spread * 0.2;
  const sl = isLong ? zonePrice - slBuffer : zonePrice + slBuffer;
  const slDistance = Math.abs(entry - sl);

  // R:R 1.5/2.5/4.0 — quality setups only, let runners run
  const tp1 = isLong ? entry + slDistance * 1.5 : entry - slDistance * 1.5;
  const tp2 = isLong ? entry + slDistance * 2.5 : entry - slDistance * 2.5;
  const tp3 = isLong ? entry + slDistance * 4.0 : entry - slDistance * 4.0;

  return { entry, sl, slDistance, tp1, tp2, tp3 };
}

// ── Scan Zones ───────────────────────────────────────────────────────────────
// Only fires on AT_LEVEL and SWEEP — never on ENTERING.
// Emits at most ONE signal per scan (the closest, strongest setup).
// Signal goes directly to activeTrades for TP/SL monitoring — no confirmation step.
export async function scanZones(priceData: { price: number; bid: number; ask: number; spread: number; source: string }): Promise<ScanResult> {
  const price = priceData.price;
  const spread = priceData.spread;

  // Fix 4: Spread Cap (2.0 pts = 20 pips on Gold)
  if (spread > 2.0) {
    return { setupFound: false, count: 0, reason: `Spread too wide (${spread.toFixed(2)})` };
  }

  const { safe, message: newsMsg } = isNewsSafe();
  if (!safe) {
    console.log("[Bot] News blackout — skipping scan");
    return { setupFound: false, count: 0, reason: `News blackout — ${newsMsg}` };
  }

  await ensureLevelsRefreshed();
  const recentCandles = await getRecentMinuteCandles();
  const { blockedDirections, blockedZoneKeys } = await getTradeConstraints();
  const marketStructure = await analyzeMarketStructure(priceData);
  const { session, priority } = getSessionInfo();

  let cooldownRejected = 0;
  let constraintRejected = 0;
  let candleRejected = 0;

  // Collect qualified setups — ENTERING filtered out entirely
  type QualifiedZone = {
    key: string; label: string; tier: string; price: number;
    type: "LONG" | "SHORT"; dist: number; status: string;
    candle: CandleSignal;
  };
  const qualified: QualifiedZone[] = [];

  for (const [key, level] of Object.entries(LEVELS)) {
    const dist = Math.abs(price - level.price);
    const thresh = getZoneThreshold(level.tier);
    const isSupport = key.startsWith("s") && !key.startsWith("sh");
    const direction: "LONG" | "SHORT" = isSupport ? "LONG" : "SHORT";

    // Only fire when price is AT the level or sweeping through it
    let status: string | null = null;
    if (dist <= thresh.sweep)   status = "SWEEP";
    else if (dist <= thresh.atLevel) status = "AT_LEVEL";
    // ENTERING is intentionally skipped — those signals arrive before price
    // has confirmed anything and most of them get cancelled.

    if (!status) continue;

    if (isZoneOnCooldown(key) || await isZoneOnCooldownDB(key)) { cooldownRejected++; continue; }
    if (blockedZoneKeys.has(key)) { constraintRejected++; continue; }
    const dir = direction.includes("LONG") ? "LONG" : "SHORT";
    if (blockedDirections.has(dir)) { constraintRejected++; continue; }

    const candle = detectCandleSignal(price, spread, dist, status, direction, recentCandles);
    if (!candle.confirmed) { candleRejected++; continue; }

    // Fix 2: Skip weak candles during low-priority (Asian) session
    if (priority === "LOW" && candle.strength === "weak") { candleRejected++; continue; }

    qualified.push({ key, label: level.label, tier: level.tier, price: level.price, type: direction, dist, status, candle });
  }

  if (qualified.length === 0) {
    let reason = "No valid setup found";
    if (cooldownRejected > 0 && constraintRejected === 0 && candleRejected === 0) reason = "Zone recently signalled — cooldown active";
    else if (constraintRejected > 0 && candleRejected === 0) reason = "Existing trade active at zone";
    else if (candleRejected > 0) reason = "Candle not confirmed — waiting for stronger signal";
    return { setupFound: false, count: 0, reason };
  }

  // Pick single best: SWEEP > AT_LEVEL, then by distance, then by candle strength
  const strengthScore = (c: CandleSignal) => (c.strength === "strong" ? 3 : c.strength === "moderate" ? 2 : 1);
  const statusScore = (s: string) => {
    if (s === "SWEEP") return 3; // Priority 1: Liquidity Sweeps
    if (s === "AT_LEVEL") return 2;
    return 1;
  };
  
  qualified.sort((a, b) =>
    statusScore(b.status) - statusScore(a.status) ||
    strengthScore(b.candle) - strengthScore(a.candle) ||
    a.dist - b.dist
  );
  const zone = qualified[0]!;

  // Pure Price Action: Filter signals that oppose the 5m market structure
  const biasAligned =
    (zone.type === "LONG" && marketStructure.htfBias !== "bearish") ||
    (zone.type === "SHORT" && marketStructure.htfBias !== "bullish");

  if (!biasAligned && zone.status !== "SWEEP") {
    return { setupFound: false, count: 0, reason: `Counter-trend signal — 5m Structure (${marketStructure.htfBias}) opposes direction` };
  }

  // Special Logic: Asian High/Low Sweeps are A+ setups
  const isAsianSweep = zone.key.includes("asian") && zone.status === "SWEEP";
  const priorityScore = isAsianSweep ? "A+" : priority;

  const { entry, sl, slDistance, tp1, tp2, tp3 } = calculateLevels(zone.type, zone.price, spread, recentCandles);
  const fullReason = zone.status === "SWEEP"
    ? `Liquidity sweep at ${zone.label} — ${zone.candle.pattern} reversal (${zone.candle.strength})`
    : `Price AT ${zone.label} — ${zone.candle.pattern} signal (${zone.candle.strength})`;

  markZoneCooldown(zone.key);

  // Log to signals table
  try {
    await db.insert(signals).values({
      direction: zone.type, zoneLabel: zone.label, zoneTier: zone.tier,
      entry, sl, slDistance, tp1, tp2, tp3,
      currentPrice: price, session, priority: priorityScore,
      reason: fullReason, status: zone.status as "ENTERING" | "AT_LEVEL" | "SWEEP", zoneKey: zone.key,
    });
  } catch (err) { console.error("[Bot] signals insert error:", err); }

  // Log directly to activeTrades — no confirmation step
  try {
    const tradeId = `trade_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    await db.insert(activeTrades).values({
      tradeId, direction: zone.type, zone: zone.label, zoneTier: zone.tier,
      entry, sl, slDistance, tp1, tp2, tp3,
    });
  } catch (err) { console.error("[Bot] activeTrades insert error:", err); }

  const msg = formatSignal(zone.type, zone.label, zone.tier, entry, sl, slDistance, tp1, tp2, tp3, price, session, priorityScore, fullReason, zone.status);
  await sendTelegram(msg, "signal");

  return { setupFound: true, count: 1, reason: fullReason };
}

// ── Track Active Trades ─────────────────────────────────────────────────────
export async function trackActiveTrades(price: number) {
  try {
    const trades = await db.select().from(activeTrades).where(eq(activeTrades.closed, false));

    for (const trade of trades) {
      const isLong = trade.direction.includes("LONG");

      if (!trade.tp1Hit) {
        const tp1Reached = isLong ? price >= trade.tp1 : price <= trade.tp1;
        if (tp1Reached) {
          await db.update(activeTrades).set({ tp1Hit: true, tp1HitAt: new Date() }).where(eq(activeTrades.id, trade.id));
          await sendTelegram(formatTPHit(trade, "TP1", price), "tp_hit");
        }
      }

      if (trade.tp1Hit && !trade.tp2Hit) {
        const tp2Reached = isLong ? price >= trade.tp2 : price <= trade.tp2;
        if (tp2Reached) {
          await db.update(activeTrades).set({ tp2Hit: true, tp2HitAt: new Date() }).where(eq(activeTrades.id, trade.id));
          await sendTelegram(formatTPHit(trade, "TP2", price), "tp_hit");
        }
      }

      if (trade.tp1Hit && !trade.tp3Hit) {
        const tp3Reached = isLong ? price >= trade.tp3 : price <= trade.tp3;
        if (tp3Reached) {
          await db.update(activeTrades).set({ tp3Hit: true, tp3HitAt: new Date(), closed: true }).where(eq(activeTrades.id, trade.id));
          await sendTelegram(formatTPHit(trade, "TP3", price), "tp_hit");
          continue;
        }
      }

      if (!trade.slHit) {
        const slReached = isLong ? price <= trade.sl : price >= trade.sl;
        if (slReached) {
          await db.update(activeTrades).set({ slHit: true, slHitAt: new Date(), closed: true }).where(eq(activeTrades.id, trade.id));
          await sendTelegram(formatSLHit(trade, price), "sl_hit");
        }
      }
    }
  } catch (err) {
    console.error("[Bot] trackActiveTrades error:", err);
  }
}

// ── Expire Stale Setups ──────────────────────────────────────────────────────
const SETUP_MAX_AGE_MS = 30 * 60 * 1000; // 30 minutes

export async function expireStaleSetups(price: number) {
  try {
    const setups = await db.select().from(activeSetups);
    for (const setup of setups) {
      const isLong = setup.direction.includes("LONG");
      const ageMs = Date.now() - new Date(setup.detectedAt).getTime();

      // Cancel if SL level breached before the user confirmed entry
      const slBreached = isLong ? price <= setup.sl : price >= setup.sl;
      // Cancel if setup is older than 30 minutes
      const tooOld = ageMs > SETUP_MAX_AGE_MS;

      if (slBreached || tooOld) {
        await db.delete(activeSetups).where(eq(activeSetups.id, setup.id));
        const reason = slBreached
          ? `SL level $${setup.sl.toFixed(2)} breached before entry`
          : "Setup expired (30 min timeout)";
        const arrow = isLong ? "🟢" : "🔴";
        await sendTelegram(
          `<b>⚠️ SETUP CANCELLED</b>\n${arrow} ${setup.direction} @ $${setup.entry.toFixed(2)}\nZone: ${setup.zoneLabel}\nReason: ${reason}`,
          "setup_cancelled"
        );
        console.log(`[Bot] Setup #${setup.id} cancelled — ${reason}`);
      }
    }
  } catch (err) {
    console.error("[Bot] expireStaleSetups error:", err);
  }
}

// ── FVG Detection (5-minute candles, London/NY session only) ─────────────────
interface FVG {
  high: number;
  low: number;
  direction: "LONG" | "SHORT";
  formTime: number;
  /** Extreme of the candle that created (anchored) the FVG — structural invalidation level.
   *  Bullish FVG → c1.low  (below here the gap is fully invalidated)
   *  Bearish FVG → c1.high (above here the gap is fully invalidated) */
  invalidationExtreme: number;
}

const fvgCache: { fvgs: FVG[]; fetchedAt: number } = { fvgs: [], fetchedAt: 0 };
const FVG_CACHE_TTL = 2 * 60 * 1000; // refresh every 2 minutes

function isLondonOrNYSession(): boolean {
  const hour = new Date().getUTCHours();
  // London Open 08-12, London-NY overlap 13-16, NY session 16-20
  return (hour >= 8 && hour < 12) || (hour >= 13 && hour < 20);
}

function detectFVGs(candles: OHLCCandle[]): FVG[] {
  const fvgs: FVG[] = [];
  // FVG = 3-candle pattern: gap between candle[i] and candle[i+2]
  for (let i = 0; i < candles.length - 2; i++) {
    const c1 = candles[i]!;
    const c3 = candles[i + 2]!;
    // Bullish FVG: c3.low > c1.high — upward imbalance, expect bullish retrace entry
    // Invalidation extreme = c1.low (the wick that anchored the bottom of the gap)
    if (c3.low > c1.high) {
      fvgs.push({ high: c3.low, low: c1.high, direction: "LONG", formTime: c3.time, invalidationExtreme: c1.low });
    }
    // Bearish FVG: c1.low > c3.high — downward imbalance, expect bearish retrace entry
    // Invalidation extreme = c1.high (the wick that anchored the top of the gap)
    if (c1.low > c3.high) {
      fvgs.push({ high: c1.low, low: c3.high, direction: "SHORT", formTime: c3.time, invalidationExtreme: c1.high });
    }
  }
  // Keep only gaps formed within the last 4 hours
  const cutoff = Date.now() - 4 * 60 * 60 * 1000;
  return fvgs.filter(f => f.formTime > cutoff);
}

export async function scanFVGs(
  priceData: { price: number; spread: number }
): Promise<ScanResult> {
  const spread = priceData.spread;
  if (spread > 2.0) {
    return { setupFound: false, count: 0, reason: "FVG: spread too wide" };
  }

  if (!isLondonOrNYSession()) {
    return { setupFound: false, count: 0, reason: "FVG: outside London/NY session" };
  }

  const { safe, message: newsMsg } = isNewsSafe();
  if (!safe) return { setupFound: false, count: 0, reason: `FVG: news blackout — ${newsMsg}` };

  // Refresh 5m candle cache
  try {
    const now = Date.now();
    if (now - fvgCache.fetchedAt > FVG_CACHE_TTL) {
      const candles5m = await fetchTwelveDataOHLC("5min", 100);
      fvgCache.fvgs = detectFVGs(candles5m);
      fvgCache.fetchedAt = now;
    }
  } catch (e) {
    console.error("[FVG] Failed to fetch 5m candles:", e);
    return { setupFound: false, count: 0, reason: "FVG: candle fetch failed" };
  }

  const price = priceData.price;
  const { session, priority } = getSessionInfo();
  let count = 0;

  for (const fvg of fvgCache.fvgs) {
    // Signal fires when price retraces into the gap zone
    const inGap = price >= fvg.low && price <= fvg.high;
    if (!inGap) continue;

    // Minimum gap size filter — tiny gaps give no room and get spread out instantly
    const gapSize = fvg.high - fvg.low;
    if (gapSize < 1.5) continue;

    const zoneKey = `fvg_${fvg.direction}_${fvg.formTime}`;
    if (isZoneOnCooldown(zoneKey) || await isZoneOnCooldownDB(zoneKey)) continue;

    // SL at the structural invalidation extreme of the candle that created the FVG
    // (c1.low for bullish, c1.high for bearish) — if that level breaks, the FVG is dead.
    // Add a small spread buffer so we're not sitting exactly on the wick tip.
    // Hard minimum of 5 pts still applies as a sanity check against tiny candles.
    const spreadBuffer = spread * 1.5;

    let entry: number, sl: number, tp1: number, tp2: number, tp3: number;
    if (fvg.direction === "LONG") {
      entry = fvg.low + spread * 0.2;
      sl = Math.min(fvg.invalidationExtreme - spreadBuffer, entry - 5.0);
      const slDist = entry - sl;
      tp1 = entry + slDist * 1.5;
      tp2 = entry + slDist * 2.5;
      tp3 = entry + slDist * 4.0;
    } else {
      entry = fvg.high - spread * 0.2;
      sl = Math.max(fvg.invalidationExtreme + spreadBuffer, entry + 5.0);
      const slDist = sl - entry;
      tp1 = entry - slDist * 1.5;
      tp2 = entry - slDist * 2.5;
      tp3 = entry - slDist * 4.0;
    }

    markZoneCooldown(zoneKey);
    count++;

    const arrow = fvg.direction === "LONG" ? "🟢" : "🔴";
    const action = fvg.direction === "LONG" ? "BUY NOW" : "SELL NOW";
    const msg = `<b>🚨 ${arrow} XAU/USD — ${action}</b>
<b>Zone:</b> FVG Imbalance $${fvg.low.toFixed(2)}–$${fvg.high.toFixed(2)} (${gapSize.toFixed(2)} pts)
<b>Entry:</b> $${entry.toFixed(2)} | <b>SL:</b> $${sl.toFixed(2)}
<b>TP1:</b> $${tp1.toFixed(2)} | <b>TP2:</b> $${tp2.toFixed(2)} | <b>TP3:</b> $${tp3.toFixed(2)}
<b>Session:</b> ${session} (${priority})`;

    await sendTelegram(msg, "fvg_signal");

    // Log to signals table
    try {
      await db.insert(signals).values({
        direction: fvg.direction, zoneLabel: `FVG ${fvg.direction} 5m`, zoneTier: "key",
        entry, sl, slDistance: Math.abs(entry - sl), tp1, tp2, tp3,
        currentPrice: price, session, priority,
        reason: `5m FVG retrace $${fvg.low.toFixed(2)}–$${fvg.high.toFixed(2)}`,
        status: "AT_LEVEL", zoneKey,
      });
    } catch (err) { console.error("[FVG] signals insert error:", err); }

    // Log directly to activeTrades
    try {
      const tradeId = `fvg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      await db.insert(activeTrades).values({
        tradeId, direction: fvg.direction, zone: `FVG ${fvg.direction}`, zoneTier: "key",
        entry, sl, slDistance: Math.abs(entry - sl), tp1, tp2, tp3,
      });
    } catch (err) { console.error("[FVG] activeTrades insert error:", err); }
  }

  return count > 0
    ? { setupFound: true, count, reason: `${count} FVG retrace signal(s)` }
    : { setupFound: false, count: 0, reason: "FVG: no price retrace into active gaps" };
}

// ── Telegram Command Handler ────────────────────────────────────────────────
let lastUpdateId = 0;

export async function handleTelegramUpdates() {
  try {
    const resp = await fetch(
      `https://api.telegram.org/bot${TOKEN}/getUpdates?offset=${lastUpdateId + 1}&timeout=1`,
      { signal: AbortSignal.timeout(10000) }
    );
    if (resp.status !== 200) return;
    const data = await resp.json() as { result?: Array<{ update_id: number; message?: { chat?: { id: number }; text?: string } }> };
    const updates = data.result || [];

    for (const update of updates) {
      lastUpdateId = update.update_id;
      const msg = update.message || {};
      const chatId = msg.chat?.id;
      const text = (msg.text || "").trim().toUpperCase();

      if (String(chatId) !== String(CHAT_ID)) continue;

      const cmdMatch = text.match(/^IN(\s+(\d+))?$/);
      if (cmdMatch) {
        const index = cmdMatch[2] ? parseInt(cmdMatch[2]) - 1 : null;
        await handleConfirmedCommand(index);
        continue;
      }
      if (text === "ALIVE") {
        await handleAliveCommand();
        continue;
      }
      if (text === "STATUS") {
        await handleStatusCommand();
        continue;
      }
      if (text === "CLOSE ALL") {
        await handleCloseAllCommand();
        continue;
      }
    }
  } catch (err) {
    console.error("[Bot] handleTelegramUpdates error:", err);
  }
}

async function handleAliveCommand() {
  const data = await fetchGoldData();
  const price = data?.price || 0;
  const { session, priority } = getSessionInfo();
  const { safe, message: newsMsg } = isNewsSafe();
  const openTrades = await db.select().from(activeTrades).where(eq(activeTrades.closed, false));
  const msg = `<b>✅ Bot Alive</b>
XAU/USD: $${price.toFixed(2)}
Session: ${session} (${priority})
News: ${safe ? "✅ Safe" : "⚠️ " + newsMsg}
Open Trades: ${openTrades.length}
Time: ${new Date().toISOString()}`;
  await sendTelegram(msg, "alive");
}

async function handleStatusCommand() {
  const openTrades = await db.select().from(activeTrades).where(eq(activeTrades.closed, false));
  const data = await fetchGoldData();
  const price = data?.price || 0;

  if (openTrades.length === 0) {
    await sendTelegram(`<b>📊 Status</b>\nNo active trades\nXAU/USD: $${price.toFixed(2)}`, "status");
    return;
  }

  let statusMsg = `<b>📊 Active Trades (${openTrades.length})</b>\nXAU/USD: $${price.toFixed(2)}\n`;
  for (const trade of openTrades) {
    const isLong = trade.direction.includes("LONG");
    const arrow = isLong ? "🟢" : "🔴";
    const pnl = isLong ? price - trade.entry : trade.entry - price;
    statusMsg += `\n${arrow} ${trade.direction} @ $${trade.entry.toFixed(2)} | P&L: ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}`;
    if (trade.tp1Hit) statusMsg += " ✅TP1";
    if (trade.tp2Hit) statusMsg += " ✅TP2";
  }
  await sendTelegram(statusMsg, "status");
}

async function handleCloseAllCommand() {
  const openTrades = await db.select().from(activeTrades).where(eq(activeTrades.closed, false));
  if (openTrades.length === 0) {
    await sendTelegram("No active trades to close.", "close_all");
    return;
  }
  await db.update(activeTrades).set({ closed: true }).where(eq(activeTrades.closed, false));
  await sendTelegram(`<b>🔴 Manually closed ${openTrades.length} trade(s)</b>\nAll positions marked closed.`, "close_all");
}

async function handleConfirmedCommand(index: number | null) {
  const setups = await db.select().from(activeSetups).orderBy(desc(activeSetups.detectedAt));

  if (setups.length === 0) {
    await sendTelegram("No pending setups to confirm.", "confirmed");
    return;
  }

  const setupToConfirm = index !== null ? setups[index] : setups[0];
  if (!setupToConfirm) {
    await sendTelegram(`No setup at position ${(index ?? 0) + 1}.`, "confirmed");
    return;
  }

  await confirmSetup(setupToConfirm.id);
}

async function confirmSetup(setupId: number) {
  const [setup] = await db.select().from(activeSetups).where(eq(activeSetups.id, setupId)).limit(1);
  if (!setup) return;

  const tradeId = `trade_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

  await db.insert(activeTrades).values({
    tradeId,
    direction: setup.direction,
    zone: setup.zoneLabel,
    zoneTier: setup.zoneTier,
    entry: setup.entry,
    sl: setup.sl,
    slDistance: setup.slDistance,
    tp1: setup.tp1,
    tp2: setup.tp2,
    tp3: setup.tp3,
  });

  await db.delete(activeSetups).where(eq(activeSetups.id, setupId));

  const arrow = setup.direction.includes("LONG") ? "🟢" : "🔴";
  const msg = `<b>✅ TRADE CONFIRMED — Monitoring Active</b>
${arrow} ${setup.direction} @ $${setup.entry.toFixed(2)}
Zone: ${setup.zoneLabel}
SL: $${setup.sl.toFixed(2)} | TP1: $${setup.tp1.toFixed(2)} | TP2: $${setup.tp2.toFixed(2)} | TP3: $${setup.tp3.toFixed(2)}
I will alert you when TP/SL is hit.`;

  await sendTelegram(msg, "confirmed");
}

// ── Auto-Scan Loop (3-minute interval) ─────────────────────────────────────
// 3 min catches setups before price moves away. Cooldowns prevent duplicates.
let autoScanInterval: ReturnType<typeof setInterval> | null = null;
const AUTO_SCAN_INTERVAL_MS = 3 * 60 * 1000; // 3 minutes

export function startAutoScan() {
  if (autoScanInterval) return;
  console.log("[Bot] Starting auto-scan loop (15-minute interval)");

  // Run an immediate scan on startup
  (async () => {
    try {
      const priceData = await fetchGoldData();
      if (priceData) {
        await scanZones(priceData);
        await scanFVGs(priceData);
      }
    } catch (e) {
      console.error("[Bot] Auto-scan startup error:", e);
    }
  })();

  autoScanInterval = setInterval(async () => {
    try {
      const priceData = await fetchGoldData();
      if (priceData) {
        await scanZones(priceData);
        await scanFVGs(priceData);
      }
    } catch (e) {
      console.error("[Bot] Auto-scan error:", e);
    }
  }, AUTO_SCAN_INTERVAL_MS);
}

export function stopAutoScan() {
  if (autoScanInterval) {
    clearInterval(autoScanInterval);
    autoScanInterval = null;
    console.log("[Bot] Stopped auto-scan loop");
  }
}

// ── Fast Trade Monitoring Loop ──────────────────────────────────────────────
let tradeMonitorInterval: ReturnType<typeof setInterval> | null = null;

export function startTradeMonitoring() {
  if (tradeMonitorInterval) return;
  console.log("[Bot] Starting fast trade monitor (5s interval)");
  tradeMonitorInterval = setInterval(async () => {
    try {
      const priceData = await fetchGoldData();
      if (priceData) {
        await trackActiveTrades(priceData.price);
        // expireStaleSetups removed — signals now go directly to activeTrades,
        // so there are no pending setups that can send confusing "CANCELLED" messages.
      }
    } catch (e) {
      console.log("[Bot] Trade monitor error:", e);
    }
  }, 5000);
}

export function stopTradeMonitoring() {
  if (tradeMonitorInterval) {
    clearInterval(tradeMonitorInterval);
    tradeMonitorInterval = null;
    console.log("[Bot] Stopped fast trade monitor");
  }
}

// ── Telegram Polling Loop ────────────────────────────────────────────────────
let pollingInterval: ReturnType<typeof setInterval> | null = null;

export function startTelegramPolling() {
  if (pollingInterval) return;
  console.log("[Bot] Starting Telegram polling loop (30s interval)");
  pollingInterval = setInterval(async () => {
    await handleTelegramUpdates();
  }, POLL_INTERVAL);
}

export function stopTelegramPolling() {
  if (pollingInterval) {
    clearInterval(pollingInterval);
    pollingInterval = null;
    console.log("[Bot] Stopped Telegram polling loop");
  }
}
