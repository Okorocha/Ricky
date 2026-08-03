import * as fs from 'fs';
import { 
    OHLCCandle, 
    getRegimeParams, 
    getTrendBias, 
    scaleThreshold, 
    dynamicSLFloor, 
    dynamicRRTargets,
    RegimeParams
} from '../../artifacts/api-server/src/bot/regime';

const INITIAL_BALANCE = 10000;
const SPREAD = 0.5;
const LOT_SIZE = 10;

interface Trade {
    id: number;
    direction: "LONG" | "SHORT";
    entryPrice: number;
    entryTime: number;
    sl: number;
    tp1: number;
    tp2: number;
    tp3: number;
    tp1Hit: boolean;
    tp2Hit: boolean;
    slHit: boolean;
    closed: boolean;
    exitPrice?: number;
    exitTime?: number;
    zone: string;
}

function getZoneThreshold(tier: string, regime: RegimeParams) {
    const base: Record<string, { entering: number; atLevel: number; sweep: number }> = {
        major: { entering: 10.0, atLevel: 3.0, sweep: 1.5 },
        key:   { entering: 8.0,  atLevel: 2.5, sweep: 1.2 },
    };
    const def = base[tier] ?? { entering: 6.0, atLevel: 2.0, sweep: 1.0 };
    return {
        entering:  scaleThreshold(def.entering, regime),
        atLevel:   scaleThreshold(def.atLevel, regime),
        sweep:     scaleThreshold(def.sweep, regime),
    };
}

function detectCandleSignal(
    price: number,
    zoneDist: number,
    zoneStatus: string,
    direction: "LONG" | "SHORT",
    candles: OHLCCandle[],
    regime: RegimeParams
): { confirmed: boolean; pattern: string; strength: string } {
    const isLong = direction === "LONG";
    if (candles.length < 3) return { confirmed: false, pattern: "none", strength: "weak" };
    
    const recent = candles.slice(-6);
    const last = recent[recent.length - 1];
    const prev = recent[recent.length - 2];
    const body = Math.abs(last.close - last.open);
    const range = last.high - last.low;
    const upperWick = last.high - Math.max(last.open, last.close);
    const lowerWick = Math.min(last.open, last.close) - last.low;
    const bullishBar = last.close > last.open;
    const bearishBar = last.close < last.open;

    const minSignalRange = regime.atr * 0.7;
    const rangeConfirmed = range >= minSignalRange;
    const highConvictionBody = range > 0 && (body / range) >= 0.5;

    if (range > 0) {
        const wickRatio = isLong ? lowerWick / range : upperWick / range;
        const bodyRatio = body / range;
        if (wickRatio >= 0.55 && bodyRatio <= 0.35) {
            if ((isLong && bullishBar) || (!isLong && bearishBar)) return { confirmed: rangeConfirmed, pattern: "pin_bar", strength: "strong" };
        }
    }

    const prevBody = Math.abs(prev.close - prev.open);
    const prevBull = prev.close > prev.open;
    const engulfsBull = isLong && bullishBar && !prevBull && last.open <= prev.close && last.close >= prev.open;
    const engulfsBear = !isLong && bearishBar && prevBull && last.open >= prev.close && last.close <= prev.open;
    if ((engulfsBull || engulfsBear) && body >= prevBody * 1.1 && highConvictionBody) return { confirmed: rangeConfirmed, pattern: "engulfing", strength: "strong" };

    if (recent.length >= 3) {
        const last3 = recent.slice(-3);
        const allBull = last3[0].close > last3[0].open && last3[1].close > last3[1].open && last3[2].close > last3[2].open;
        const allBear = last3[0].close < last3[0].open && last3[1].close < last3[1].open && last3[2].close < last3[2].open;
        if ((isLong && allBull) || (!isLong && allBear) && highConvictionBody) return { confirmed: rangeConfirmed, pattern: "momentum", strength: "strong" };
    }

    return { confirmed: false, pattern: "weak", strength: "weak" };
}

function is15mCandleAligned(direction: "LONG" | "SHORT", candles: OHLCCandle[]): boolean {
    if (candles.length < 1) return true;
    const last = candles[candles.length - 1];
    const isBullish = last.close > last.open;
    return direction === "LONG" ? isBullish : !isBullish;
}

function getSessionInfo(time: number) {
    const hour = new Date(time).getUTCHours();
    if (hour >= 6 && hour < 20) return "Active";
    return "Dead";
}

function computePivots(prevDay: OHLCCandle) {
    const PP = (prevDay.high + prevDay.low + prevDay.close) / 3;
    return {
        pp: PP,
        r1: 2 * PP - prevDay.low,
        r2: PP + (prevDay.high - prevDay.low),
        s1: 2 * PP - prevDay.high,
    };
}

function detectSwings(candles: OHLCCandle[], lookback: number = 3) {
    const highs: number[] = [];
    const lows: number[] = [];
    for (let i = lookback; i < candles.length - lookback; i++) {
        const c = candles[i];
        const left = candles.slice(i - lookback, i);
        const right = candles.slice(i + 1, i + lookback + 1);
        if (left.every(x => x.high <= c.high) && right.every(x => x.high <= c.high)) highs.push(c.high);
        if (left.every(x => x.low >= c.low) && right.every(x => x.low >= c.low)) lows.push(c.low);
    }
    const dedup = (arr: number[]) => arr.filter((v, i, a) => !a.slice(0, i).some(u => Math.abs(u - v) < 2));
    return { highs: dedup(highs).slice(-3), lows: dedup(lows).slice(-3) };
}

async function run() {
    const data = JSON.parse(fs.readFileSync('/home/ubuntu/Ricky/historical_data.json', 'utf8'));
    const candles1m: OHLCCandle[] = data['1m'];
    const candles5m: OHLCCandle[] = data['5m'];
    const candles15m: OHLCCandle[] = data['15m'];
    const candles1h: OHLCCandle[] = data['1h'];
    const candles1d: OHLCCandle[] = data['1d'];

    let balance = INITIAL_BALANCE;
    let peakBalance = INITIAL_BALANCE;
    let maxDrawdown = 0;
    const trades: Trade[] = [];
    let nextTradeId = 1;
    const LEVELS: Record<string, { price: number; label: string; tier: string }> = {};

    console.log(`Running high-precision backtest (1m candles) on ${candles1m.length} candles...`);

    for (let i = 100; i < candles1m.length; i++) {
        const currentCandle = candles1m[i];
        const currentTime = currentCandle.time;
        const currentPrice = currentCandle.close;

        if (balance > peakBalance) peakBalance = balance;
        const drawdown = (peakBalance - balance) / peakBalance;
        if (drawdown > maxDrawdown) maxDrawdown = drawdown;

        // Update levels periodically
        if (i % 240 === 0 || i === 100) {
            const dayIdx = candles1d.findIndex(c => c.time > currentTime) - 1;
            if (dayIdx >= 0) {
                const pivots = computePivots(candles1d[dayIdx]);
                LEVELS['pp'] = { price: pivots.pp, label: "Pivot", tier: "major" };
                LEVELS['r1'] = { price: pivots.r1, label: "R1", tier: "key" };
                LEVELS['s1'] = { price: pivots.s1, label: "S1", tier: "key" };
            }
            const hourIdx = candles1h.findIndex(c => c.time > currentTime);
            const recentH1 = candles1h.slice(Math.max(0, hourIdx - 50), hourIdx);
            const swings = detectSwings(recentH1);
            swings.highs.forEach((h, idx) => LEVELS[`sh${idx}`] = { price: h, label: `H1 High ${idx}`, tier: "major" });
            swings.lows.forEach((l, idx) => LEVELS[`sl${idx}`] = { price: l, label: `H1 Low ${idx}`, tier: "major" });
        }

        for (const trade of trades.filter(t => !t.closed)) {
            const isLong = trade.direction === "LONG";
            if ((isLong && currentCandle.low <= trade.sl) || (!isLong && currentCandle.high >= trade.sl)) {
                trade.closed = true;
                trade.slHit = true;
                trade.exitPrice = trade.sl;
                trade.exitTime = currentTime;
                balance += (isLong ? (trade.exitPrice - trade.entryPrice) : (trade.entryPrice - trade.exitPrice)) * LOT_SIZE;
                continue;
            }
            if (!trade.tp1Hit) {
                if ((isLong && currentCandle.high >= trade.tp1) || (!isLong && currentCandle.low <= trade.tp1)) {
                    trade.tp1Hit = true;
                    trade.sl = trade.entryPrice;
                }
            } else if (!trade.tp2Hit) {
                if ((isLong && currentCandle.high >= trade.tp2) || (!isLong && currentCandle.low <= trade.tp2)) {
                    trade.tp2Hit = true;
                    trade.sl = trade.tp1;
                }
            } else {
                if ((isLong && currentCandle.high >= trade.tp3) || (!isLong && currentCandle.low <= trade.tp3)) {
                    trade.closed = true;
                    trade.exitPrice = trade.tp3;
                    trade.exitTime = currentTime;
                    balance += (isLong ? (trade.exitPrice - trade.entryPrice) : (trade.entryPrice - trade.exitPrice)) * LOT_SIZE;
                }
            }
        }

        const activeTrade = trades.find(t => !t.closed);
        if (!activeTrade) {
            const session = getSessionInfo(currentTime);
            if (session === "Dead") continue;

            const m5Idx = candles5m.findIndex(c => c.time > currentTime);
            const recent5m = candles5m.slice(Math.max(0, m5Idx - 20), m5Idx);
            const hourIdx = candles1h.findIndex(c => c.time > currentTime);
            const recent1h = candles1h.slice(Math.max(0, hourIdx - 50), hourIdx);
            const m15Idx = candles15m.findIndex(c => c.time > currentTime);
            const recent15m = candles15m.slice(Math.max(0, m15Idx - 20), m15Idx);
            const recent1m = candles1m.slice(i - 10, i + 1);
            
            if (recent5m.length < 10 || recent1h.length < 10) continue;

            const regime = getRegimeParams(recent5m, recent1h);
            if (regime.noTrade) continue;

            const trend = getTrendBias(recent1h);

            for (const [key, info] of Object.entries(LEVELS)) {
                const dist = Math.abs(currentPrice - info.price);
                const thresh = getZoneThreshold(info.tier, regime);
                let status = "";
                if (dist <= thresh.sweep) status = "SWEEP";
                else if (dist <= thresh.atLevel) status = "AT_LEVEL";
                
                if (status) {
                    for (const dir of ["LONG", "SHORT"] as const) {
                        const isLong = dir === "LONG";
                        if (isLong && !trend.allowLong) continue;
                        if (!isLong && !trend.allowShort) continue;

                        const signal = detectCandleSignal(currentPrice, SPREAD, dist, status, dir, recent1m, regime);
                        if (signal.confirmed) {
                            const h1Aligned = (dir === "LONG" && trend.bias === "bullish") || (dir === "SHORT" && trend.bias === "bearish");
                            const isAsianSweep = key.includes("asian") && status === "SWEEP";
                            const isAPlus = isAsianSweep || (is15mCandleAligned(dir, recent15m) && h1Aligned);
                            
                            if (!isAPlus) continue;

                            const slDist = dynamicSLFloor(regime, key);
                            const entryPrice = isLong ? currentPrice + SPREAD/2 : currentPrice - SPREAD/2;
                            const sl = isLong ? entryPrice - slDist : entryPrice + slDist;
                            const tps = dynamicRRTargets(regime);
                            
                            trades.push({
                                id: nextTradeId++,
                                direction: dir,
                                entryPrice,
                                entryTime: currentTime,
                                sl,
                                tp1: isLong ? entryPrice + slDist * tps.tp1 : entryPrice - slDist * tps.tp1,
                                tp2: isLong ? entryPrice + slDist * tps.tp2 : entryPrice - slDist * tps.tp2,
                                tp3: isLong ? entryPrice + slDist * tps.tp3 : entryPrice - slDist * tps.tp3,
                                tp1Hit: false,
                                tp2Hit: false,
                                slHit: false,
                                closed: false,
                                zone: info.label
                            });
                            break;
                        }
                    }
                    if (trades.length > 0 && trades[trades.length-1].entryTime === currentTime) break;
                }
            }
        }
    }

    const completed = trades.filter(t => t.closed);
    const wins = completed.filter(t => !t.slHit);
    const profit = balance - INITIAL_BALANCE;

    console.log(`\nResults (High Precision 1m):`);
    console.log(`Total Trades:     ${trades.length}`);
    console.log(`Win Rate:         ${((wins.length / completed.length) * 100 || 0).toFixed(2)}%`);
    console.log(`Net Profit:      $${profit.toFixed(2)}`);
    console.log(`Max Drawdown:    ${(maxDrawdown * 100).toFixed(2)}%`);
}

run().catch(console.error);
