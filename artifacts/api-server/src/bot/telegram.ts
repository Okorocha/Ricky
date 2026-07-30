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

// ── Key Levels ──────────────────────────────────────────────────────────────
const LEVELS: Record<string, { price: number; label: string; tier: string }> = {
  s1: { price: 3960.00, label: "Monthly Low / Major Support", tier: "major" },
  s2: { price: 4000.00, label: "Psychological $4000", tier: "major" },
  s3: { price: 4017.00, label: "Previous Week Low", tier: "key" },
  s4: { price: 4021.00, label: "Triangle Floor", tier: "major" },
  s5: { price: 4027.00, label: "Demand Zone", tier: "key" },
  s6: { price: 4035.00, label: "Intraday Support", tier: "minor" },
  s7: { price: 4040.00, label: "Session Support", tier: "minor" },
  s8: { price: 4046.00, label: "Mid-Range Support", tier: "minor" },
  r1: { price: 4055.00, label: "VWAP / Mid-Resistance", tier: "minor" },
  r2: { price: 4063.00, label: "50 EMA (1H)", tier: "minor" },
  r3: { price: 4070.00, label: "50 EMA (4H)", tier: "key" },
  r4: { price: 4077.00, label: "200 EMA (4H)", tier: "key" },
  r5: { price: 4080.00, label: "Triangle Ceiling", tier: "major" },
  r6: { price: 4099.00, label: "R1 Pivot", tier: "major" },
  r7: { price: 4110.00, label: "Session High Zone", tier: "minor" },
  r8: { price: 4120.00, label: "Intraday High", tier: "key" },
  r9: { price: 4130.00, label: "Weekly High Resistance", tier: "major" },
  r10: { price: 4166.00, label: "Weekly High", tier: "major" },
};

function getZoneThreshold(tier: string): { entering: number; atLevel: number; sweep: number } {
  switch (tier) {
    case "major": return { entering: 10.0, atLevel: 3.0, sweep: 1.5 };
    case "key":   return { entering: 8.0,  atLevel: 2.5, sweep: 1.2 };
    default:      return { entering: 6.0,  atLevel: 2.0, sweep: 1.0 };
  }
}

function getHTFBias(price: number): "bullish" | "bearish" | "neutral" {
  let above = 0, below = 0;
  for (const [, info] of Object.entries(LEVELS)) {
    if (info.tier === "minor") continue;
    if (price > info.price) above++;
    else below++;
  }
  const total = above + below;
  if (total === 0) return "neutral";
  const ratio = above / total;
  if (ratio >= 0.65) return "bullish";
  if (ratio <= 0.35) return "bearish";
  return "neutral";
}

// ── Candlestick / Price-action confirmation ──────────────────────────────────
type CandlePattern = "pin_bar" | "engulfing" | "rejection" | "momentum" | "weak";

interface CandleSignal {
  pattern: CandlePattern;
  strength: "strong" | "moderate" | "weak";
  confirmed: boolean;
}

function detectCandleSignal(
  price: number,
  spread: number,
  zoneDist: number,
  zoneStatus: string,
  direction: "LONG" | "SHORT"
): CandleSignal {
  const ctx = getPriceContext();

  const spreadActive   = spread > 2.0;
  const spreadModerate = spread >= 1.0 && spread <= 2.0;
  const spreadQuiet    = spread < 1.0;

  const veryClose   = zoneDist <= 1.5;
  const closeToZone = zoneDist <= 3.5;

  const isLong = direction === "LONG";
  const velocityReverts = isLong
    ? ctx.velocity > 0.05
    : ctx.velocity < -0.05;
  const strongMomentum = Math.abs(ctx.velocity) > 0.15 && ctx.consistent;

  if (zoneStatus === "SWEEP") {
    if (spreadActive && veryClose && velocityReverts)
      return { pattern: "pin_bar", strength: "strong", confirmed: true };
    if ((spreadActive || spreadModerate) && closeToZone)
      return { pattern: "rejection", strength: "moderate", confirmed: true };
    return { pattern: "rejection", strength: "moderate", confirmed: true };
  }

  if (zoneStatus === "AT_LEVEL") {
    if (spreadActive && veryClose && velocityReverts)
      return { pattern: "engulfing", strength: "strong", confirmed: true };
    if (spreadActive && closeToZone && strongMomentum)
      return { pattern: "momentum", strength: "strong", confirmed: true };
    if (spreadActive && closeToZone)
      return { pattern: "momentum", strength: "moderate", confirmed: true };
    if (spreadModerate && closeToZone && velocityReverts)
      return { pattern: "pin_bar", strength: "moderate", confirmed: true };
    if (spreadModerate && closeToZone)
      return { pattern: "rejection", strength: "moderate", confirmed: true };
    if (spreadModerate)
      return { pattern: "rejection", strength: "moderate", confirmed: true };
    if (spreadQuiet && veryClose && velocityReverts)
      return { pattern: "pin_bar", strength: "weak", confirmed: true };
    return { pattern: "weak", strength: "weak", confirmed: false };
  }

  // ENTERING zone
  if (strongMomentum && closeToZone && velocityReverts)
    return { pattern: "momentum", strength: "strong", confirmed: true };
  if (spreadActive && closeToZone)
    return { pattern: "momentum", strength: "strong", confirmed: true };
  if (spreadModerate && closeToZone && velocityReverts)
    return { pattern: "momentum", strength: "moderate", confirmed: true };
  if (spreadModerate && closeToZone)
    return { pattern: "momentum", strength: "moderate", confirmed: true };
  // Quiet spread at close range: still a valid setup, just weak strength
  if (spreadQuiet && closeToZone)
    return { pattern: "momentum", strength: "weak", confirmed: true };
  // Far from zone with quiet spread — not confirmed yet
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

  const htfBias = getHTFBias(price);
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
  if (hour >= 1 && hour < 7)   return { session: "Asian Session",       priority: "LOW",    note: "Lower liquidity, range-bound setups" };
  if (hour >= 8 && hour < 12)  return { session: "London Open",          priority: "HIGH",   note: "Best for breakouts and trend entries" };
  if (hour >= 13 && hour < 16) return { session: "London-NY Overlap",    priority: "BEST",   note: "Highest liquidity, strongest moves" };
  if (hour >= 16 && hour < 20) return { session: "NY Session",           priority: "HIGH",   note: "Strong momentum, good for follow-through" };
  return { session: "Late NY / Pre-Asian", priority: "MEDIUM", note: "Lower volume, range trades only" };
}

export function isNewsSafe(): { safe: boolean; message: string } {
  const now  = new Date();
  const day  = now.getUTCDay();
  const hour = now.getUTCHours();
  const date = now.getUTCDate();

  if (day === 3 && hour >= 17 && hour <= 19) return { safe: false, message: "Fed Decision Window — NO TRADES" };
  if (day === 5 && hour >= 13 && hour <= 15 && date <= 7) return { safe: false, message: "NFP Window — NO TRADES" };
  if (date >= 14 && date <= 16 && hour >= 13 && hour <= 15) return { safe: false, message: "CPI Window — CAUTION" };
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
    const j = await resp.json();
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
    const j = await resp.json();
    const price = parseFloat(j?.items?.[0]?.xauPrice);
    if (!price) throw new Error("no price");
    return { price, bid: price, ask: price + 0.5, spread: 0.5, source: "goldprice.org" };
  };

  const tryFrankfurter = async (): Promise<PriceData> => {
    const resp = await fetch(
      "https://api.frankfurter.app/latest?from=XAU&to=USD",
      { signal: AbortSignal.timeout(4000) }
    );
    if (resp.status !== 200) throw new Error("non-200");
    const j = await resp.json();
    const price = parseFloat(j?.rates?.USD);
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
  const arrow = direction.includes("LONG") ? "🟢" : "🔴";
  const isEntering = status === "ENTERING";
  const action = isEntering ? "SETUP FORMING" : "ENTER NOW";
  const urgency = isEntering ? "⚠️" : "🚨";
  const sessionShort = session.split(" ")[0];

  return `<b>${urgency} ${arrow} XAU/USD — ${action}</b>
<b>Direction:</b> ${arrow} ${direction} | ${sessionShort} (${priority})
<b>Zone:</b> ${zoneLabel}
<b>Entry:</b> $${entry.toFixed(2)} | <b>SL:</b> $${sl.toFixed(2)}
<b>TP1:</b> $${tp1.toFixed(2)} | <b>TP2:</b> $${tp2.toFixed(2)} | <b>TP3:</b> $${tp3.toFixed(2)}${isEntering ? "" : "\nReply <b>CONFIRMED</b> to track"}`;
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
function calculateLevels(
  direction: "LONG" | "SHORT",
  zonePrice: number,
  spread: number
): { entry: number; sl: number; slDistance: number; tp1: number; tp2: number; tp3: number } {
  const slBuffer = Math.max(spread * 2, 1.5);
  const isLong = direction === "LONG";

  const entry = isLong ? zonePrice + spread * 0.3 : zonePrice - spread * 0.3;
  const sl = isLong ? zonePrice - slBuffer : zonePrice + slBuffer;
  const slDistance = Math.abs(entry - sl);

  const tp1 = isLong ? entry + slDistance * 1.5 : entry - slDistance * 1.5;
  const tp2 = isLong ? entry + slDistance * 2.5 : entry - slDistance * 2.5;
  const tp3 = isLong ? entry + slDistance * 4.0 : entry - slDistance * 4.0;

  return { entry, sl, slDistance, tp1, tp2, tp3 };
}

// ── Scan Zones ───────────────────────────────────────────────────────────────
export async function scanZones(priceData: { price: number; bid: number; ask: number; spread: number; source: string }): Promise<ScanResult> {
  const price = priceData.price;
  const spread = priceData.spread;

  const { safe, message: newsMsg } = isNewsSafe();
  if (!safe) {
    console.log("[Bot] News blackout — skipping scan");
    return { setupFound: false, count: 0, reason: `News blackout — ${newsMsg}` };
  }

  const { blockedDirections, blockedZoneKeys } = await getTradeConstraints();
  const marketStructure = await analyzeMarketStructure(priceData);
  const { session, priority } = getSessionInfo();

  // Rejection counters for reporting
  let htfRejected = 0;
  let cooldownRejected = 0;
  let constraintRejected = 0;
  let candleRejected = 0;

  // Determine active zones near price
  const activeZones: Array<{
    key: string;
    label: string;
    tier: string;
    price: number;
    type: "LONG" | "SHORT";
    dist: number;
    status: string;
  }> = [];

  for (const [key, level] of Object.entries(LEVELS)) {
    const dist = Math.abs(price - level.price);
    const thresh = getZoneThreshold(level.tier);
    const isSupport = key.startsWith("s");
    const direction: "LONG" | "SHORT" = isSupport ? "LONG" : "SHORT";

    // Determine zone status
    let status: string | null = null;
    if (dist <= thresh.sweep) {
      status = "SWEEP";
    } else if (dist <= thresh.atLevel) {
      status = "AT_LEVEL";
    } else if (dist <= thresh.entering) {
      status = "ENTERING";
    }

    if (!status) continue;

    // HTF bias filter: only gate ENTERING setups — AT_LEVEL and SWEEP are
    // immediate price-action setups and should not be blocked by HTF bias.
    const htf = marketStructure.htfBias;
    if (htf !== "neutral" && status === "ENTERING") {
      if (direction === "LONG" && htf === "bearish") { htfRejected++; continue; }
      if (direction === "SHORT" && htf === "bullish") { htfRejected++; continue; }
    }

    activeZones.push({ key, label: level.label, tier: level.tier, price: level.price, type: direction, dist, status });
  }

  if (activeZones.length === 0) {
    const reason = htfRejected > 0
      ? "HTF bias mismatch — price not at a level aligned with trend"
      : "Price not at valid support/resistance";
    return { setupFound: false, count: 0, reason };
  }

  // Sort by distance (closest first)
  activeZones.sort((a, b) => a.dist - b.dist);

  const signalsToSave: Array<{ direction: string; zoneKey: string }> = [];

  for (const zone of activeZones) {
    if (isZoneOnCooldown(zone.key)) { cooldownRejected++; continue; }
    if (blockedZoneKeys.has(zone.key)) { constraintRejected++; continue; }

    const dir = zone.type.includes("LONG") ? "LONG" : "SHORT";
    if (blockedDirections.has(dir)) { constraintRejected++; continue; }

    const candle = detectCandleSignal(price, spread, zone.dist, zone.status, zone.type);
    if (!candle.confirmed) { candleRejected++; continue; }

    const { entry, sl, slDistance, tp1, tp2, tp3 } = calculateLevels(zone.type, zone.price, spread);

    const reasons: Record<string, string> = {
      "ENTERING": `Price entering ${zone.label} — ${candle.pattern} setup (${candle.strength})`,
      "AT_LEVEL": `Price AT ${zone.label} — ${candle.pattern} signal (${candle.strength})`,
      "SWEEP": `Liquidity sweep at ${zone.label} — reversal setup (${candle.strength})`,
    };

    const biasNote = marketStructure.htfBias !== "neutral"
      ? ` | HTF Bias: ${marketStructure.htfBias}`
      : "";
    const fullReason = (reasons[zone.status] || "Setup detected at key level.") + biasNote;

    signalsToSave.push({ direction: zone.type, zoneKey: zone.key });
    markZoneCooldown(zone.key);

    try {
      await db.insert(activeSetups).values({
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
        priority,
      });
      await db.insert(signals).values({
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
        session,
        priority,
        reason: fullReason,
        status: zone.status as "ENTERING" | "AT_LEVEL" | "SWEEP",
        zoneKey: zone.key,
      });
    } catch (err) {
      console.error("[Bot] DB insert error:", err);
    }

    const msg = formatSignal(zone.type, zone.label, zone.tier, entry, sl, slDistance, tp1, tp2, tp3, price, session, priority, fullReason, zone.status);
    await sendTelegram(msg, "signal");
  }

  // Direction shift alert
  if (signalsToSave.length > 0) {
    try {
      const lastTrade = await db.select().from(activeTrades).orderBy(desc(activeTrades.confirmedAt)).limit(1);
      if (lastTrade.length > 0) {
        const lastTradeDir = lastTrade[0]!.direction;
        const newDir = signalsToSave[0]!.direction;
        if (
          (lastTradeDir.includes("LONG") && newDir.includes("SHORT")) ||
          (lastTradeDir.includes("SHORT") && newDir.includes("LONG"))
        ) {
          await sendTelegram(
            `<b>⚠️ XAU/USD — DIRECTION SHIFT ALERT</b>\n━━━━━━━━━━━━━━━━━━━━\n<b>Last Trade:</b> ${lastTradeDir.includes("LONG") ? "🟢 LONG" : "🔴 SHORT"}\n<b>Now:</b> ${newDir.includes("LONG") ? "🟢 LONG" : "🔴 SHORT"} setup forming\n\n<b>Action:</b> If you are in the previous trade — CLOSE it now.\nDo NOT hold a losing trade into an opposing setup.`,
            "shift_alert"
          );
        }
      }
    } catch (err) {
      console.error("[Bot] Direction shift alert error:", err);
    }
  }

  // Build result
  if (signalsToSave.length === 0) {
    let reason = "No valid setup found";
    if (cooldownRejected > 0 && constraintRejected === 0 && candleRejected === 0 && htfRejected === 0)
      reason = "Zone recently scanned — cooldown active";
    else if (constraintRejected > 0 && candleRejected === 0 && htfRejected === 0)
      reason = "Existing trade already active at this zone";
    else if (candleRejected > 0 && htfRejected === 0)
      reason = "Weak confirmation candle — structure not complete";
    else if (htfRejected > 0 && candleRejected === 0)
      reason = "HTF bias mismatch — ENTERING setups filtered";
    else if (htfRejected > 0 || candleRejected > 0)
      reason = "Setup rejected — HTF bias mismatch or weak candle confirmation";
    return { setupFound: false, count: 0, reason };
  }

  return { setupFound: true, count: signalsToSave.length, reason: `${signalsToSave.length} setup(s) found` };
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

// ── Telegram Command Handler ────────────────────────────────────────────────
let lastUpdateId = 0;

export async function handleTelegramUpdates() {
  try {
    const resp = await fetch(
      `https://api.telegram.org/bot${TOKEN}/getUpdates?offset=${lastUpdateId + 1}&timeout=1`,
      { signal: AbortSignal.timeout(10000) }
    );
    if (resp.status !== 200) return;
    const data = await resp.json();
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

// ── Auto-Scan Loop (15-minute interval) ────────────────────────────────────
let autoScanInterval: ReturnType<typeof setInterval> | null = null;
const AUTO_SCAN_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

export function startAutoScan() {
  if (autoScanInterval) return;
  console.log("[Bot] Starting auto-scan loop (15-minute interval)");

  // Run an immediate scan on startup
  (async () => {
    try {
      const priceData = await fetchGoldData();
      if (priceData) await scanZones(priceData);
    } catch (e) {
      console.error("[Bot] Auto-scan startup error:", e);
    }
  })();

  autoScanInterval = setInterval(async () => {
    try {
      const priceData = await fetchGoldData();
      if (priceData) await scanZones(priceData);
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
