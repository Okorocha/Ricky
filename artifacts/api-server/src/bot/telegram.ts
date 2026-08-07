import { db } from "@workspace/db";
import { signals, activeSetups, activeTrades, telegramLog } from "@workspace/db";
import { eq, and, desc, gte } from "drizzle-orm";

const TOKEN = process.env.TELEGRAM_TOKEN || "";
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";
const POLL_INTERVAL = 8000; // 8 seconds (commands are not held up by slow price fetches)
const TWELVE_DATA_KEY = process.env.TWELVE_DATA_API_KEY || "";

// ── Candle interface ──────────────────────────────────────────────────────────
interface OHLCCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

// ── Scan result ───────────────────────────────────────────────────────────────
export interface ScanResult {
  setupFound: boolean;
  count: number;
  reason: string;
}

// ── In-memory signal cooldown per zone ────────────────────────────────────────
const zoneCooldowns = new Map<string, number>();
const ZONE_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes for day trading

// ── Global signal cooldown ────────────────────────────────────────────────────
let lastGlobalSignalTime = 0;
const GLOBAL_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes between scan batches

// ── DB-level cooldown check ───────────────────────────────────────────────────
const breachNotifiedSetups = new Set<number>();
const SETUP_MAX_AGE_MS = 5 * 60 * 1000; // Market-entry signals are valid for one 5M candle
const MAX_MARKET_ENTRY_OB_DISTANCE = 15; // Match the market-execution backtest

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
    return false;
  }
}

function isZoneOnCooldown(zoneKey: string): boolean {
  const last = zoneCooldowns.get(zoneKey);
  if (!last) return false;
  return Date.now() - last < ZONE_COOLDOWN_MS;
}

function markZoneCooldown(zoneKey: string): void {
  zoneCooldowns.set(zoneKey, Date.now());
}

// ── Price history for momentum context ────────────────────────────────────────
interface PriceTick {
  price: number;
  spread: number;
  ts: number;
}
const priceHistory: PriceTick[] = [];
const PRICE_HISTORY_MAX = 20;

function recordPriceTick(price: number, spread: number): void {
  priceHistory.push({ price, spread, ts: Date.now() });
  if (priceHistory.length > PRICE_HISTORY_MAX) priceHistory.shift();
}

// ── Last-known price fallback ─────────────────────────────────────────────────
const LAST_KNOWN_PRICE_STALE_MS = 10 * 60 * 1000; // warn when tick is older than this

/** Returns the most recent recorded tick, or null if nothing has been recorded. */
export function getLastKnownPrice(): PriceTick | null {
  if (priceHistory.length === 0) return null;
  return priceHistory[priceHistory.length - 1]!;
}

export function isPriceTickStale(): boolean {
  const last = getLastKnownPrice();
  if (!last) return true;
  return Date.now() - last.ts > LAST_KNOWN_PRICE_STALE_MS;
}

// ── Twelve Data OHLC Fetching ─────────────────────────────────────────────────
async function fetchTwelveDataOHLC(interval: string, outputsize: number): Promise<OHLCCandle[]> {
  const url = `https://api.twelvedata.com/time_series?symbol=XAU/USD&interval=${interval}&outputsize=${outputsize}&apikey=${TWELVE_DATA_KEY}`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (resp.status !== 200) throw new Error(`Twelve Data HTTP ${resp.status}`);
  const j = await resp.json() as { status?: string; message?: string; values?: { datetime: string; open: string; high: string; low: string; close: string }[] };
  if (j.status === "error") throw new Error(`Twelve Data: ${j.message}`);
  const values = j.values || [];
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

// ── Candle caches ─────────────────────────────────────────────────────────────
let thirtyMinCandleCache: { candles: OHLCCandle[]; fetchedAt: number } | null = null;
const THIRTY_MIN_CACHE_TTL = 2 * 60 * 1000;

let fiveMinCandleCache: { candles: OHLCCandle[]; fetchedAt: number } | null = null;
const FIVE_MIN_CACHE_TTL = 60 * 1000;

let fourHourCandleCache: { candles: OHLCCandle[]; fetchedAt: number } | null = null;
let oneHourCandleCache: { candles: OHLCCandle[]; fetchedAt: number } | null = null;
const ONE_HOUR_CACHE_TTL = 4 * 60 * 60 * 1000;

export async function getRecent1HourCandles(): Promise<OHLCCandle[]> {
  const now = Date.now();
  if (oneHourCandleCache && now - oneHourCandleCache.fetchedAt < ONE_HOUR_CACHE_TTL) {
    return oneHourCandleCache.candles;
  }
  try {
    const candles = await fetchTwelveDataOHLC("1h", 48);
    oneHourCandleCache = { candles, fetchedAt: now };
    return candles;
  } catch {
    return oneHourCandleCache?.candles ?? [];
  }
}
const FOUR_HOUR_CACHE_TTL = 4 * 60 * 60 * 1000;

export async function getRecent30MinCandles(): Promise<OHLCCandle[]> {
  const now = Date.now();
  if (thirtyMinCandleCache && now - thirtyMinCandleCache.fetchedAt < THIRTY_MIN_CACHE_TTL) {
    return thirtyMinCandleCache.candles;
  }
  try {
    const candles = await fetchTwelveDataOHLC("30min", 96);
    thirtyMinCandleCache = { candles, fetchedAt: now };
    return candles;
  } catch {
    return thirtyMinCandleCache?.candles ?? [];
  }
}

export async function getRecent5MinCandles(): Promise<OHLCCandle[]> {
  const now = Date.now();
  if (fiveMinCandleCache && now - fiveMinCandleCache.fetchedAt < FIVE_MIN_CACHE_TTL) {
    return fiveMinCandleCache.candles;
  }
  try {
    const candles = await fetchTwelveDataOHLC("5min", 288);
    fiveMinCandleCache = { candles, fetchedAt: now };
    return candles;
  } catch {
    return fiveMinCandleCache?.candles ?? [];
  }
}

export async function getRecent4HourCandles(): Promise<OHLCCandle[]> {
  const now = Date.now();
  if (fourHourCandleCache && now - fourHourCandleCache.fetchedAt < FOUR_HOUR_CACHE_TTL) {
    return fourHourCandleCache.candles;
  }
  try {
    const candles = await fetchTwelveDataOHLC("4h", 48);
    fourHourCandleCache = { candles, fetchedAt: now };
    return candles;
  } catch {
    return fourHourCandleCache?.candles ?? [];
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SMC MULTI-TIMEFRAME ENGINE
// ═══════════════════════════════════════════════════════════════════════════════

// ─── 4H Market Structure (Swing Highs/Lows) ──────────────────────────────────
interface MarketStructure {
  trend: "bullish" | "bearish" | "neutral";
  lastSwingHigh: number;
  lastSwingLow: number;
  structure: "HH-HL" | "LH-LL" | "choppy";
  swingPoints: { price: number; type: "high" | "low"; index: number }[];
  isRanging: boolean;
  rangeWidth: number;
}

function analyze4HStructure(candles: OHLCCandle[]): MarketStructure {
  if (candles.length < 12) {
    return { trend: "neutral", lastSwingHigh: 0, lastSwingLow: 0, structure: "choppy", swingPoints: [], isRanging: false, rangeWidth: 0 };
  }

  const lookback = 3;
  const swingPoints: { price: number; type: "high" | "low"; index: number }[] = [];

  for (let i = lookback; i < candles.length - lookback; i++) {
    const c = candles[i]!;
    const leftH = candles.slice(i - lookback, i);
    const rightH = candles.slice(i + 1, i + lookback + 1);
    const leftL = candles.slice(i - lookback, i);
    const rightL = candles.slice(i + 1, i + lookback + 1);

    if (leftH.every(x => x.high <= c.high) && rightH.every(x => x.high <= c.high)) {
      swingPoints.push({ price: c.high, type: "high", index: i });
    }
    if (leftL.every(x => x.low >= c.low) && rightL.every(x => x.low >= c.low)) {
      swingPoints.push({ price: c.low, type: "low", index: i });
    }
  }

  swingPoints.sort((a, b) => a.index - b.index);

  const recentSwings = swingPoints.slice(-6);
  const highs = recentSwings.filter(s => s.type === "high").map(s => s.price);
  const lows = recentSwings.filter(s => s.type === "low").map(s => s.price);

  let structure: "HH-HL" | "LH-LL" | "choppy" = "choppy";
  let trend: "bullish" | "bearish" | "neutral" = "neutral";

  if (highs.length >= 2 && lows.length >= 2) {
    const lastTwoHighs = highs.slice(-2);
    const lastTwoLows = lows.slice(-2);
    const higherHighs = lastTwoHighs[1]! > lastTwoHighs[0]!;
    const higherLows = lastTwoLows[1]! > lastTwoLows[0]!;
    const lowerHighs = lastTwoHighs[1]! < lastTwoHighs[0]!;
    const lowerLows = lastTwoLows[1]! < lastTwoLows[0]!;

    if (higherHighs && higherLows) { structure = "HH-HL"; trend = "bullish"; }
    else if (lowerHighs && lowerLows) { structure = "LH-LL"; trend = "bearish"; }
  }

  // ── Range detection: if highs and lows are roughly flat → 4H is ranging ──
  let isRanging = false;
  let rangeWidth = 0;

  if (trend === "neutral" && highs.length >= 2 && lows.length >= 2) {
    const maxHigh = Math.max(...highs);
    const minLow = Math.min(...lows);
    const midPrice = (maxHigh + minLow) / 2;
    rangeWidth = maxHigh - minLow;

    // A 4H range is defined as:
    // - Highs within ~1% of each other (no clear HH or LH)
    // - Lows within ~1% of each other (no clear HL or LL)
    // - Range width is at least $15 (meaningful range, not flatline)
    const highVariance = Math.abs(highs[0]! - highs[highs.length - 1]!) / midPrice;
    const lowVariance = Math.abs(lows[0]! - lows[lows.length - 1]!) / midPrice;
    const isFlat = highVariance < 0.01 && lowVariance < 0.01;
    const hasWidth = rangeWidth >= 15;

    if (isFlat && hasWidth) {
      isRanging = true;
    }
  }

  return {
    trend,
    lastSwingHigh: highs.length > 0 ? highs[highs.length - 1]! : 0,
    lastSwingLow: lows.length > 0 ? lows[lows.length - 1]! : 0,
    structure,
    swingPoints,
    isRanging,
    rangeWidth,
  };
}

// ─── 30M Order Block Detection ───────────────────────────────────────────────
interface OrderBlock {
  price: number;
  direction: "LONG" | "SHORT";
  high: number;
  low: number;
  bodyHigh: number;
  bodyLow: number;
  impulseTarget: number;
  distance: number;
  index: number;
  isValid: boolean;
}

function detectOrderBlocks(candles: OHLCCandle[]): OrderBlock[] {
  const blocks: OrderBlock[] = [];
  if (candles.length < 4) return blocks;

  const recent = candles.slice(-30);
  const currentPrice = candles[candles.length - 1]?.close ?? 0;

  for (let i = recent.length - 4; i >= 0; i--) {
    const ob = recent[i]!;

    // Bullish OB: last down candle before an impulse up
    if (i + 2 < recent.length) {
      const next1 = recent[i + 1]!;
      const next2 = recent[i + 2]!;

      if (ob.close < ob.open) {
        const impulseStrength1 = next1.close - next1.open;
        const impulseStrength2 = next2.close - next2.open;

        if (impulseStrength1 > 1.5 && next2.close > next1.close) {
          const obLow = Math.min(ob.low, next1.low);
          const distance = currentPrice - obLow;
          const isMitigated = currentPrice < obLow;

          if (!isMitigated && distance > 2 && distance < 80) {
            blocks.push({
              price: obLow, direction: "LONG", high: ob.high, low: obLow,
              bodyHigh: ob.open, bodyLow: ob.close, impulseTarget: next2.high,
              distance, index: i, isValid: true,
            });
          }
        }
      }
    }

    // Bearish OB: last up candle before an impulse down
    if (i + 2 < recent.length) {
      const next1 = recent[i + 1]!;
      const next2 = recent[i + 2]!;

      if (ob.close > ob.open) {
        const impulseStrength1 = next1.open - next1.close;
        const impulseStrength2 = next2.open - next2.close;

        if (impulseStrength1 > 1.5 && next2.close < next1.close) {
          const obHigh = Math.max(ob.high, next1.high);
          const distance = obHigh - currentPrice;
          const isMitigated = currentPrice > obHigh;

          if (!isMitigated && distance > 2 && distance < 80) {
            blocks.push({
              price: obHigh, direction: "SHORT", high: obHigh, low: ob.low,
              bodyHigh: ob.close, bodyLow: ob.open, impulseTarget: next2.low,
              distance, index: i, isValid: true,
            });
          }
        }
      }
    }
  }

  return blocks;
}

// ─── CHoCH Detection ──────────────────────────────────────────────────────────
interface CHoCHResult {
  occurred: boolean;
  direction: "bullish" | "bearish";
  swingLevel: number;
  candlesAgo: number;
}

function detectCHoCH(candles: OHLCCandle[]): CHoCHResult {
  if (candles.length < 8) return { occurred: false, direction: "bullish", swingLevel: 0, candlesAgo: 0 };

  const recent = candles.slice(-8);
  let swingHigh = -Infinity;
  let swingLow = Infinity;
  let swingHighIdx = -1;
  let swingLowIdx = -1;

  for (let i = 0; i < Math.min(6, recent.length - 2); i++) {
    if (recent[i]!.high > swingHigh) { swingHigh = recent[i]!.high; swingHighIdx = i; }
    if (recent[i]!.low < swingLow) { swingLow = recent[i]!.low; swingLowIdx = i; }
  }

  const lastCandle = recent[recent.length - 1]!;

  if (lastCandle.close > swingHigh && swingHighIdx >= 0) {
    return { occurred: true, direction: "bullish", swingLevel: swingHigh, candlesAgo: recent.length - 1 - swingHighIdx };
  }
  if (lastCandle.close < swingLow && swingLowIdx >= 0) {
    return { occurred: true, direction: "bearish", swingLevel: swingLow, candlesAgo: recent.length - 1 - swingLowIdx };
  }

  return { occurred: false, direction: "bullish", swingLevel: 0, candlesAgo: 0 };
}

// ─── 30M Structure ───────────────────────────────────────────────────────────
interface Structure30M {
  trend: "bullish" | "bearish" | "neutral";
  lastSwingHigh: number;
  lastSwingLow: number;
}

function analyze30MStructure(candles: OHLCCandle[]): Structure30M {
  if (candles.length < 8) return { trend: "neutral", lastSwingHigh: 0, lastSwingLow: 0 };

  const recent = candles.slice(-8);
  const lookback = 2;
  let swingHigh = -Infinity;
  let swingLow = Infinity;

  for (let i = lookback; i < recent.length - lookback; i++) {
    const c = recent[i]!;
    const left = recent.slice(i - lookback, i);
    const right = recent.slice(i + 1, i + lookback + 1);
    if (left.every(x => x.high <= c.high) && right.every(x => x.high <= c.high)) swingHigh = Math.max(swingHigh, c.high);
    if (left.every(x => x.low >= c.low) && right.every(x => x.low >= c.low)) swingLow = Math.min(swingLow, c.low);
  }

  if (swingHigh > -Infinity || swingLow < Infinity) {
    const lastCandle = recent[recent.length - 1]!;
    const prevCandle = recent[recent.length - 2]!;
    if (lastCandle.close > prevCandle.close && lastCandle.close > swingLow + 2) return { trend: "bullish", lastSwingHigh: swingHigh, lastSwingLow: swingLow };
    if (lastCandle.close < prevCandle.close && lastCandle.close < swingHigh - 2) return { trend: "bearish", lastSwingHigh: swingHigh, lastSwingLow: swingLow };
  }

  // Fallback: EMA-based bias when swing structure is inconclusive
  if (candles.length >= 20) {
    const closes = candles.slice(-20).map(c => c.close);
    const ema20 = closes.reduce((s, v) => s + v, 0) / closes.length;
    const lastClose = closes[closes.length - 1]!;
    if (lastClose > ema20 * 1.001) {
      return { trend: "bullish", lastSwingHigh: lastClose + 5, lastSwingLow: lastClose - 10 };
    }
    if (lastClose < ema20 * 0.999) {
      return { trend: "bearish", lastSwingHigh: lastClose + 10, lastSwingLow: lastClose - 5 };
    }
  }

  return { trend: "neutral", lastSwingHigh: swingHigh > -Infinity ? swingHigh : 0, lastSwingLow: swingLow < Infinity ? swingLow : 0 };
}

// ─── 1H Structure Analysis (for confluence filter) ─────────────────────────
function analyze1HStructure(candles: OHLCCandle[]): { trend: "bullish" | "bearish" | "neutral"; lastSwingHigh: number; lastSwingLow: number } {
  if (candles.length < 8) return { trend: "neutral", lastSwingHigh: 0, lastSwingLow: 0 };
  const recent = candles.slice(-8);
  const lookback = 2;
  let swingHigh = -Infinity;
  let swingLow = Infinity;
  for (let i = lookback; i < recent.length - lookback; i++) {
    const c = recent[i]!;
    const left = recent.slice(i - lookback, i);
    const right = recent.slice(i + 1, i + lookback + 1);
    if (left.every(x => x.high <= c.high) && right.every(x => x.high <= c.high)) swingHigh = Math.max(swingHigh, c.high);
    if (left.every(x => x.low >= c.low) && right.every(x => x.low >= c.low)) swingLow = Math.min(swingLow, c.low);
  }
  if (swingHigh > -Infinity || swingLow < Infinity) {
    const lastCandle = recent[recent.length - 1]!;
    const prevCandle = recent[recent.length - 2]!;
    if (lastCandle.close > prevCandle.close && lastCandle.close > swingLow + 2) return { trend: "bullish", lastSwingHigh: swingHigh, lastSwingLow: swingLow };
    if (lastCandle.close < prevCandle.close && lastCandle.close < swingHigh - 2) return { trend: "bearish", lastSwingHigh: swingHigh, lastSwingLow: swingLow };
  }
  // Fallback: EMA on 1H
  if (candles.length >= 12) {
    const closes = candles.slice(-12).map(c => c.close);
    const ema12 = closes.reduce((s, v) => s + v, 0) / closes.length;
    const lastClose = closes[closes.length - 1]!;
    if (lastClose > ema12 * 1.001) return { trend: "bullish", lastSwingHigh: lastClose + 5, lastSwingLow: lastClose - 10 };
    if (lastClose < ema12 * 0.999) return { trend: "bearish", lastSwingHigh: lastClose + 10, lastSwingLow: lastClose - 5 };
  }
  return { trend: "neutral", lastSwingHigh: swingHigh > -Infinity ? swingHigh : 0, lastSwingLow: swingLow < Infinity ? swingLow : 0 };
}

// ─── 30M Range Detection ─────────────────────────────────────────────────────
interface RangeResult {
  isRanging: boolean;
  rangeTop: number;
  rangeBottom: number;
  rangeWidth: number;
}

function detect30MRange(candles: OHLCCandle[]): RangeResult {
  if (candles.length < 12) return { isRanging: false, rangeTop: 0, rangeBottom: 0, rangeWidth: 0 };

  const recent = candles.slice(-12);
  const allHighs = recent.map(c => c.high);
  const allLows = recent.map(c => c.low);
  const rangeTop = Math.max(...allHighs);
  const rangeBottom = Math.min(...allLows);
  const rangeWidth = rangeTop - rangeBottom;

  // 30M is ranging if price has been oscillating within a defined band
  // and the range width is meaningful ($5+) but not too wide ($40+)
  const recent3 = recent.slice(-3);
  const avgClose = recent3.reduce((s, c) => s + c.close, 0) / recent3.length;
  const midRange = (rangeTop + rangeBottom) / 2;

  // If average close of last 3 candles is near the middle of the range,
  // and the range is bounded (not trending through it), it's a range
  const isCentered = Math.abs(avgClose - midRange) < rangeWidth * 0.4;
  const isBounded = rangeWidth >= 3 && rangeWidth <= 60;

  return {
    isRanging: isCentered && isBounded,
    rangeTop,
    rangeBottom,
    rangeWidth,
  };
}

// ─── Liquidity Sweep Detection ───────────────────────────────────────────────
function detectLiquiditySweep(candles: OHLCCandle[], swingHigh: number, swingLow: number): "above" | "below" | "none" {
  if (candles.length < 3) return "none";
  const last = candles[candles.length - 1]!;
  if (last.high > swingHigh && last.close < swingHigh && swingHigh > 0) return "above";
  if (last.low < swingLow && last.close > swingLow && swingLow > 0) return "below";
  return "none";
}

// ═══════════════════════════════════════════════════════════════════════════════
// SL / TP CALCULATION
// ═══════════════════════════════════════════════════════════════════════════════

function calculateSMCSL(
  entry: number,
  direction: "LONG" | "SHORT",
  ob: OrderBlock,
  structure30m: Structure30M
): { sl: number; slDistance: number } {
  // SMC-style: SL placed at OB invalidation + spread buffer.
  // If the OB gets invalidated, the setup is wrong — get out.
  // No arbitrary minimum/maximum. The OB either holds or it doesn't.
  const BUFFER = 8.0;  // widened from 5pt — Standard account spread needs more room

  if (direction === "LONG") {
    const sl = ob.low - BUFFER; // Below the OB candle's low wick
    const slDist = Math.abs(entry - sl);
    return { sl: Math.round(sl * 100) / 100, slDistance: Math.round(slDist * 100) / 100 };
  } else {
    const sl = ob.high + BUFFER; // Above the OB candle's high wick
    const slDist = Math.abs(entry - sl);
    return { sl: Math.round(sl * 100) / 100, slDistance: Math.round(slDist * 100) / 100 };
  }
}

function calculateSMCTP(
  entry: number,
  direction: "LONG" | "SHORT",
  slDistance: number,
  _structure4h: MarketStructure
): { tp1: number; tp2: number; tp3: number } {
  const isLong = direction === "LONG";
  const tp1 = isLong ? entry + slDistance * 1.5 : entry - slDistance * 1.5;
  const tp2 = isLong ? entry + slDistance * 2.5 : entry - slDistance * 2.5;
  const tp3 = isLong ? entry + slDistance * 4.0 : entry - slDistance * 4.0;
  return {
    tp1: Math.round(tp1 * 100) / 100,
    tp2: Math.round(tp2 * 100) / 100,
    tp3: Math.round(tp3 * 100) / 100,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// FORMAT HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

export function formatSMCSignal(
  direction: string, entry: number, sl: number, slDist: number,
  tp1: number, tp2: number, tp3: number, currentPrice: number,
  trend: string, obType: string, choch: boolean, sweep: string,
  session: string, priority: string, biasSource: string = "4H"
): string {
  const isLong = direction.includes("LONG");
  const arrow = isLong ? "🟢" : "🔴";
  const action = isLong ? "BUY" : "SELL";
  const chochText = choch ? " ✅ CHoCH" : "";
  const sweepText = sweep !== "none" ? ` | Sweep: ${sweep}` : "";
  const biasLabel = `${trend.toUpperCase()} (30M Bias)`;

  return `<b>📊 SMC DAY TRADE — XAU/USD</b>
${arrow} <b>${action}</b> @ $${entry.toFixed(2)}

<b>SL:</b> $${sl.toFixed(2)} (${slDist.toFixed(1)} pts)
<b>TP1:</b> $${tp1.toFixed(2)} (1.5R)
<b>TP2:</b> $${tp2.toFixed(2)} (2.5R)
<b>TP3:</b> $${tp3.toFixed(2)} (4R)

<b>Trend:</b> ${biasLabel}
<b>Entry:</b> Market Execution
<b>Context:</b> ${obType} Order Block (30M)
<b>Confirmation:</b> 5M CHoCH${chochText}${sweepText}
<b>Session:</b> ${session} (${priority})

<b>Market Entry | 30M OB + 5M CHoCH | 1H Confluence | Structural SL (8pt)</b>`;
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

export function formatBEHit(trade: { direction: string; entry: number; tp1: number; tp2Hit?: boolean }, currentPrice: number): string {
  const arrow = trade.direction.includes("LONG") ? "🟢" : "🔴";
  if (trade.tp2Hit) {
    return `<b>🎯 TRAILING STOP HIT — $${currentPrice.toFixed(2)}</b>
${arrow} ${trade.direction} @ $${trade.entry.toFixed(2)}
SL moved to TP2: $${trade.tp1.toFixed(2)}
Let it run to TP3 or let the market decide.`;
  }
  return `<b>🛡️ BREAK-EVEN — $${currentPrice.toFixed(2)}</b>
${arrow} ${trade.direction} @ $${trade.entry.toFixed(2)}
TP1 Hit. SL moved to $${trade.entry.toFixed(2)} (BE)
Risk-free trade. Let it run to TP2/TP3.`;
}

// ─── Session Info ────────────────────────────────────────────────────────────
export function getSessionInfo(): { session: string; priority: string; note: string } {
  const now = new Date();
  const hour = now.getUTCHours();
  if (hour >= 0 && hour < 7) return { session: "Asian Session", priority: "MEDIUM", note: "Counter-trend OK, smaller size" };
  if (hour >= 7 && hour < 12) return { session: "London Session", priority: "HIGH", note: "Strong momentum" };
  if (hour >= 12 && hour < 16) return { session: "London-NY Overlap", priority: "HIGHEST", note: "Peak volatility" };
  if (hour >= 16 && hour < 21) return { session: "NY Session", priority: "HIGH", note: "Momentum continuation" };
  return { session: "Dead Zone", priority: "LOW", note: "Avoid trading" };
}

// ─── News Filter ─────────────────────────────────────────────────────────────
export function isNewsSafe(): { safe: boolean; message: string } {
  const now = new Date();
  const day = now.getUTCDay();
  const hour = now.getUTCHours();
  const date = now.getUTCDate();
  if (day === 0 || day === 6) return { safe: false, message: "Market Closed" };
  if (day === 5 && hour >= 20) return { safe: false, message: "Friday Close approaching" };
  if (day === 3 && hour >= 17 && hour <= 20) return { safe: false, message: "FOMC Window" };
  if (day === 5 && date <= 7 && hour >= 12 && hour <= 15) return { safe: false, message: "NFP Window — NO TRADES" };
  if (date >= 10 && date <= 16 && hour >= 12 && hour <= 14) return { safe: false, message: "Inflation Data Window" };
  return { safe: true, message: "No news events — safe to trade" };
}

// ─── Telegram Sender ─────────────────────────────────────────────────────────
export async function sendTelegram(text: string, type: string = "signal"): Promise<boolean> {
  try {
    const resp = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: "HTML", disable_web_page_preview: true }),
    });
    const success = resp.status === 200;
    try { await db.insert(telegramLog).values({ type, content: text.substring(0, 4000), success }); } catch {}
    return success;
  } catch (e) {
    try { await db.insert(telegramLog).values({ type, content: `Error: ${e}`, success: false }); } catch {}
    return false;
  }
}

// ─── Fetch Price ─────────────────────────────────────────────────────────────
export async function fetchGoldData(): Promise<{ price: number; bid: number; ask: number; spread: number; source: string } | null> {
  type PriceData = { price: number; bid: number; ask: number; spread: number; source: string };
  const trySwissquote = async (): Promise<PriceData> => {
    const resp = await fetch("https://forex-data-feed.swissquote.com/public-quotes/bboquotes/instrument/XAU/USD", { signal: AbortSignal.timeout(4000) });
    if (resp.status !== 200) throw new Error("non-200");
    const j = await resp.json() as Array<{ spreadProfilePrices: Array<{ bid: string; ask: string }> }>;
    const profiles = j?.[0]?.spreadProfilePrices || [];
    if (!profiles.length) throw new Error("no profiles");
    const bid = parseFloat(profiles[0].bid);
    const ask = parseFloat(profiles[0].ask);
    if (!bid || !ask) throw new Error("bad prices");
    return { price: (bid + ask) / 2, bid, ask, spread: ask - bid, source: "Swissquote" };
  };
  const tryGoldpriceDev = async (): Promise<PriceData> => {
    const resp = await fetch("https://api.goldprice.dev/v1/prices?symbol=XAU-USD-SPOT", { signal: AbortSignal.timeout(8000) });
    if (resp.status !== 200) throw new Error(`non-200 ${resp.status}`);
    const j = await resp.json() as { symbols?: Array<{ price?: string; bid?: string; ask?: string }> };
    const s = j?.symbols?.[0];
    const price = parseFloat(s?.price ?? "");
    if (!price) throw new Error("no price");
    const bid = parseFloat(s?.bid ?? "");
    const ask = parseFloat(s?.ask ?? "");
    if (!bid || !ask) throw new Error("no bid/ask");
    return { price, bid, ask, spread: ask - bid, source: "goldprice.dev" };
  };
  const tryFrankfurterDev = async (): Promise<PriceData> => {
    const resp = await fetch("https://api.frankfurter.dev/v2/rate/XAU/USD", { signal: AbortSignal.timeout(8000) });
    if (resp.status !== 200) throw new Error(`non-200 ${resp.status}`);
    const j = await resp.json() as { rate?: number; date?: string };
    const rate = j?.rate;
    if (!rate) throw new Error("no rate");
    // Sanity check: the v2 /rate/XAU/USD endpoint returns USD per 1 XAU (the XAU/USD
    // spot price, e.g. ~4300). A stale or inverted quote would land outside this band.
    if (rate < 100 || rate > 10000) throw new Error(`suspicious rate ${rate}`);
    return { price: rate, bid: rate, ask: rate + 0.5, spread: 0.5, source: `frankfurter.dev (${j.date ?? "?"})` };
  };

  // Try primary sources concurrently (best of three wins), then retry once on failure.
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await Promise.any([trySwissquote(), tryGoldpriceDev(), tryFrankfurterDev()]).catch(() => null);
    if (result) { recordPriceTick(result.price, result.spread); return result; }
    if (attempt === 0) await new Promise(r => setTimeout(r, 800));
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN SMC SCAN — WITH MULTI-TIMEFRAME BIAS SWITCHING
// ═══════════════════════════════════════════════════════════════════════════════

let lastSignaledSetupId: number | null = null;
let lastSignaledAt = 0;

export async function scanSMCZones(
  priceData: { price: number; bid: number; ask: number; spread: number; source: string }
): Promise<ScanResult> {
  const price = priceData.price;
  const spread = priceData.spread;

  // Gate 1: News
  const { safe, message: newsMsg } = isNewsSafe();
  if (!safe) return { setupFound: false, count: 0, reason: `News blackout — ${newsMsg}` };

  // Gate 2: Session
  const { session, priority } = getSessionInfo();
  if (priority === "LOW") return { setupFound: false, count: 0, reason: `Outside active hours — ${session}` };

  // Gate 3: Spread — removed. SL is placed structurally below/above OB with buffer.
  // Spread wicks are absorbed by the structural SL placement, not by filtering setups.

  // Gate 4: Global cooldown
  const timeSinceLast = Date.now() - lastGlobalSignalTime;
  if (timeSinceLast < GLOBAL_COOLDOWN_MS) {
    const remaining = Math.ceil((GLOBAL_COOLDOWN_MS - timeSinceLast) / 60000);
    return { setupFound: false, count: 0, reason: `Global cooldown (${remaining}m)` };
  }

  // Gate 5: Trade limits
  const { blockedDirections, blockedZoneKeys } = await getTradeConstraints();

  // ─── STEP 1: Fetch 30M candles ───
  const candles30m = await getRecent30MinCandles();

  // ─── STEP 2: 30M Structure (bias only) ───
  const structure30m = analyze30MStructure(candles30m);

  // ─── STEP 3: Bias from 30M only ───
  const structure4h: MarketStructure = { trend: "neutral", lastSwingHigh: 0, lastSwingLow: 0, structure: "choppy", swingPoints: [], isRanging: false, rangeWidth: 0 };
  let biasSource: "30M+1H" = "30M+1H";
  let activeBias: "bullish" | "bearish";
  let biasLabel: string;

  if (structure30m.trend === "bullish" || structure30m.trend === "bearish") {
    activeBias = structure30m.trend;
    biasLabel = `${structure30m.trend} (30M)`;
  } else {
    // 30M neutral → no trade
    return { setupFound: false, count: 0, reason: "30M neutral — no clear swing structure" };
  }

  // ─── STEP 3.5: 1H Confluence Filter ───
  // Block only if 1H is actively OPPOSITE to 30M bias. Neutral 1H is allowed (30M leads).
  const candles1h = await getRecent1HourCandles();
  const structure1h = candles1h.length >= 8
    ? analyze1HStructure(candles1h)
    : { trend: "neutral" as const, lastSwingHigh: 0, lastSwingLow: 0 };
  const oppositeOf = (b: "bullish" | "bearish") => b === "bullish" ? "bearish" : "bullish";
  if (structure1h.trend === oppositeOf(activeBias)) {
    return { setupFound: false, count: 0, reason: `1H opposing bias (1H: ${structure1h.trend}, 30M: ${activeBias})` };
  }

  // ─── STEP 4: 30M Order Blocks filtered by active bias ───
  const orderBlocks = detectOrderBlocks(candles30m);
  const validOBs = orderBlocks.filter(ob =>
    (activeBias === "bullish" && ob.direction === "LONG") ||
    (activeBias === "bearish" && ob.direction === "SHORT")
  );

  if (validOBs.length === 0) return { setupFound: false, count: 0, reason: `No OBs in ${activeBias} direction (${biasSource} bias)` };
  validOBs.sort((a, b) => a.distance - b.distance);

  // ─── STEP 5: 5M CHoCH Confirmation ───
  const candles5m = await getRecent5MinCandles();
  const choch5m = detectCHoCH(candles5m);
  const range30m = detect30MRange(candles30m);

  // The 30M chart defines the order-block context; the 5M chart provides
  // the execution trigger. Confirmation must agree with the 30M bias.
  let confMode = "none";
  let confQuality: "A" | "B" = "A";

  if (choch5m.occurred && ((activeBias === "bullish" && choch5m.direction === "bullish") || (activeBias === "bearish" && choch5m.direction === "bearish"))) {
    confMode = "CHoCH";
    confQuality = "A";
  }

  if (confMode === "none") {
    return { setupFound: false, count: 0, reason: "No 5M CHoCH confirmation" };
  }

  // ─── STEP 6: Evaluate each valid OB ───
  const MAX_SETUPS_PER_SCAN = 3;
  let createdCount = 0;
  for (const ob of validOBs) {
    if (createdCount >= MAX_SETUPS_PER_SCAN) break;
    const zoneKey = `smc_${ob.direction.toLowerCase()}_${ob.index}`;
    if (blockedZoneKeys.has(zoneKey)) continue;
    if (isZoneOnCooldown(zoneKey) || await isZoneOnCooldownDB(zoneKey)) continue;

    // The order block remains the setup context and structural invalidation point.
    // Entry is taken at the current executable market price instead of waiting
    // for a retrace to the OB.
    const entryPrice = ob.direction === "LONG" ? priceData.ask : priceData.bid;
    const marketEntryDistance = Math.abs(entryPrice - ob.price);
    if (marketEntryDistance < 2 || marketEntryDistance > MAX_MARKET_ENTRY_OB_DISTANCE) continue;

    const { sl, slDistance } = calculateSMCSL(entryPrice, ob.direction, ob, structure30m);
    const isLong = ob.direction === "LONG";
    const slBreached = isLong ? price <= sl : price >= sl;
    if (slBreached) continue;

    // Spread-aware proximity: require more distance from SL to account for spread wicks
    const proximityToSL = isLong ? (price - sl) : (sl - price);
    if (proximityToSL < (slDistance * 0.25)) continue;

    // Calculate TPs
    let { tp1, tp2, tp3 } = calculateSMCTP(entryPrice, ob.direction, slDistance, structure4h);

    // Cap TP3 at 30M range boundary if ranging
    if (range30m.isRanging) {
      if (isLong && tp3 > range30m.rangeTop) {
        tp3 = Math.round(range30m.rangeTop * 100) / 100;
      }
      if (!isLong && tp3 < range30m.rangeBottom) {
        tp3 = Math.round(range30m.rangeBottom * 100) / 100;
      }
    }

    markZoneCooldown(zoneKey);

    const obType = ob.direction === "LONG" ? "Bullish" : "Bearish";
    const msg = formatSMCSignal(
      ob.direction, entryPrice, sl, slDistance, tp1, tp2, tp3,
      price, activeBias, obType, confMode === "CHoCH", "none", session, priority, biasSource
    );

    try {
      await db.insert(signals).values({
        direction: ob.direction,
        zoneLabel: `${obType} OB (30M) | ${biasSource} ${biasLabel}`,
        zoneTier: "major", entry: entryPrice, sl, slDistance,
        tp1, tp2, tp3, currentPrice: price, session,
        priority: "A+",
         reason: `SMC: ${obType} OB + ${biasSource} ${biasLabel} | 5M ${confMode} | 1H Confluence: ${structure1h.trend}`,
        status: "MARKET", zoneKey,
      });
      await db.insert(activeSetups).values({
        zoneKey, direction: ob.direction,
        zoneLabel: `${obType} OB (30M)`, zoneTier: "major",
        entry: entryPrice, sl, slDistance, tp1, tp2, tp3,
        currentPrice: entryPrice, status: "MARKET", session,
        priority: "A+", detectedAt: new Date(),
      });
    } catch (err) {
      console.error("[Bot] SMC signal insert error:", err);
    }

      await sendTelegram(msg, `smc_signal_${confMode}`);
      createdCount++;
  }

  if (createdCount > 0) {
    lastGlobalSignalTime = Date.now();
    return {
      setupFound: true,
      count: createdCount,
      reason: `SMC: ${createdCount} ${activeBias} market setup(s) | 30M OB + 5M ${confMode} | ${biasSource} ${biasLabel}`,
    };
  }

  return { setupFound: false, count: 0, reason: `No eligible OBs in range | ${biasSource}: ${biasLabel}` };
}

// ═══════════════════════════════════════════════════════════════════════════════
// TRADE MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════

export async function trackActiveTrades(price: number) {
  try {
    const trades = await db.select().from(activeTrades).where(eq(activeTrades.closed, false));
    for (const trade of trades) {
      const isLong = trade.direction.includes("LONG");

      if (!trade.tp1Hit && (isLong ? price >= trade.tp1 : price <= trade.tp1)) {
        trade.tp1Hit = true; trade.tp1HitAt = new Date();
        await db.update(activeTrades).set({ tp1Hit: true, tp1HitAt: new Date(), sl: trade.entry }).where(eq(activeTrades.id, trade.id));
        await sendTelegram(formatTPHit(trade, "TP1", price), "tp1_hit");
      }
      if (!trade.tp2Hit && (isLong ? price >= trade.tp2 : price <= trade.tp2)) {
        trade.tp2Hit = true; trade.tp2HitAt = new Date();
        await db.update(activeTrades).set({ tp2Hit: true, tp2HitAt: new Date(), sl: trade.tp2 }).where(eq(activeTrades.id, trade.id));
        await sendTelegram(formatTPHit(trade, "TP2", price), "tp2_hit");
      }
      if (!trade.tp3Hit && (isLong ? price >= trade.tp3 : price <= trade.tp3)) {
        trade.tp3Hit = true; trade.tp3HitAt = new Date(); trade.closed = true;
        await db.update(activeTrades).set({ tp3Hit: true, tp3HitAt: new Date(), closed: true }).where(eq(activeTrades.id, trade.id));
        await sendTelegram(formatTPHit(trade, "TP3", price), "tp3_hit");
        continue;
      }

      const currentSL = trade.beHit ? trade.entry : trade.sl;
      const slHit = isLong ? price <= currentSL : price >= currentSL;
      if (slHit && !trade.closed) {
        const isBE = trade.tp1Hit;
        if (isBE) {
          await db.update(activeTrades).set({ beHit: true, beHitAt: new Date(), closed: true }).where(eq(activeTrades.id, trade.id));
          await sendTelegram(formatBEHit(trade, price), "be_hit");
        } else {
          await db.update(activeTrades).set({ slHit: true, slHitAt: new Date(), closed: true }).where(eq(activeTrades.id, trade.id));
          await sendTelegram(formatSLHit(trade, price), "sl_hit");
        }
      }
    }
  } catch (err) { console.error("[Bot] trackActiveTrades error:", err); }
}

export async function expireStaleSetups(price: number) {
  try {
    const setups = await db.select().from(activeSetups);
    for (const setup of setups) {
      const isLong = setup.direction.includes("LONG");
      const ageMs = Date.now() - new Date(setup.detectedAt).getTime();
      const slBreached = isLong ? price <= setup.sl : price >= setup.sl;
      const tooOld = ageMs > SETUP_MAX_AGE_MS;

      if (slBreached || tooOld) {
        const reason = slBreached ? "Price hit SL" : "Market-entry signal expired (5m)";
        const arrow = isLong ? "🟢" : "🔴";
        const gracePeriod = 5 * 60 * 1000;
        const isWithinGrace = slBreached && ageMs < gracePeriod;

        if (tooOld || (slBreached && !isWithinGrace)) {
          await db.delete(activeSetups).where(eq(activeSetups.id, setup.id));
          breachNotifiedSetups.delete(setup.id);
          const cancelMsg = slBreached
            ? `<b>⚠️ SMC SETUP STOPPED OUT</b>\nEntry: $${setup.entry.toFixed(2)}\nSL: $${setup.sl.toFixed(2)}\nPrice: $${price.toFixed(2)}`
            : `<b>⚠️ SMC SETUP CANCELLED</b>\n${arrow} ${setup.direction} @ $${setup.entry.toFixed(2)}\nReason: ${reason}`;
          await sendTelegram(cancelMsg, "setup_cancelled");
        } else if (slBreached && isWithinGrace && !breachNotifiedSetups.has(setup.id)) {
          await sendTelegram(`<b>⚠️ SMC MARKET SIGNAL STOPPED OUT</b>\n${arrow} ${setup.direction} @ $${setup.entry.toFixed(2)}\nSL: $${setup.sl.toFixed(2)}\n<b>If you entered at market, reply "IN" to track.</b>`, "setup_warning");
          breachNotifiedSetups.add(setup.id);
        }
      }
    }
  } catch (err) { console.error("[Bot] expireStaleSetups error:", err); }
}

async function getTradeConstraints(): Promise<{ blockedDirections: Set<string>; blockedZoneKeys: Set<string> }> {
  let openTrades: any[] = [];
  let pendingSetups: any[] = [];
  let allTodayTrades: any[] = [];

  try { openTrades = await db.select().from(activeTrades).where(eq(activeTrades.closed, false)); } catch {}
  try { pendingSetups = await db.select().from(activeSetups); } catch {}

  const today = new Date(); today.setHours(0, 0, 0, 0);
  try { allTodayTrades = await db.select().from(activeTrades).where(gte(activeTrades.confirmedAt, today)); } catch {}

  const blockedZoneKeys = new Set<string>();

  for (const t of openTrades) {
    blockedZoneKeys.add(t.zone);
  }
  for (const s of pendingSetups) { blockedZoneKeys.add(s.zoneKey); blockedZoneKeys.add(s.zoneLabel); }

  // Same-direction stacking is intentional: each distinct 30M order block may
  // produce its own setup. Duplicate zones remain blocked above.
  const blockedDirections = new Set<string>();

  return { blockedDirections, blockedZoneKeys } as const;
}

// ═══════════════════════════════════════════════════════════════════════════════
// TELEGRAM COMMANDS
// ═══════════════════════════════════════════════════════════════════════════════

let lastUpdateId = 0;

export async function handleTelegramUpdates() {
  if (!TOKEN || !CHAT_ID) return;
  try {
    const resp = await fetch(`https://api.telegram.org/bot${TOKEN}/getUpdates?offset=${lastUpdateId + 1}`, { signal: AbortSignal.timeout(8000) });
    if (resp.status !== 200) return;
    const j = await resp.json() as { result?: Array<{ update_id: number; message?: { chat?: { id: number }; text?: string; message_id?: number } }> };
    const updates = j?.result ?? [];
    for (const u of updates) {
      if (u.update_id <= lastUpdateId) continue;
      lastUpdateId = u.update_id;

      // Fire-and-forget command handling: each update is processed in its own
      // promise so a slow handler (e.g. ALIVE waiting on price providers) never
      // delays the handling of subsequent updates in this poll window.
      void (async () => {
        // Only handle messages from the configured chat
        const chatId = u.message?.chat?.id;
        if (String(chatId) !== String(CHAT_ID)) return;

        const raw = u.message?.text?.trim();
        if (!raw) return;
        const text = raw.toUpperCase();

        const isConfirm = (text === "IN" || text.startsWith("IN ") || text.includes("I'M IN") || text.includes("IM IN"));

        if (text === "ALIVE") {
          // Fetch price concurrently so the ALIVE reply is never held up by slow
          // price providers; fall back to the last known tick if it fails.
          const pricePromise = fetchGoldData().catch(() => null);
          const openTrades = await db.select().from(activeTrades).where(eq(activeTrades.closed, false));
          const status = openTrades.length > 0 ? `${openTrades.length} active trade(s)` : "No active trades";
          const data = await pricePromise;
          const tick = data ?? getLastKnownPrice();
          const price = tick?.price || 0;
          const stale = tick && !data && isPriceTickStale();
          const priceLine = stale ? `XAU/USD: $${price.toFixed(2)} ⚠️ stale (last known)` : `XAU/USD: $${price.toFixed(2)}`;
          await sendTelegram(
          `<b>✅ Ricky Bot is ALIVE</b>
SMC Day Trading Mode
${priceLine}
${status}
Mode: Market Entry | 30M OB + 5M CHoCH Confirmation | 1H Confluence | Structural SL (8pt)
Expiry: 5 minutes | Manual Confirmation
Scan: Every minute`, "alive"
          );
          return;
        }

        if (text === "STATUS") { await handleStatusCommand(); return; }
        if (text === "CLOSE ALL") { await handleCloseAllCommand(); return; }

        if (isConfirm) {
          const match = text.match(/\d+/);
          const index = match ? parseInt(match[0]) - 1 : null;
          await handleConfirmedCommand(index);
          return;
        }
      })();
    }
  } catch (err) { console.error("[Bot] handleTelegramUpdates error:", err); }
}

async function handleStatusCommand() {
  const openTrades = await db.select().from(activeTrades).where(eq(activeTrades.closed, false));
  const data = await fetchGoldData();
  const tick = data ?? getLastKnownPrice();
  const price = tick?.price || 0;
  const stale = tick && !data && isPriceTickStale();
  const staleNote = stale ? "\n⚠️ Live price down — showing last known price (stale)" : "";
  if (price <= 0) { await sendTelegram(`<b>⚠️ Price unavailable</b>\nOpen: ${openTrades.length}`, "status"); return; }
  if (openTrades.length === 0) { await sendTelegram(`<b>📊 SMC Status</b>\nNo active trades\nXAU/USD: $${price.toFixed(2)}${staleNote}\nMode: 30M OB + 5M CHoCH Confirmation | 1H Confluence | Structural SL (8pt)`, "status"); return; }
  let statusMsg = `<b>📊 Active SMC Trades (${openTrades.length})</b>\nXAU/USD: $${price.toFixed(2)}${staleNote}\n`;
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
  if (openTrades.length === 0) { await sendTelegram("No active trades to close.", "close_all"); return; }
  await db.update(activeTrades).set({ closed: true }).where(eq(activeTrades.closed, false));
  await sendTelegram(`<b>🔴 Manually closed ${openTrades.length} trade(s)</b>\nAll positions closed.`, "close_all");
}

async function handleConfirmedCommand(index: number | null) {
  const setups = await db.select().from(activeSetups).orderBy(desc(activeSetups.detectedAt));
  if (setups.length === 0) { await sendTelegram("No pending setups.", "confirmed"); return; }
  let setupToConfirm: any = null;
  if (index !== null) { setupToConfirm = setups[index]; }
  else {
    if (lastSignaledSetupId) {
      setupToConfirm = setups.find(s => s.id === lastSignaledSetupId);
      if (Date.now() - lastSignaledAt > 5 * 60 * 1000) setupToConfirm = setups[0];
    }
    if (!setupToConfirm) setupToConfirm = setups[0];
  }
  if (!setupToConfirm) { await sendTelegram("No setup found.", "confirmed"); return; }
  await confirmSetup(setupToConfirm.id);
}

async function confirmSetup(setupId: number) {
  const [setup] = await db.select().from(activeSetups).where(eq(activeSetups.id, setupId)).limit(1);
  if (!setup) return;
  const ageMs = Date.now() - new Date(setup.detectedAt).getTime();
  if (ageMs > SETUP_MAX_AGE_MS) {
    await db.delete(activeSetups).where(eq(activeSetups.id, setupId));
    await sendTelegram("<b>⚠️ MARKET SIGNAL EXPIRED</b>\nThis setup was older than 5 minutes. Wait for the next signal.", "setup_expired");
    return;
  }

  // Use a fresh quote so a manual confirmation tracks the actual market
  // execution price rather than the price in a stale Telegram message.
  // Retry a few times over a short window to ride out a transient outage
  // before giving up, so a slow-but-working provider doesn't cost a trade.
  let livePrice = await fetchGoldData();
  if (!livePrice) {
    for (let i = 0; i < 3; i++) {
      await new Promise(r => setTimeout(r, 2000));
      livePrice = await fetchGoldData();
      if (livePrice) break;
    }
  }
  if (!livePrice) {
    const lastTick = getLastKnownPrice();
    const priceNote = lastTick ? `\nLast known price: $${lastTick.price.toFixed(2)}` : "";
    await sendTelegram(`<b>⚠️ MARKET ENTRY NOT CONFIRMED</b>\nLive price is unavailable after retries.${priceNote}\nTry again in 1 minute.`, "confirmed");
    return;
  }
  const entry = setup.direction.includes("LONG") ? livePrice.ask : livePrice.bid;
  const slDistance = Math.abs(entry - setup.sl);
  if (slDistance <= 0) {
    await sendTelegram("<b>⚠️ MARKET ENTRY NOT CONFIRMED</b>\nInvalid live risk distance. Wait for the next signal.", "confirmed");
    return;
  }
  const { tp1, tp2, tp3 } = calculateSMCTP(entry, setup.direction as "LONG" | "SHORT", slDistance, {
    trend: "neutral", lastSwingHigh: 0, lastSwingLow: 0, structure: "choppy",
    swingPoints: [], isRanging: false, rangeWidth: 0,
  });
  const tradeId = `trade_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  await db.insert(activeTrades).values({
    tradeId, direction: setup.direction, zone: setup.zoneLabel, zoneTier: setup.zoneTier,
    entry, sl: setup.sl, slDistance,
    tp1, tp2, tp3,
  });
  await db.delete(activeSetups).where(eq(activeSetups.id, setupId));
  const arrow = setup.direction.includes("LONG") ? "🟢" : "🔴";
  const msg = `<b>✅ SMC TRADE CONFIRMED</b>
${arrow} ${setup.direction} MARKET @ $${entry.toFixed(2)}
Zone: ${setup.zoneLabel}
SL: $${setup.sl.toFixed(2)} | TP1: $${tp1.toFixed(2)} | TP2: $${tp2.toFixed(2)} | TP3: $${tp3.toFixed(2)}
Monitoring active.`;
  await sendTelegram(msg, "confirmed");
}

// ═══════════════════════════════════════════════════════════════════════════════
// AUTO-SCAN & MONITORING LOOPS
// ═══════════════════════════════════════════════════════════════════════════════

let autoScanInterval: ReturnType<typeof setInterval> | null = null;
const AUTO_SCAN_INTERVAL_MS = 60 * 1000;

export function startAutoScan() {
  if (autoScanInterval) return;
  console.log("[Bot] Starting SMC auto-scan (1-min) — Market Entry, 30M OB + 5M CHoCH, 1H Confluence, 8pt Structural SL");
  (async () => {
    try {
      const priceData = await fetchGoldData();
      if (priceData) await scanSMCZones(priceData);
    } catch (e) { console.error("[Bot] Auto-scan startup error:", e); }
  })();
  autoScanInterval = setInterval(async () => {
    try {
      const priceData = await fetchGoldData();
      if (priceData) await scanSMCZones(priceData);
    } catch (e) { console.error("[Bot] Auto-scan error:", e); }
  }, AUTO_SCAN_INTERVAL_MS);
}

export function stopAutoScan() {
  if (autoScanInterval) { clearInterval(autoScanInterval); autoScanInterval = null; console.log("[Bot] Stopped auto-scan"); }
}

let tradeMonitorInterval: ReturnType<typeof setInterval> | null = null;
export function startTradeMonitoring() {
  if (tradeMonitorInterval) return;
  console.log("[Bot] Starting trade monitor (5s)");
  tradeMonitorInterval = setInterval(async () => {
    try {
      const priceData = await fetchGoldData();
      // Use last known tick when the live fetch fails: skipping TP/SL monitoring
      // entirely would leave open trades unprotected during price outages.
      const tick = priceData ?? getLastKnownPrice();
      if (tick) { await trackActiveTrades(tick.price); await expireStaleSetups(tick.price); }
    } catch (e) { console.log("[Bot] Trade monitor error:", e); }
  }, 5000);
}

export function stopTradeMonitoring() {
  if (tradeMonitorInterval) { clearInterval(tradeMonitorInterval); tradeMonitorInterval = null; console.log("[Bot] Stopped trade monitor"); }
}

let pollingInterval: ReturnType<typeof setInterval> | null = null;
export function startTelegramPolling() {
  if (pollingInterval) return;
  console.log("[Bot] Starting Telegram polling (15s)");
  pollingInterval = setInterval(async () => { await handleTelegramUpdates(); }, POLL_INTERVAL);
}

export function stopTelegramPolling() {
  if (pollingInterval) { clearInterval(pollingInterval); pollingInterval = null; console.log("[Bot] Stopped Telegram polling"); }
}
