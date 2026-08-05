#!/usr/bin/env node
/**
 * XAUUSD SMC Strategy — 2-Week Realistic Backtest
 * Period: July 22 – August 5, 2026
 * Replicates the exact live strategy logic bar-by-bar.
 *
 * Trade management model (per signal):
 *   1/3 closed at TP1 (+1.5R each), SL → BE
 *   1/3 closed at TP2 (+2.5R each)
 *   1/3 closed at TP3 (+4.0R each)
 *   SL before TP1 → −1R full loss
 *   BE hit after TP1 but before TP2 → +0.5R (TP1 portion only)
 */

import { createRequire } from "module";
const require = createRequire(import.meta.url);

// ─────────────────────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────────────────────
const TWELVE_DATA_KEY = process.env.TWELVE_DATA_API_KEY || "";
const GLOBAL_COOLDOWN_MIN = 30;
const ZONE_COOLDOWN_MIN   = 15;
const SPREAD               = 0.30; // pts added to entry for Standard account

// ─────────────────────────────────────────────────────────────────────────────
// DATA FETCH  (Yahoo Finance — no API key required)
// Symbol: GC=F (Gold Futures, ~$0.5 premium vs spot — irrelevant for structure)
// ─────────────────────────────────────────────────────────────────────────────
async function fetchOHLC(interval) {
  // interval: "30m" | "1h"
  const yhInterval = interval === "30min" ? "30m" : "1h";
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/GC=F?interval=${yhInterval}&range=1mo`;
  const resp = await fetch(url, {
    signal: AbortSignal.timeout(15000),
    headers: { "User-Agent": "Mozilla/5.0" },
  });
  if (resp.status !== 200) throw new Error(`Yahoo Finance HTTP ${resp.status}`);
  const j = await resp.json();
  const result = j?.chart?.result?.[0];
  if (!result) throw new Error("Yahoo Finance: no data");
  const ts     = result.timestamp || [];
  const q      = result.indicators?.quote?.[0] || {};
  const opens  = q.open  || [];
  const highs  = q.high  || [];
  const lows   = q.low   || [];
  const closes = q.close || [];
  const candles = [];
  for (let i = 0; i < ts.length; i++) {
    const o = opens[i], h = highs[i], l = lows[i], c = closes[i];
    if (o == null || h == null || l == null || c == null) continue;
    candles.push({ time: ts[i] * 1000, open: o, high: h, low: l, close: c });
  }
  return candles.filter(c => c.high > 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// SESSION FILTER  (matches live bot exactly)
// ─────────────────────────────────────────────────────────────────────────────
function getSessionInfo(ts) {
  const d = new Date(ts);
  const h = d.getUTCHours();
  if (h >= 0  && h < 7)  return { session: "Asian",          priority: "MEDIUM" };
  if (h >= 7  && h < 12) return { session: "London",         priority: "HIGH"   };
  if (h >= 12 && h < 16) return { session: "London-NY",      priority: "HIGHEST"};
  if (h >= 16 && h < 21) return { session: "NY",             priority: "HIGH"   };
  return                        { session: "Dead Zone",       priority: "LOW"    };
}

// ─────────────────────────────────────────────────────────────────────────────
// NEWS FILTER  (matches live bot exactly)
// ─────────────────────────────────────────────────────────────────────────────
function isNewsSafe(ts) {
  const d = new Date(ts);
  const day  = d.getUTCDay();
  const hour = d.getUTCHours();
  const date = d.getUTCDate();
  if (day === 0 || day === 6)                      return { safe: false, reason: "Weekend" };
  if (day === 5 && hour >= 20)                     return { safe: false, reason: "Friday close" };
  if (day === 3 && hour >= 17 && hour <= 20)       return { safe: false, reason: "FOMC" };
  if (day === 5 && date <= 7 && hour >= 12 && hour <= 15) return { safe: false, reason: "NFP" };
  if (date >= 10 && date <= 16 && hour >= 12 && hour <= 14) return { safe: false, reason: "Inflation" };
  return { safe: true, reason: "" };
}

// ─────────────────────────────────────────────────────────────────────────────
// 30M STRUCTURE
// ─────────────────────────────────────────────────────────────────────────────
function analyze30MStructure(candles) {
  if (candles.length < 8) return { trend: "neutral", lastSwingHigh: 0, lastSwingLow: 0 };
  const recent  = candles.slice(-8);
  const lookback = 2;
  let swingHigh = -Infinity, swingLow = Infinity;

  for (let i = lookback; i < recent.length - lookback; i++) {
    const c = recent[i];
    const left  = recent.slice(i - lookback, i);
    const right = recent.slice(i + 1, i + lookback + 1);
    if (left.every(x => x.high <= c.high) && right.every(x => x.high <= c.high)) swingHigh = Math.max(swingHigh, c.high);
    if (left.every(x => x.low  >= c.low)  && right.every(x => x.low  >= c.low))  swingLow  = Math.min(swingLow,  c.low);
  }

  if (swingHigh > -Infinity || swingLow < Infinity) {
    const last = recent[recent.length - 1];
    const prev = recent[recent.length - 2];
    if (last.close > prev.close && last.close > swingLow + 2)  return { trend: "bullish", lastSwingHigh: swingHigh, lastSwingLow: swingLow };
    if (last.close < prev.close && last.close < swingHigh - 2) return { trend: "bearish", lastSwingHigh: swingHigh, lastSwingLow: swingLow };
  }

  // EMA fallback
  if (candles.length >= 20) {
    const closes = candles.slice(-20).map(c => c.close);
    const ema20  = closes.reduce((s, v) => s + v, 0) / closes.length;
    const last   = closes[closes.length - 1];
    if (last > ema20 * 1.001) return { trend: "bullish", lastSwingHigh: last + 5,  lastSwingLow: last - 10 };
    if (last < ema20 * 0.999) return { trend: "bearish", lastSwingHigh: last + 10, lastSwingLow: last - 5  };
  }

  return { trend: "neutral", lastSwingHigh: swingHigh > -Infinity ? swingHigh : 0, lastSwingLow: swingLow < Infinity ? swingLow : 0 };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1H STRUCTURE
// ─────────────────────────────────────────────────────────────────────────────
function analyze1HStructure(candles) {
  if (candles.length < 8) return { trend: "neutral" };
  const recent  = candles.slice(-8);
  const lookback = 2;
  let swingHigh = -Infinity, swingLow = Infinity;

  for (let i = lookback; i < recent.length - lookback; i++) {
    const c = recent[i];
    const left  = recent.slice(i - lookback, i);
    const right = recent.slice(i + 1, i + lookback + 1);
    if (left.every(x => x.high <= c.high) && right.every(x => x.high <= c.high)) swingHigh = Math.max(swingHigh, c.high);
    if (left.every(x => x.low  >= c.low)  && right.every(x => x.low  >= c.low))  swingLow  = Math.min(swingLow,  c.low);
  }

  if (swingHigh > -Infinity || swingLow < Infinity) {
    const last = recent[recent.length - 1];
    const prev = recent[recent.length - 2];
    if (last.close > prev.close && last.close > swingLow + 2)  return { trend: "bullish" };
    if (last.close < prev.close && last.close < swingHigh - 2) return { trend: "bearish" };
  }

  if (candles.length >= 12) {
    const closes = candles.slice(-12).map(c => c.close);
    const ema12  = closes.reduce((s, v) => s + v, 0) / closes.length;
    const last   = closes[closes.length - 1];
    if (last > ema12 * 1.001) return { trend: "bullish" };
    if (last < ema12 * 0.999) return { trend: "bearish" };
  }

  return { trend: "neutral" };
}

// ─────────────────────────────────────────────────────────────────────────────
// CHoCH
// ─────────────────────────────────────────────────────────────────────────────
function detectCHoCH(candles) {
  if (candles.length < 8) return { occurred: false };
  const recent = candles.slice(-8);
  let swingHigh = -Infinity, swingLow = Infinity;
  let swingHighIdx = -1, swingLowIdx = -1;

  for (let i = 0; i < Math.min(6, recent.length - 2); i++) {
    if (recent[i].high > swingHigh) { swingHigh = recent[i].high; swingHighIdx = i; }
    if (recent[i].low  < swingLow)  { swingLow  = recent[i].low;  swingLowIdx  = i; }
  }

  const last = recent[recent.length - 1];
  if (last.close > swingHigh && swingHighIdx >= 0) return { occurred: true, direction: "bullish" };
  if (last.close < swingLow  && swingLowIdx  >= 0) return { occurred: true, direction: "bearish" };
  return { occurred: false };
}

// ─────────────────────────────────────────────────────────────────────────────
// ORDER BLOCKS
// ─────────────────────────────────────────────────────────────────────────────
function detectOrderBlocks(candles, currentPrice) {
  const blocks = [];
  if (candles.length < 4) return blocks;
  const recent = candles.slice(-30);

  for (let i = recent.length - 4; i >= 0; i--) {
    const ob = recent[i];

    // Bullish OB
    if (i + 2 < recent.length) {
      const n1 = recent[i + 1], n2 = recent[i + 2];
      if (ob.close < ob.open && (n1.close - n1.open) > 1.5 && n2.close > n1.close) {
        const obLow    = Math.min(ob.low, n1.low);
        const distance = currentPrice - obLow;
        if (!( currentPrice < obLow) && distance > 2 && distance < 80) {
          blocks.push({ price: obLow, direction: "LONG", high: ob.high, low: obLow, distance, index: i });
        }
      }
    }

    // Bearish OB
    if (i + 2 < recent.length) {
      const n1 = recent[i + 1], n2 = recent[i + 2];
      if (ob.close > ob.open && (n1.open - n1.close) > 1.5 && n2.close < n1.close) {
        const obHigh   = Math.max(ob.high, n1.high);
        const distance = obHigh - currentPrice;
        if (!(currentPrice > obHigh) && distance > 2 && distance < 80) {
          blocks.push({ price: obHigh, direction: "SHORT", high: obHigh, low: ob.low, distance, index: i });
        }
      }
    }
  }
  return blocks;
}

// ─────────────────────────────────────────────────────────────────────────────
// SL / TP
// ─────────────────────────────────────────────────────────────────────────────
function calcSL(entry, direction, ob, structure30m) {
  const isLong = direction === "LONG";
  let sl;
  if (isLong) {
    const slBelowOB    = ob.low  - 2.0;
    const slBelowSwing = structure30m.lastSwingLow - 1.0;
    sl = Math.max(slBelowOB, slBelowSwing - 5.0);
  } else {
    const slAboveOB    = ob.high + 2.0;
    const slAboveSwing = structure30m.lastSwingHigh + 1.0;
    sl = Math.min(slAboveOB, slAboveSwing + 5.0);
  }
  const slDist   = Math.abs(entry - sl);
  const finalDist = Math.max(30, Math.min(Math.max(25, Math.min(slDist, 45)) + 5, 50));
  return { sl: isLong ? entry - finalDist : entry + finalDist, slDistance: finalDist };
}

function calcTP(entry, direction, slDistance) {
  const isLong = direction === "LONG";
  return {
    tp1: isLong ? entry + slDistance * 1.5 : entry - slDistance * 1.5,
    tp2: isLong ? entry + slDistance * 2.5 : entry - slDistance * 2.5,
    tp3: isLong ? entry + slDistance * 4.0 : entry - slDistance * 4.0,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SCAN ONE BAR
// ─────────────────────────────────────────────────────────────────────────────
function scanBar(idx, candles30m, candles1h, state) {
  if (idx < 30) return null;   // need enough history
  const bar     = candles30m[idx];
  const history = candles30m.slice(0, idx + 1);
  const price   = bar.close;
  const ts      = bar.time;

  // Session
  const { priority } = getSessionInfo(ts);
  if (priority === "LOW") return null;

  // News
  if (!isNewsSafe(ts).safe) return null;

  // Global cooldown
  if (state.lastSignalTime && (ts - state.lastSignalTime) < GLOBAL_COOLDOWN_MIN * 60 * 1000) return null;

  // 30M bias
  const s30 = analyze30MStructure(history);
  if (s30.trend === "neutral") return null;
  const bias = s30.trend; // "bullish" | "bearish"

  // 1H confluence — block only if opposite
  const h1_history = candles1h.filter(c => c.time <= ts);
  const s1h = h1_history.length >= 8 ? analyze1HStructure(h1_history) : { trend: "neutral" };
  const opposite = bias === "bullish" ? "bearish" : "bullish";
  if (s1h.trend === opposite) return null;

  // Order blocks
  const obs      = detectOrderBlocks(history, price);
  const validOBs = obs.filter(ob =>
    (bias === "bullish" && ob.direction === "LONG") ||
    (bias === "bearish" && ob.direction === "SHORT")
  );
  if (validOBs.length === 0) return null;
  validOBs.sort((a, b) => a.distance - b.distance);

  // Confirmation: CHoCH (A) or candle momentum (B)
  const choch = detectCHoCH(history);
  let confMode = "none", confQuality = "B";

  if (choch.occurred && choch.direction === bias) {
    confMode = "CHoCH"; confQuality = "A";
  } else if (history.length >= 3) {
    const r3 = history.slice(-3);
    const allDir = bias === "bullish"
      ? r3.every(c => c.close > c.open)
      : r3.every(c => c.close < c.open);
    const hasBig = r3.some(c => Math.abs(c.close - c.open) > 2);
    if (allDir && hasBig) { confMode = "momentum"; confQuality = "B"; }
  }

  if (confMode === "none") return null;

  // Evaluate OBs
  for (const ob of validOBs) {
    const zoneKey = `smc_${ob.direction.toLowerCase()}_${ob.index}`;
    if (state.zoneCooldowns.has(zoneKey)) {
      const lastZone = state.zoneCooldowns.get(zoneKey);
      if ((ts - lastZone) < ZONE_COOLDOWN_MIN * 60 * 1000) continue;
    }

    const minDist = confQuality === "B" ? 5  : 2;
    const maxDist = confQuality === "B" ? 20 : 30;
    if (ob.distance > maxDist || ob.distance < minDist) continue;

    const { sl, slDistance } = calcSL(ob.price, ob.direction, ob, s30);
    const isLong = ob.direction === "LONG";

    // SL already breached?
    if (isLong  && price <= sl) continue;
    if (!isLong && price >= sl) continue;

    // Too close to SL?
    const proxToSL = isLong ? (price - sl) : (sl - price);
    if (proxToSL < slDistance * 0.25) continue;

    const { tp1, tp2, tp3 } = calcTP(ob.price, ob.direction, slDistance);
    const entry = ob.price + (isLong ? SPREAD / 2 : -SPREAD / 2); // spread-adjusted entry

    state.lastSignalTime = ts;
    state.zoneCooldowns.set(zoneKey, ts);

    return {
      idx, ts, direction: ob.direction, entry, sl, slDistance, tp1, tp2, tp3,
      confMode, confQuality, bias, session: getSessionInfo(ts).session,
      date: new Date(ts).toISOString().slice(0, 16).replace("T", " "),
    };
  }

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// SIMULATE TRADE OUTCOME on subsequent candles
// ─────────────────────────────────────────────────────────────────────────────
function simulateTrade(signal, candles30m) {
  const { idx, direction, entry, sl, tp1, tp2, tp3 } = signal;
  const isLong = direction === "LONG";
  const future  = candles30m.slice(idx + 1, idx + 1 + 200); // max 200 bars (~7 days)

  let tp1Hit = false, tp2Hit = false, tp3Hit = false, slHit = false;
  let beSL    = sl;  // SL starts at original, moves to entry after TP1, TP1 after TP2
  let outcome = "open";
  let barsHeld = 0;

  for (const bar of future) {
    barsHeld++;
    const { high, low } = bar;

    if (!tp1Hit) {
      // Check SL and TP1 — if both hit same candle, conservative: SL wins
      const hitSL  = isLong ? low  <= beSL : high >= beSL;
      const hitTP1 = isLong ? high >= tp1  : low  <= tp1;

      if (hitSL && hitTP1) {
        // ambiguous: use open to decide
        if ((isLong && bar.open < tp1) || (!isLong && bar.open > tp1)) {
          // opened below TP1 (for long) — likely SL hit first if candle was bad
          slHit   = true;
          outcome = "SL";
          break;
        }
      }
      if (hitSL)  { slHit = true;  outcome = "SL";  break; }
      if (hitTP1) { tp1Hit = true; beSL = entry; /* SL → BE */ }
    }

    if (tp1Hit && !tp2Hit) {
      const hitBE  = isLong ? low  <= beSL : high >= beSL;
      const hitTP2 = isLong ? high >= tp2  : low  <= tp2;
      if (hitBE)  { outcome = "TP1_BE"; break; }
      if (hitTP2) { tp2Hit = true; beSL = tp1; /* SL → TP1 */ }
    }

    if (tp2Hit && !tp3Hit) {
      const hitTrail = isLong ? low  <= beSL : high >= beSL;
      const hitTP3   = isLong ? high >= tp3  : low  <= tp3;
      if (hitTrail) { outcome = "TP2_TRAIL"; break; }
      if (hitTP3)   { tp3Hit = true; outcome = "TP3"; break; }
    }
  }

  if (outcome === "open") outcome = tp2Hit ? "TP2_TRAIL" : tp1Hit ? "TP1_BE" : "timeout";

  // R calculation (1/3 per TP)
  let R = 0;
  if      (outcome === "SL")        R = -1.0;
  else if (outcome === "TP1_BE")    R = 1.5 * (1/3);                       // only 1st third
  else if (outcome === "TP2_TRAIL") R = 1.5 * (1/3) + 2.5 * (1/3);       // 1st + 2nd thirds, 3rd at TP1 trail = TP1*1/3
  else if (outcome === "TP3")       R = 1.5 * (1/3) + 2.5 * (1/3) + 4.0 * (1/3);
  else if (outcome === "timeout")   R = -0.2; // unrealised, close at scratch

  return { ...signal, outcome, R: parseFloat(R.toFixed(3)), barsHeld, tp1Hit, tp2Hit, tp3Hit, slHit };
}

// ─────────────────────────────────────────────────────────────────────────────
// REPORT
// ─────────────────────────────────────────────────────────────────────────────
function printReport(trades, scanCount) {
  const total    = trades.length;
  const wins     = trades.filter(t => t.R > 0).length;
  const losses   = trades.filter(t => t.outcome === "SL").length;
  const be       = trades.filter(t => t.outcome === "TP1_BE").length;
  const tp3s     = trades.filter(t => t.outcome === "TP3").length;
  const tp2s     = trades.filter(t => t.outcome === "TP2_TRAIL").length;
  const totalR   = trades.reduce((s, t) => s + t.R, 0);
  const winRate  = total ? ((wins / total) * 100).toFixed(1) : "0";
  const avgR     = total ? (totalR / total).toFixed(3) : "0";
  const avgBars  = total ? Math.round(trades.reduce((s,t) => s + t.barsHeld, 0) / total) : 0;
  const chochTrades = trades.filter(t => t.confMode === "CHoCH").length;
  const momTrades   = trades.filter(t => t.confMode === "momentum").length;

  const sessionCounts = {};
  trades.forEach(t => { sessionCounts[t.session] = (sessionCounts[t.session] || 0) + 1; });

  console.log("\n══════════════════════════════════════════════════");
  console.log("  XAUUSD SMC STRATEGY — 2-WEEK BACKTEST REPORT");
  console.log("  Period: July 22 – August 5, 2026");
  console.log("══════════════════════════════════════════════════");
  console.log(`\n  Bars scanned:      ${scanCount}`);
  console.log(`  Signals fired:     ${total}`);
  console.log(`  Avg per day:       ${(total / 10).toFixed(1)} (10 trading days)`);
  console.log(`\n  Win rate:          ${winRate}%   (trades with R > 0)`);
  console.log(`  Total R:           ${totalR.toFixed(2)}R`);
  console.log(`  Avg R/trade:       ${avgR}R`);
  console.log(`  Avg bars held:     ${avgBars} × 30M = ~${Math.round(avgBars * 0.5)}h`);
  console.log(`\n  Outcomes:`);
  console.log(`    TP3 full (4R):   ${tp3s}`);
  console.log(`    TP2 trail:       ${tp2s}`);
  console.log(`    TP1 → BE exit:   ${be}`);
  console.log(`    SL hit:          ${losses}`);
  console.log(`\n  Confirmation:`);
  console.log(`    CHoCH  (A):      ${chochTrades}`);
  console.log(`    Momentum (B):    ${momTrades}`);
  console.log(`\n  By session:`);
  Object.entries(sessionCounts).sort((a,b) => b[1]-a[1]).forEach(([s, n]) => {
    console.log(`    ${s.padEnd(16)} ${n}`);
  });

  console.log("\n  ── Trade log ──────────────────────────────────");
  trades.forEach((t, i) => {
    const flag = t.R > 0 ? "✅" : t.outcome === "SL" ? "❌" : "➡️";
    console.log(`  ${String(i+1).padStart(2)}. ${t.date}  ${t.direction.padEnd(5)}  ${t.confMode.padEnd(8)}  ${t.outcome.padEnd(12)}  ${(t.R >= 0 ? "+" : "") + t.R}R  ${flag}`);
  });
  console.log("══════════════════════════════════════════════════\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  console.log("Fetching 2 weeks of XAU/USD OHLC data...");

  let candles30m, candles1h;
  try {
    [candles30m, candles1h] = await Promise.all([
      fetchOHLC("30min"),
      fetchOHLC("1h"),
    ]);
  } catch (e) {
    console.error("Failed to fetch data:", e.message);
    process.exit(1);
  }

  // Filter to last 14 calendar days
  const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000;
  candles30m = candles30m.filter(c => c.time >= cutoff);
  candles1h  = candles1h.filter(c => c.time >= cutoff);

  console.log(`Loaded ${candles30m.length} × 30M bars, ${candles1h.length} × 1H bars`);
  console.log("Running backtest...\n");

  const state = {
    lastSignalTime: 0,
    zoneCooldowns: new Map(),
  };

  const signals = [];
  let scanCount = 0;

  for (let i = 30; i < candles30m.length; i++) {
    scanCount++;
    const signal = scanBar(i, candles30m, candles1h, state);
    if (signal) signals.push(signal);
  }

  // Simulate outcomes
  const trades = signals.map(s => simulateTrade(s, candles30m));

  printReport(trades, scanCount);
}

main().catch(e => { console.error(e); process.exit(1); });
