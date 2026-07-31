import { db } from "@workspace/db";
import { signals, activeSetups, activeTrades, telegramLog } from "@workspace/db";
import { eq, and, desc, gte } from "drizzle-orm";
import {
  getRegimeParams,
  type RegimeParams,
  type MarketRegime,
  scaleThreshold,
  dynamicSLFloor,
  dynamicSpreadMax,
  dynamicRRTargets,
  dynamicVelocityThresholds,
  dynamicSpreadBands,
  getTrendBias,
  checkSignalTrend,
  type TrendFilterResult,
  type TrendBias,
} from "./regime";
import type { OHLCCandle } from "./regime";

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
const ZONE_COOLDOWN_MS = 35 * 60 * 1000; // 35 minutes — prevents rapid-fire re-entries after SL hit

// ── Zone win-rate tracker (in-memory, survives via DB on restart) ────────────
interface ZoneStats {
  wins: number;
  losses: number;
  lastUpdated: number;
}
const zoneWinRate = new Map<string, ZoneStats>();
const ZONE_STATS_REFRESH_INTERVAL = 15 * 60 * 1000; // refresh from DB every 15 min
let lastZoneStatsRefresh = 0;
const breachNotifiedSetups = new Set<number>();

async function refreshZoneWinRate(): Promise<void> {
  try {
    const trades = await db.select().from(activeTrades).where(eq(activeTrades.closed, true));
    const stats = new Map<string, { wins: number; losses: number }>();
    for (const t of trades) {
      const key = t.zone;
      if (!stats.has(key)) stats.set(key, { wins: 0, losses: 0 });
      const s = stats.get(key)!;
      // Win = TP1 hit (minimum profitable outcome)
      if (t.tp1Hit) s.wins++;
      if (t.slHit) s.losses++;
    }
    for (const [key, s] of stats) {
      zoneWinRate.set(key, { wins: s.wins, losses: s.losses, lastUpdated: Date.now() });
    }
    lastZoneStatsRefresh = Date.now();
    // Log top 5 zones by win rate
    const sorted = Array.from(stats.entries())
      .filter(([, s]) => s.wins + s.losses >= 2)
      .map(([k, s]) => ({ key: k, wr: s.wins / (s.wins + s.losses), total: s.wins + s.losses }))
      .sort((a, b) => b.wr - a.wr)
      .slice(0, 5);
    if (sorted.length > 0) {
      console.log('[Bot] Zone win rates:', sorted.map(s => `${s.key}: ${s.wr.toFixed(2)} (${s.total} trades)`).join(' | '));
    }
  } catch (err) {
    console.error('[Bot] Failed to refresh zone win rates:', err);
  }
}

function getZoneWinRate(key: string): number {
  const stats = zoneWinRate.get(key);
  if (!stats) return 0.5; // neutral for unknown zones
  const total = stats.wins + stats.losses;
  if (total < 2) return 0.5; // not enough data
  return stats.wins / total;
}

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
    const [dailyCandles, hourlyCandles, fifteenMinCandles, fiveMinCandles] = await Promise.allSettled([
      fetchTwelveDataOHLC("1day", 5),
      fetchTwelveDataOHLC("1h", 120),
      fetchTwelveDataOHLC("15min", 150),
      fetchTwelveDataOHLC("5min", 300),
    ]);

    const daily = dailyCandles.status === "fulfilled" ? dailyCandles.value : [];
    const hourly = hourlyCandles.status === "fulfilled" ? hourlyCandles.value : [];
    const fifteenMin = fifteenMinCandles.status === "fulfilled" ? fifteenMinCandles.value : [];
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

    const newLevels: Record<string, { price: number; label: string; tier: string }> = {};

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

    // Detect swing highs/lows from 15m data (3-bar pivot rule)
    if (fifteenMin.length >= 7) {
      const lookback = 3;
      const swingHighs15m: number[] = [];
      const swingLows15m: number[]  = [];

      for (let i = lookback; i < fifteenMin.length - lookback; i++) {
        const c = fifteenMin[i]!;
        const leftH  = fifteenMin.slice(i - lookback, i);
        const rightH = fifteenMin.slice(i + 1, i + lookback + 1);
        if (leftH.every(x => x.high <= c.high) && rightH.every(x => x.high <= c.high)) {
          swingHighs15m.push(c.high);
        }
        if (leftH.every(x => x.low >= c.low) && rightH.every(x => x.low >= c.low)) {
          swingLows15m.push(c.low);
        }
      }

      const dedup = (arr: number[]): number[] =>
        arr.filter((v, i, a) => !a.slice(0, i).some(u => Math.abs(u - v) < 2));

      dedup(swingHighs15m).slice(-3).forEach((h, i) => {
        newLevels[`sh15m_${i + 1}`] = {
          price: round2(h),
          label: `15m Swing High ${i + 1}`,
          tier: "key",
        };
      });
      dedup(swingLows15m).slice(-3).forEach((l, i) => {
        newLevels[`sl15m_${i + 1}`] = {
          price: round2(l),
          label: `15m Swing Low ${i + 1}`,
          tier: "key",
        };
      });
    }

    // Previous Hour High/Low
    if (hourly.length >= 2) {
      const prevHour = hourly[hourly.length - 2]!;
      newLevels["phh"] = { price: round2(prevHour.high), label: "Prev Hour High", tier: "key" };
      newLevels["phl"] = { price: round2(prevHour.low),  label: "Prev Hour Low",  tier: "key" };
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

// ── DYNAMIC Zone Thresholds (regime-aware) ──────────────────────────────────
// Original hardcoded: major={entering:10, atLevel:3, sweep:1.5}
// Now scales with regime ATR — ranging zones are tighter, trending wider.

function getZoneThreshold(tier: string, regime: RegimeParams): { entering: number; atLevel: number; sweep: number } {
  // Base thresholds (original hardcoded values)
  const base: Record<string, { entering: number; atLevel: number; sweep: number }> = {
    major: { entering: 10.0, atLevel: 3.0, sweep: 1.5 },
    key:   { entering: 8.0,  atLevel: 2.5, sweep: 1.2 },
  };
  const def = base[tier] ?? { entering: 6.0, atLevel: 2.0, sweep: 1.0 };

  // Scale thresholds proportionally to regime
  return {
    entering:  scaleThreshold(def.entering, regime),
    atLevel:   scaleThreshold(def.atLevel, regime),
    sweep:     scaleThreshold(def.sweep, regime),
  };
}

// ── 5m Structure Detection (unchanged logic) ────────────────────────────────
function get5mStructure(candles: OHLCCandle[]): "bullish" | "bearish" | "neutral" {
  if (candles.length < 10) return "neutral";

  const recent = candles.slice(-20);
  const highs = recent.map(c => c.high);
  const lows = recent.map(c => c.low);

  const lastHigh = Math.max(...highs.slice(-10, -2));
  const lastLow = Math.min(...lows.slice(-10, -2));

  const currentHigh = Math.max(...highs.slice(-2));
  const currentLow = Math.min(...lows.slice(-2));

  if (currentHigh > lastHigh) return "bullish";
  if (currentLow < lastLow) return "bearish";

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
  candles: OHLCCandle[] = [],
  regime: RegimeParams
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
      // Dynamic rejection distance: scales with ATR
      const dynamicRejectDist = scaleThreshold(4.0, regime);
      if (rejectionWick >= 0.4 && zoneDist <= dynamicRejectDist) {
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

  // ── Velocity fallback (no candle data) — DYNAMIC thresholds ─────────────
  const ctx = getPriceContext();
  const bands = dynamicSpreadBands(regime);
  const velThresh = dynamicVelocityThresholds(regime);

  const spreadActive   = spread > bands.active;
  const spreadModerate = spread >= bands.moderateMin && spread <= bands.active;
  const spreadQuiet    = spread < bands.moderateMin;
  const veryClose      = zoneDist <= scaleThreshold(1.5, regime);
  const closeToZone    = zoneDist <= scaleThreshold(3.5, regime);
  const velocityReverts = isLong ? ctx.velocity > velThresh.revertMin : ctx.velocity < -velThresh.revertMin;
  const strongMomentum  = Math.abs(ctx.velocity) > velThresh.strongMomentum && ctx.consistent;

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
  priceData: { price: number; spread: number },
  regime: RegimeParams
): Promise<{
  htfBias: "bullish" | "bearish" | "neutral";
  h1Bias: "bullish" | "bearish" | "neutral";
  pullbackEnding: boolean;
  momentum: "strong" | "moderate" | "weak";
}> {
  const price = priceData.price;
  const spread = priceData.spread;

  const [fiveMinCandles, hourlyCandles] = await Promise.all([
    getRecentFiveMinuteCandles(),
    fetchTwelveDataOHLC("1h", 20).catch(() => [])
  ]);

  const htfBias = get5mStructure(fiveMinCandles);
  const h1Bias = hourlyCandles.length >= 5 ? get5mStructure(hourlyCandles) : "neutral";
  const ctx = getPriceContext();

  // Nearest level distance
  let nearestDist = Infinity;
  for (const [, info] of Object.entries(LEVELS)) {
    const dist = Math.abs(price - info.price);
    if (dist < nearestDist) nearestDist = dist;
  }

  // Dynamic pullback ending threshold
  const dynamicNearest = scaleThreshold(5.0, regime);
  const pullbackEnding = ctx.tickCount >= 3 && ctx.consistent && nearestDist < dynamicNearest;
  let momentum: "strong" | "moderate" | "weak" = "weak";
  const velThresh = dynamicVelocityThresholds(regime);
  if (Math.abs(ctx.velocity) > velThresh.strongMomentum && ctx.consistent) momentum = "strong";
  else if (Math.abs(ctx.velocity) > velThresh.revertMin || spread > dynamicSpreadMax(regime) * 0.75) momentum = "moderate";

  return { htfBias, h1Bias, pullbackEnding, momentum };
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
  reason: string, status: string, regime: string, regimeDesc: string,
  trend?: TrendFilterResult
): string {
  const isLong = direction.includes("LONG");
  const arrow = isLong ? "🟢" : "🔴";
  const action = isLong ? "BUY NOW" : "SELL NOW";
  const sessionShort = session.split(" ")[0];

  const trendLine = trend && trend.bias !== "neutral"
    ? `\n<b>Trend:</b> ${trend.bias.toUpperCase()} (${trend.description})`
    : "";

  return `<b>🚨 ${arrow} XAU/USD — ${action}</b>
<b>Zone:</b> ${zoneLabel} (${status === "SWEEP" ? "Liquidity Sweep" : "At Level"})
<b>Entry:</b> $${entry.toFixed(2)} | <b>SL:</b> $${sl.toFixed(2)}
<b>TP1:</b> $${tp1.toFixed(2)} | <b>TP2:</b> $${tp2.toFixed(2)} | <b>TP3:</b> $${tp3.toFixed(2)}
<b>Session:</b> ${sessionShort} (${priority})
<b>Regime:</b> ${regime} — ${regimeDesc}${trendLine}`;
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

export function formatBEHit(trade: { direction: string; entry: number }, currentPrice: number): string {
  const arrow = trade.direction.includes("LONG") ? "🟢" : "🔴";
  return `<b>🛡️ BE HIT — $${currentPrice.toFixed(2)}</b>
${arrow} ${trade.direction} @ $${trade.entry.toFixed(2)}
Trade closed at Break-Even. Performance tracked.`;
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

// ── DYNAMIC Calculate TP/SL from zone level ─────────────────────────────────
// ALL parameters now regime-aware:
//   SL floor = ATR * regime_multiplier (not hardcoded 6/8/12)
//   ATR buffer = 60% of avg candle range (kept from original)
//   R:R targets scale with regime (ranging=tight, trending=wide)
function calculateLevels(
  direction: "LONG" | "SHORT",
  zonePrice: number,
  spread: number,
  zoneKey: string,
  recentCandles: OHLCCandle[] = [],
  regime: RegimeParams
): { entry: number; sl: number; slDistance: number; tp1: number; tp2: number; tp3: number } {
  // Dynamic ATR-based buffer from recent candle ranges (kept from original)
  let atrBuffer = 0;
  if (recentCandles.length >= 5) {
    const last5 = recentCandles.slice(-5);
    const avgRange = last5.reduce((a, c) => a + (c.high - c.low), 0) / last5.length;
    atrBuffer = avgRange * 0.6; // 60% of avg candle range
  }

  // DYNAMIC SL floor — replaces hardcoded 6/8/12
  const slMin = dynamicSLFloor(regime, zoneKey);

  const slBuffer = Math.max(spread * 4, atrBuffer, slMin);
  const isLong = direction === "LONG";

  // Entry Offset: 0.5 pts buffer to avoid entering at the exact tip of a sweep
  const entryOffset = 0.5;
  const entry = isLong ? zonePrice + entryOffset : zonePrice - entryOffset;
  const sl = isLong ? zonePrice - slBuffer : zonePrice + slBuffer;
  const slDistance = Math.abs(entry - sl);

  // DYNAMIC R:R targets — scales with regime
  const rr = dynamicRRTargets(regime);
  const tp1 = isLong ? entry + slDistance * rr.tp1 : entry - slDistance * rr.tp1;
  const tp2 = isLong ? entry + slDistance * rr.tp2 : entry - slDistance * rr.tp2;
  const tp3 = isLong ? entry + slDistance * rr.tp3 : entry - slDistance * rr.tp3;

  return { entry, sl, slDistance, tp1, tp2, tp3 };
}

// ── Scan Zones ───────────────────────────────────────────────────────────────
// Only fires on AT_LEVEL and SWEEP — never on ENTERING.
// Emits at most ONE signal per scan (the closest, strongest setup).
// Signal goes directly to activeSetups for TP/SL monitoring — no confirmation step.
export async function scanZones(priceData: { price: number; bid: number; ask: number; spread: number; source: string }): Promise<ScanResult> {
  const price = priceData.price;
  const spread = priceData.spread;

  // Fetch candles to compute regime and trend
  const recentCandles = await getRecentFiveMinuteCandles();
  const fifteenMinCandles = await fetchTwelveDataOHLC("15min", 100).catch(() => []);
  const hourlyCandles = await fetchTwelveDataOHLC("1h", 120).catch(() => []);

  // DYNAMIC: Compute regime params
  const regime = getRegimeParams(recentCandles, hourlyCandles);

  // DYNAMIC: Spread cap scales with regime
  const maxSpread = dynamicSpreadMax(regime);
  if (spread > maxSpread) {
    return { setupFound: false, count: 0, reason: `Spread too wide (${spread.toFixed(2)}) — regime max ${maxSpread.toFixed(2)}` };
  }

  // DYNAMIC: Choppy/no-trade regime blocks all signals
  if (regime.noTrade) {
    console.log("[Bot] Regime no-trade — choppy market with low volatility");
    return { setupFound: false, count: 0, reason: `No-trade regime — ${regime.description}` };
  }

  const { safe, message: newsMsg } = isNewsSafe();
  if (!safe) {
    console.log("[Bot] News blackout — skipping scan");
    return { setupFound: false, count: 0, reason: `News blackout — ${newsMsg}` };
  }

  await ensureLevelsRefreshed();
  // Refresh zone win-rate stats every 15 minutes
  if (Date.now() - lastZoneStatsRefresh > ZONE_STATS_REFRESH_INTERVAL) {
    await refreshZoneWinRate();
  }

  const { blockedDirections, blockedZoneKeys } = await getTradeConstraints();
  const marketStructure = await analyzeMarketStructure(priceData, regime);
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
    // DYNAMIC: Zone thresholds scale with regime
    const thresh = getZoneThreshold(level.tier, regime);
    let direction: "LONG" | "SHORT";
    if (key.startsWith("sh") || key.startsWith("asian_high") || key.startsWith("phh")) {
      direction = "SHORT";
    } else if (key.startsWith("sl") || key.startsWith("asian_low") || key.startsWith("phl")) {
      direction = "LONG";
    } else if (key.startsWith("s") && !key.startsWith("sh") && !key.startsWith("sl")) {
      direction = "LONG";
    } else if (key.startsWith("r")) {
      direction = "SHORT";
    } else {
      direction = price > level.price ? "LONG" : "SHORT";
    }

    // Skip broken levels
    if ((key.startsWith("sh") || key.startsWith("asian_high") || key.startsWith("phh")) && price > level.price) continue;
    if ((key.startsWith("sl") || key.startsWith("asian_low") || key.startsWith("phl")) && price < level.price) continue;

    // Only fire when price is AT the level or sweeping through it
    let status: string | null = null;
    if (dist <= thresh.sweep)   status = "SWEEP";
    else if (dist <= thresh.atLevel) status = "AT_LEVEL";

    if (!status) continue;

    if (isZoneOnCooldown(key) || await isZoneOnCooldownDB(key)) { cooldownRejected++; continue; }
    if (blockedZoneKeys.has(key)) { constraintRejected++; continue; }
    const dir = direction.includes("LONG") ? "LONG" : "SHORT";
    if (blockedDirections.has(dir)) { constraintRejected++; continue; }

    // DYNAMIC: Candle detection now regime-aware
    const candle = detectCandleSignal(price, spread, dist, status, direction, recentCandles, regime);
    if (!candle.confirmed) { candleRejected++; continue; }

    // Fix 2: Skip weak candles during low-priority (Asian) session
    if (priority === "LOW" && candle.strength === "weak") { candleRejected++; continue; }

    // Fix 7: Swing High/Low zones require SWEEP status + strong candle
    if ((key.startsWith("sh") || key.startsWith("sl")) && status !== "SWEEP") continue;
    if ((key.startsWith("sh") || key.startsWith("sl")) && candle.strength === "weak") continue;

    // Fix 5: Zone Win-Rate Filter — skip zones with < 35% win rate (need ≥3 trades)
    const wr = getZoneWinRate(key);
    const wrStats = zoneWinRate.get(key);
    if (wrStats && wrStats.wins + wrStats.losses >= 3 && wr < 0.35) {
      console.log(`[Bot] Skipping ${key} — win rate ${wr.toFixed(2)} (${wrStats.wins}W/${wrStats.losses}L)`);
      continue;
    }

    qualified.push({ key, label: level.label, tier: level.tier, price: level.price, type: direction, dist, status, candle });
  }

  if (qualified.length === 0) {
    let reason = "No valid setup found";
    if (cooldownRejected > 0 && constraintRejected === 0 && candleRejected === 0) reason = "Zone recently signalled — cooldown active";
    else if (constraintRejected > 0 && candleRejected === 0) reason = "Existing trade active at zone";
    else if (candleRejected > 0) reason = "Candle not confirmed — waiting for stronger signal";
    return { setupFound: false, count: 0, reason };
  }

  // ── Multi-Timeframe Trend Filter ──────────────────────────────────
  // Primary Filter: 15-minute trend for higher frequency
  const trend15m = getTrendBias(fifteenMinCandles, "15m", 10);
  // Secondary Filter: 1-hour trend for safety and priority
  const trend1h = getTrendBias(hourlyCandles, "1h", 10);

  // Confluence: Check if any qualified zone aligns with an active FVG
  const confluenceZones = qualified.map(z => {
    const hasFVG = fvgCache.fvgs.some(f =>
      f.direction === z.type &&
      ((z.type === "LONG" && Math.abs(z.price - f.low) < scaleThreshold(3.0, regime)) ||
       (z.type === "SHORT" && Math.abs(z.price - f.high) < scaleThreshold(3.0, regime)))
    );
    // Apply 15m trend filter per-zone: block counter-trend in strong trends
    const trendCheck15m = checkSignalTrend(z.type, trend15m);
    if (trendCheck15m === "blocked") return null; // Hard block by 15m trend
    
    const trendCheck1h = checkSignalTrend(z.type, trend1h);

    // Session-Specific Aggression:
    // London/NY: High Frequency (Take all 15m aligned trades)
    // Asia/Dead Zone: Conservative (A+ only: 15m + 1h aligned)
    const isLondonNY = session.includes("London") || session.includes("NY");
    if (!isLondonNY && trendCheck1h !== "aligned") {
      return null; // Block non-A+ setups outside London/NY
    }
    
    return { ...z, hasFVG, trendCheck15m, trendCheck1h };
  }).filter((z): z is NonNullable<typeof z> => z !== null);

  if (confluenceZones.length === 0 && qualified.length > 0) {
    return { setupFound: false, count: 0, reason: `All signals blocked by M15 trend filter (${trend15m.description})` };
  }

  // Pick single best: SWEEP > AT_LEVEL, then Confluence, then Trend alignment, then distance, then candle strength
  const strengthScore = (c: CandleSignal) => (c.strength === "strong" ? 3 : c.strength === "moderate" ? 2 : 1);
  const statusScore = (s: string) => {
    if (s === "SWEEP") return 3;
    if (s === "AT_LEVEL") return 2;
    return 1;
  };
  const trendScore = (t: string) => t === "aligned" ? 2 : 1;

  confluenceZones.sort((a, b) =>
    statusScore(b.status) - statusScore(a.status) ||
    trendScore((b as any).trendCheck15m || "aligned") - trendScore((a as any).trendCheck15m || "aligned") ||
    (b.hasFVG ? 1 : 0) - (a.hasFVG ? 1 : 0) ||
    strengthScore(b.candle) - strengthScore(a.candle) ||
    a.dist - b.dist
  );
  const zone = confluenceZones[0]!;

  // Scalper-Friendly Filter: Only hard-block if it opposes the immediate 5m structure.
  const biasAligned5m =
    (zone.type === "LONG" && marketStructure.htfBias !== "bearish") ||
    (zone.type === "SHORT" && marketStructure.htfBias !== "bullish");

  if (!biasAligned5m && zone.status !== "SWEEP") {
    return { setupFound: false, count: 0, reason: `Counter-trend signal — 5m Structure (${marketStructure.htfBias}) opposes direction` };
  }

  // Confluence & Trend Alignment check for A+ status
  const h1Aligned = (zone as any).trendCheck1h === "aligned";
  const m15Aligned = (zone as any).trendCheck15m === "aligned";

  const isAsianSweep = zone.key.includes("asian") && zone.status === "SWEEP";
  // A+ Score: M15 aligned AND (H1 aligned OR FVG confluence)
  const isAPlus = isAsianSweep || (m15Aligned && (h1Aligned || zone.hasFVG));
  const priorityScore = isAPlus ? "A+" : priority;
  
  const { entry, sl, slDistance, tp1, tp2, tp3 } = calculateLevels(zone.type, zone.price, spread, zone.key, recentCandles, regime);

  // Check if SL is already breached by current price
  const isLong = zone.type === "LONG";
  const slBreached = isLong ? price <= sl : price >= sl;

  const baseReason = zone.status === "SWEEP"
    ? `Liquidity sweep at ${zone.label} — ${zone.candle.pattern} reversal (${zone.candle.strength})`
    : `Price AT ${zone.label} — ${zone.candle.pattern} signal (${zone.candle.strength})`;
  const wrStats = zoneWinRate.get(zone.key);
  const wrText = wrStats && wrStats.wins + wrStats.losses >= 2
    ? ` [WR: ${(wrStats.wins / (wrStats.wins + wrStats.losses) * 100).toFixed(0)}% | ${wrStats.wins}W/${wrStats.losses}L]`
    : "";
  const fullReason = baseReason + (zone.hasFVG ? " [FVG CONFLUENCE]" : "") + wrText;

  // DYNAMIC: SL distance minimum scales with regime ATR
  const slMinForZone = dynamicSLFloor(regime, zone.key) * 0.8; // 80% of SL floor to allow
  if (slDistance < slMinForZone) {
    console.log(`[Bot] Skipping ${zone.key} — SL distance ${slDistance.toFixed(1)} below regime minimum ${slMinForZone.toFixed(1)} (regime: ${regime.regime}, ATR: $${regime.atr.toFixed(2)})`);
    return { setupFound: false, count: 0, reason: `SL too tight (${slDistance.toFixed(1)} pts) — regime ${regime.regime} requires ≥${slMinForZone.toFixed(1)} pts` };
  }

  // Safety Buffer: Don't signal if price is already too close to SL (within 15% of SL distance)
  const proximityToSL = isLong ? (price - sl) : (sl - price);
  const tooCloseToSL = proximityToSL < (slDistance * 0.15);

  if (slBreached || tooCloseToSL) {
    const reason = slBreached ? "Price broke through the stop loss level." : "Price is too close to SL for a safe entry.";
    console.log(`[Bot] Skipping ${zone.key} — ${reason} (Price: ${price.toFixed(2)}, SL: ${sl.toFixed(2)})`);
    return { setupFound: false, count: 0, reason: "SL breached or too close at detection" };
  }

  markZoneCooldown(zone.key);

    // Log
    try {
      await db.insert(signals).values({
        direction: zone.type, zoneLabel: zone.label, zoneTier: zone.tier,
        entry, sl, slDistance, tp1, tp2, tp3,
        currentPrice: price, session, priority: priorityScore,
        reason: fullReason, status: zone.status as "ENTERING" | "AT_LEVEL" | "SWEEP", zoneKey: zone.key,
      });
    } catch (err) { console.error("[Bot] signals insert error:", err); }

    // Restore Confirmation Flow: Log to activeSetups instead of activeTrades
    try {
      // FIX: Prevent duplicate pending setups for the same zone
      const existing = await db.select().from(activeSetups).where(eq(activeSetups.zoneKey, zone.key)).limit(1);
      if (existing.length === 0) {
        const [newSetup] = await db.insert(activeSetups).values({
          zoneKey: zone.key,
          direction: zone.type,
          zoneLabel: zone.label,
          zoneTier: zone.tier,
          entry,
          sl,
          slDistance,
          tp1,
          tp2,
          tp3,
          currentPrice: price,
          status: zone.status as "ENTERING" | "AT_LEVEL" | "SWEEP",
          session,
          priority: priorityScore,
          detectedAt: new Date(),
        }).returning({ id: activeSetups.id });
        
        if (newSetup) {
          lastSignaledSetupId = newSetup.id;
          lastSignaledAt = Date.now();
        }
      } else {
        console.log(`[Bot] Setup for ${zone.key} already pending, skipping duplicate insert.`);
        // Update last signaled ID to the existing one so "In" still works
        lastSignaledSetupId = existing[0].id;
        lastSignaledAt = Date.now();
      }
    } catch (err) { console.error("[Bot] activeSetups insert error:", err); }

  // Append win-rate to signal if available
  const wrAppend = wrText ? `\n<b>Zone Stats:</b>${wrText}` : "";
  // DYNAMIC: Signal now includes regime info
  const msg = formatSignal(zone.type, zone.label, zone.tier, entry, sl, slDistance, tp1, tp2, tp3, price, session, priorityScore, fullReason, zone.status, regime.regime, regime.description, trend15m) + wrAppend;
  await sendTelegram(msg, "signal");

  return { setupFound: true, count: 1, reason: fullReason };
}

// ── Track Active Trades ─────────────────────────────────────────────────────
export async function trackActiveTrades(price: number) {
  if (price <= 0) return; // Sanity check: Never process trades with zero price
  try {
    const trades = await db.select().from(activeTrades).where(eq(activeTrades.closed, false));

    for (const trade of trades) {
      const isLong = trade.direction.includes("LONG");

      if (!trade.tp1Hit) {
        const tp1Reached = isLong ? price >= trade.tp1 : price <= trade.tp1;
        if (tp1Reached) {
          // Update SL to entry price (Break-Even) in DB
          await db.update(activeTrades)
            .set({
              tp1Hit: true,
              tp1HitAt: new Date(),
              sl: trade.entry // MOVE SL TO BE
            })
            .where(eq(activeTrades.id, trade.id));
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
          const isBE = trade.tp1Hit; // If TP1 was hit, this is a BE hit, not a full SL loss
          await db.update(activeTrades)
            .set({ slHit: true, slHitAt: new Date(), closed: true })
            .where(eq(activeTrades.id, trade.id));

          if (isBE) {
            await sendTelegram(formatBEHit(trade, price), "be_hit");
          } else {
            await sendTelegram(formatSLHit(trade, price), "sl_hit");
          }
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
        const reason = slBreached
          ? "Price hit the Stop Loss level."
          : "Setup expired (30 min timeout)";
        const arrow = isLong ? "🟢" : "🔴";

        // If SL breached, give a 5-minute grace period for confirmation before deleting
        const gracePeriod = 5 * 60 * 1000;
        const isWithinGrace = slBreached && ageMs < gracePeriod;

        if (tooOld || (slBreached && !isWithinGrace)) {
          await db.delete(activeSetups).where(eq(activeSetups.id, setup.id));
          breachNotifiedSetups.delete(setup.id);
          
          const cancelMsg = slBreached
            ? `<b>⚠️ SETUP EXPIRED (STOPPED OUT)</b>
Entry: $${setup.entry.toFixed(2)}
SL: $${setup.sl.toFixed(2)}
Current Price: $${price.toFixed(2)}

Reason: ${reason}
Action: Setup is no longer valid.`
            : `<b>⚠️ SETUP CANCELLED</b>\n${arrow} ${setup.direction} @ $${setup.entry.toFixed(2)}\nZone: ${setup.zoneLabel}\nReason: ${reason}`;

          await sendTelegram(cancelMsg, "setup_cancelled");
          console.log(`[Bot] Setup #${setup.id} ${slBreached ? 'expired' : 'cancelled'} — ${reason}`);
        } else if (slBreached && isWithinGrace && !breachNotifiedSetups.has(setup.id)) {
          // Send a warning instead of a cancellation, so user can still confirm "IN"
          const warningMsg = `<b>⚠️ PENDING SETUP STOPPED OUT</b>
${arrow} ${setup.direction} @ $${setup.entry.toFixed(2)}
SL: $${setup.sl.toFixed(2)} | Current: $${price.toFixed(2)}

Reason: Price hit SL immediately. 
<b>If you already entered, reply "IN" to track this loss.</b> Otherwise, do NOT enter.`;
          
          await sendTelegram(warningMsg, "setup_warning");
          breachNotifiedSetups.add(setup.id);
          console.log(`[Bot] Setup #${setup.id} breached but keeping for grace period.`);
          // Do NOT delete yet, allow user to confirm "IN" for 5 minutes
        }
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
  /** Extreme of the candle that created (anchored) the FVG — structural invalidation level. */
  invalidationExtreme: number;
}

const fvgCache: { fvgs: FVG[]; fetchedAt: number } = { fvgs: [], fetchedAt: 0 };
const FVG_CACHE_TTL = 2 * 60 * 1000; // refresh every 2 minutes

function isLondonOrNYSession(): boolean {
  const hour = new Date().getUTCHours();
  return (hour >= 8 && hour < 12) || (hour >= 13 && hour < 20);
}

function detectFVGs(candles: OHLCCandle[]): FVG[] {
  const fvgs: FVG[] = [];
  for (let i = 0; i < candles.length - 2; i++) {
    const c1 = candles[i]!;
    const c3 = candles[i + 2]!;
    if (c3.low > c1.high) {
      fvgs.push({ high: c3.low, low: c1.high, direction: "LONG", formTime: c3.time, invalidationExtreme: c1.low });
    }
    if (c1.low > c3.high) {
      fvgs.push({ high: c1.low, low: c3.high, direction: "SHORT", formTime: c3.time, invalidationExtreme: c1.high });
    }
  }
  const cutoff = Date.now() - 4 * 60 * 60 * 1000;
  return fvgs.filter(f => f.formTime > cutoff);
}

export async function scanFVGs(
  priceData: { price: number; spread: number }
): Promise<ScanResult> {
  const spread = priceData.spread;

  // Fetch candles for regime and trend computation
  const candles5m = await getRecentFiveMinuteCandles();
  const fifteenMinCandles = await fetchTwelveDataOHLC("15min", 100).catch(() => []);
  const hourlyCandles = await fetchTwelveDataOHLC("1h", 120).catch(() => []);
  const regime = getRegimeParams(candles5m, hourlyCandles);

  // DYNAMIC: Spread cap scales with regime
  const maxSpread = dynamicSpreadMax(regime);
  if (spread > maxSpread) {
    return { setupFound: false, count: 0, reason: "FVG: spread too wide for current regime" };
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
    const inGap = price >= fvg.low && price <= fvg.high;
    if (!inGap) continue;

    // DYNAMIC: Minimum gap size scales with regime ATR
    // Original hardcoded 2.0 → now ATR * 0.6 (minimum to filter noise)
    const minGapSize = Math.max(1.5, regime.atr * 0.6);
    const gapSize = fvg.high - fvg.low;
    if (gapSize < minGapSize) continue;

    const zoneKey = `fvg_${fvg.direction}_${fvg.formTime}`;
    if (isZoneOnCooldown(zoneKey) || await isZoneOnCooldownDB(zoneKey)) continue;

    // Multi-Timeframe Trend Check for FVG
    const trend15m = getTrendBias(fifteenMinCandles, "15m", 10);
    const trend1h = getTrendBias(hourlyCandles, "1h", 10);
    const trendCheck15m = checkSignalTrend(fvg.direction, trend15m);
    if (trendCheck15m === "blocked") continue; // Blocked by M15 trend
    const trendCheck1h = checkSignalTrend(fvg.direction, trend1h);

    // Session-Specific Aggression for FVG
    const isLondonNY = session.includes("London") || session.includes("NY");
    if (!isLondonNY && trendCheck1h !== "aligned") {
      continue; // Block non-A+ FVG setups outside London/NY
    }

    // Confluence Check: Is this FVG near a Daily Level?
    const confluenceDist = scaleThreshold(3.0, regime);
    const nearDaily = Object.values(LEVELS).some(l =>
      Math.abs(l.price - (fvg.direction === "LONG" ? fvg.low : fvg.high)) < confluenceDist
    );

    const m15Aligned = trendCheck15m === "aligned";
    const h1Aligned = trendCheck1h === "aligned";

    // DYNAMIC: SL uses regime-aware floor instead of hardcoded 8.0
    const spreadBuffer = spread * 1.5;
    const slFloor = dynamicSLFloor(regime, zoneKey);
    let entry: number, sl: number, tp1: number, tp2: number, tp3: number;
    const isLong = fvg.direction === "LONG";
    if (isLong) {
      entry = fvg.low + 0.5;
      sl = Math.min(fvg.invalidationExtreme - spreadBuffer, entry - slFloor);
      const slDist = entry - sl;
      const rr = dynamicRRTargets(regime);
      tp1 = entry + slDist * rr.tp1;
      tp2 = entry + slDist * rr.tp2;
      tp3 = entry + slDist * rr.tp3;
    } else {
      entry = fvg.high - 0.5;
      sl = Math.max(fvg.invalidationExtreme + spreadBuffer, entry + slFloor);
      const slDist = sl - entry;
      const rr = dynamicRRTargets(regime);
      tp1 = entry - slDist * rr.tp1;
      tp2 = entry - slDist * rr.tp2;
      tp3 = entry - slDist * rr.tp3;
    }

    // FVG Safety Buffer
    const slDistance = Math.abs(entry - sl);
    const proximityToSL = isLong ? (price - sl) : (sl - price);
    const slBreached = isLong ? price <= sl : price >= sl;
    if (slBreached || proximityToSL < (slDistance * 0.15)) {
      continue; // Skip dying FVG setups
    }

    markZoneCooldown(zoneKey);
    count++;

    const arrow = fvg.direction === "LONG" ? "🟢" : "🔴";
    const action = fvg.direction === "LONG" ? "BUY NOW" : "SELL NOW";
    const confluenceText = nearDaily ? " [DAILY LEVEL CONFLUENCE]" : "";
    const priorityScore = (m15Aligned && (h1Aligned || nearDaily)) ? "A+" : priority;
    
    const msg = `<b>🚨 ${arrow} XAU/USD — ${action}${confluenceText}</b>
			<b>Zone:</b> FVG Imbalance $${fvg.low.toFixed(2)}–$${fvg.high.toFixed(2)} (${gapSize.toFixed(2)} pts)
			<b>Entry:</b> $${entry.toFixed(2)} | <b>SL:</b> $${sl.toFixed(2)}
			<b>TP1:</b> $${tp1.toFixed(2)} | <b>TP2:</b> $${tp2.toFixed(2)} | <b>TP3:</b> $${tp3.toFixed(2)}
			<b>Session:</b> ${session} (${priorityScore})
			<b>Regime:</b> ${regime.regime} — ${regime.description}`;

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

    // Restore Confirmation Flow: Log to activeSetups
    try {
      // FIX: Prevent duplicate pending setups for the same FVG
      const existing = await db.select().from(activeSetups).where(eq(activeSetups.zoneKey, zoneKey)).limit(1);
      if (existing.length === 0) {
        const [newSetup] = await db.insert(activeSetups).values({
          zoneKey,
          direction: fvg.direction,
          zoneLabel: `FVG ${fvg.direction} 5m`,
          zoneTier: "key",
          entry,
          sl,
          slDistance: Math.abs(entry - sl),
          tp1,
          tp2,
          tp3,
          currentPrice: price,
          status: "AT_LEVEL",
          session,
          priority,
          detectedAt: new Date(),
        }).returning({ id: activeSetups.id });

        if (newSetup) {
          lastSignaledSetupId = newSetup.id;
          lastSignaledAt = Date.now();
        }
      } else {
        console.log(`[Bot] FVG Setup for ${zoneKey} already pending, skipping duplicate insert.`);
        lastSignaledSetupId = existing[0].id;
        lastSignaledAt = Date.now();
      }
    } catch (err) { console.error("[FVG] activeSetups insert error:", err); }
  }

  return count > 0
    ? { setupFound: true, count, reason: `${count} FVG retrace signal(s)` }
    : { setupFound: false, count: 0, reason: "FVG: no price retrace into active gaps" };
}

// ── Telegram Command Handler ────────────────────────────────────────────────
let lastUpdateId = 0;
let lastSignaledSetupId: number | null = null;
let lastSignaledAt = 0;

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

      // More robust command matching (handles "IN", "I'M IN", "IN 1", etc.)
      const isConfirm = text.includes("IN") && (text.startsWith("IN") || text.includes("I'M IN") || text.includes("IM IN"));
      if (isConfirm) {
        const numMatch = text.match(/\d+/);
        const index = numMatch ? parseInt(numMatch[0]) - 1 : null;
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
      // NEW: Regime check command
      if (text === "REGIME") {
        await handleRegimeCommand();
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
  const priceStatus = price > 0 ? `$${price.toFixed(2)}` : "⚠️ SOURCE DOWN";
  const { session, priority } = getSessionInfo();
  const { safe, message: newsMsg } = isNewsSafe();
  const openTrades = await db.select().from(activeTrades).where(eq(activeTrades.closed, false));

  // Compute current regime
  const recentCandles = await getRecentFiveMinuteCandles();
  const regime = getRegimeParams(recentCandles);

  const msg = `<b>✅ Bot Alive</b>
XAU/USD: ${priceStatus}
Session: ${session} (${priority})
Regime: ${regime.regime} — ${regime.description}
ATR(14): $${regime.atr.toFixed(2)} | Scale: ${regime.scale.toFixed(2)}x
News: ${safe ? "✅ Safe" : "⚠️ " + newsMsg}
Open Trades: ${openTrades.length}
Time: ${new Date().toISOString()}`;
  await sendTelegram(msg, "alive");
}

async function handleStatusCommand() {
  const openTrades = await db.select().from(activeTrades).where(eq(activeTrades.closed, false));
  const data = await fetchGoldData();
  const price = data?.price || 0;

  if (price <= 0) {
    await sendTelegram(`<b>⚠️ Status Warning</b>\nPrice source currently unavailable.\nOpen Trades: ${openTrades.length}`, "status");
    return;
  }

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

  let setupToConfirm: any = null;
  
  if (index !== null) {
    setupToConfirm = setups[index];
  } else {
    // FIX: Prioritize the signal that was just announced to this chat
    if (lastSignaledSetupId) {
      setupToConfirm = setups.find(s => s.id === lastSignaledSetupId);
      // If signal is older than 5 minutes, fallback to newest setup
      if (Date.now() - lastSignaledAt > 5 * 60 * 1000) {
        setupToConfirm = setups[0];
      }
    }
    
    // Fallback to the most recent setup if no specific signaled ID or it's gone
    if (!setupToConfirm) {
      setupToConfirm = setups[0];
    }
  }

  if (!setupToConfirm) {
    await sendTelegram(`No setup found to confirm.`, "confirmed");
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

// DYNAMIC: New REGIME command for Telegram
async function handleRegimeCommand() {
  const data = await fetchGoldData();
  const price = data?.price || 0;
  const recentCandles = await getRecentFiveMinuteCandles();
  const hourlyCandles = await fetchTwelveDataOHLC("1h", 120).catch(() => []);
  const regime = getRegimeParams(recentCandles, hourlyCandles);
  const rr = dynamicRRTargets(regime);
  const slFloor = dynamicSLFloor(regime, "generic");
  const bands = dynamicSpreadBands(regime);

  const msg = `<b>📊 Market Regime Report</b>
Regime: ${regime.regime.toUpperCase()}
${regime.description}
ATR(14) 5m: $${regime.atr.toFixed(2)}
Scale: ${regime.scale.toFixed(2)}x
Momentum: ${regime.momentum.toFixed(2)}
Aggression: ${regime.aggression.toFixed(2)}
No-Trade: ${regime.noTrade ? "🚫 YES" : "✅ No"}

<b>Dynamic Parameters:</b>
SL Floor: ${slFloor.toFixed(2)} pts
Spread Max: ${dynamicSpreadMax(regime).toFixed(2)} pts
R:R Targets: ${rr.tp1} / ${rr.tp2} / ${rr.tp3}
Spread Bands: Active >${bands.active} | Moderate >${bands.moderateMin}

XAU/USD: $${price.toFixed(2)}`;
  await sendTelegram(msg, "regime");
}

// ── Auto-Scan Loop (3-minute interval) ─────────────────────────────────────
let autoScanInterval: ReturnType<typeof setInterval> | null = null;
const AUTO_SCAN_INTERVAL_MS = 3 * 60 * 1000; // 3 minutes

export function startAutoScan() {
  if (autoScanInterval) return;
  console.log("[Bot] Starting auto-scan loop (3-minute interval) — DYNAMIC REGIME ENGINE ACTIVE");

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
        // FIX: Actually call the expiration logic so stale setups don't pile up
        await expireStaleSetups(priceData.price);
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
