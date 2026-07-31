// ── Market Regime Engine ─────────────────────────────────────────────────────
// Adapts ALL bot parameters to current market conditions: ranging, trending, choppy.
//
// Gold regimes and typical ATR(14) on 5m:
//   Ranging:  $1.0 – $2.5  (tight candles, $2-4 range)
//   Normal:   $2.5 – $5.0  (moderate activity)
//   Trending: $5.0 – $12.0 (wide candles, $8-15 range)
//   Choppy:   ATR moderate but ADX low → avoid
//
// We use a 14-bar ATR on 5m candles + simple momentum/volatility ratio
// to classify the regime and produce a scaling multiplier for every parameter.

// OHLCCandle is defined here and re-exported by telegram.ts
type OHLCCandle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
};
export type { OHLCCandle };

export type MarketRegime = "ranging" | "normal" | "trending" | "choppy";

export interface RegimeParams {
  regime: MarketRegime;
  /** 14-bar ATR on 5m */
  atr: number;
  /** Multiplier: 1.0 = baseline, scaled to ATR. Used to multiply all distance thresholds. */
  scale: number;
  /** Directional strength 0–1. High = trending, low = ranging/choppy. */
  momentum: number;
  /** How aggressive to be. Higher = take more setups. */
  aggression: number;
  /** R:R ratio multiplier. In ranging, targets are tighter (1.0). In trending, wider (1.3+). */
  rrMultiplier: number;
  /** True if regime is too dangerous to trade at all. */
  noTrade: boolean;
  /** Human-readable description. */
  description: string;
}

// ── ATR Computation ──────────────────────────────────────────────────────────

function trueRange(prev: OHLCCandle | undefined, curr: OHLCCandle): number {
  if (!prev) return curr.high - curr.low;
  return Math.max(
    curr.high - curr.low,
    Math.abs(curr.high - prev.close),
    Math.abs(curr.low - prev.close)
  );
}

export function computeATR(candles: OHLCCandle[], period = 14): number {
  if (candles.length < period + 1) {
    // Fallback: simple average range
    const usable = candles.slice(-Math.max(candles.length - 1, 1));
    if (usable.length === 0) return 2.0; // default assumption
    const avgRange = usable.reduce((s, c) => s + (c.high - c.low), 0) / usable.length;
    return avgRange;
  }
  // Initial ATR = simple average of first `period` true ranges
  let trSum = 0;
  for (let i = 1; i <= period; i++) {
    trSum += trueRange(candles[i - 1], candles[i]!);
  }
  let atr = trSum / period;
  // Wilder's smoothing
  for (let i = period + 1; i < candles.length; i++) {
    const tr = trueRange(candles[i - 1], candles[i]!);
    atr = (atr * (period - 1) + tr) / period;
  }
  return atr;
}

// ── Simple ADX-like directional strength ─────────────────────────────────────

/** Returns a 0–1 score. ~0.3 = ranging, ~0.5 = normal, ~0.7+ = trending. */
function directionalStrength(candles: OHLCCandle[], period = 14): number {
  if (candles.length < period + 1) return 0.4; // default to "normal"

  let plusDM = 0, minusDM = 0, trSum = 0;
  for (let i = 1; i <= period; i++) {
    const prev = candles[i - 1]!;
    const curr = candles[i]!;
    const upMove = curr.high - prev.high;
    const downMove = prev.low - curr.low;
    plusDM += (upMove > downMove && upMove > 0) ? upMove : 0;
    minusDM += (downMove > upMove && downMove > 0) ? downMove : 0;
    trSum += trueRange(prev, curr);
  }

  if (trSum === 0) return 0.3;
  const plusDI = plusDM / trSum;
  const minusDI = minusDM / trSum;
  const diDiff = Math.abs(plusDI - minusDI);
  const diSum = plusDI + minusDI;
  if (diSum === 0) return 0.3;
  return diDiff / diSum; // This is essentially the first ADX reading
}

// ── Regime Classification ───────────────────────────────────────────────────

export function classifyRegime(
  candles5m: OHLCCandle[],
  candles1h: OHLCCandle[] = []
): MarketRegime {
  const atr = computeATR(candles5m);
  const strength = directionalStrength(candles5m);

  // Gold-specific ATR bands (5m timeframe):
  //   Ranging: ATR < 2.5 AND strength < 0.4
  //   Choppy:  strength < 0.3 (no clear direction even if ATR moderate)
  //   Trending: ATR > 5.0 AND strength > 0.5
  //   Normal: everything else

  if (strength < 0.3) {
    return "choppy";
  }
  if (atr < 2.5 && strength < 0.4) {
    return "ranging";
  }
  if (atr > 5.0 && strength > 0.5) {
    return "trending";
  }
  return "normal";
}

// ── Full Regime Parameter Computation ───────────────────────────────────────

export function getRegimeParams(
  candles5m: OHLCCandle[],
  candles1h: OHLCCandle[] = []
): RegimeParams {
  const atr = computeATR(candles5m);
  const strength = directionalStrength(candles5m);
  const regime = classifyRegime(candles5m, candles1h);

  // Scale factor: how much bigger are candles compared to "normal" baseline (ATR ~3.5 on Gold 5m)
  // Baseline ATR for Gold 5m is approximately $3.5
  const BASELINE_ATR = 3.5;
  const scale = Math.max(0.5, Math.min(3.0, atr / BASELINE_ATR));

  // Momentum score (0–1): combines ATR magnitude and directional strength
  const momentum = Math.min(1.0, strength * (atr / BASELINE_ATR) * 0.5 + strength * 0.5);

  // Aggression: how willing the bot should be to take setups
  // Choppy = very low (0.2), Ranging = moderate (0.6), Normal = high (0.8), Trending = high (0.9)
  let aggression: number;
  switch (regime) {
    case "choppy":  aggression = 0.2; break;
    case "ranging": aggression = 0.6; break;
    case "normal":  aggression = 0.85; break;
    case "trending": aggression = 0.95; break;
  }

  // R:R multiplier: in ranging markets, tight targets are fine (1.0x).
  // In trending, let winners run wider (1.3x). Choppy = don't even bother (but we still allow).
  let rrMultiplier: number;
  switch (regime) {
    case "choppy":  rrMultiplier = 1.2; break; // Need better R:R to survive noise
    case "ranging": rrMultiplier = 0.85; break; // Tight targets in ranges
    case "normal":  rrMultiplier = 1.0; break;
    case "trending": rrMultiplier = 1.4; break; // Wide targets in trends
  }

  // No-trade flag: choppy with very low ATR = death zone
  const noTrade = regime === "choppy" && atr < 1.5;

  // Description
  const descriptions: Record<MarketRegime, string> = {
    choppy:  `Choppy — ATR $${atr.toFixed(2)} | Avoid entries`,
    ranging: `Ranging — ATR $${atr.toFixed(2)} | Tight targets`,
    normal:  `Normal — ATR $${atr.toFixed(2)} | Standard params`,
    trending:`Trending — ATR $${atr.toFixed(2)} | Wide targets, let winners run`,
  };

  return {
    regime, atr, scale, momentum, aggression, rrMultiplier, noTrade,
    description: descriptions[regime],
  };
}

// ── Dynamic Threshold Helpers ───────────────────────────────────────────────

/**
 * Scale a hardcoded distance threshold to current market conditions.
 * Example: zone threshold of 3.0 pts → in trending (scale=2.0) becomes 6.0 pts.
 * The scale is clamped so it never goes below 0.6x or above 2.5x.
 */
export function scaleThreshold(base: number, regime: RegimeParams): number {
  return base * Math.max(0.6, Math.min(2.5, regime.scale));
}

/**
 * Dynamic SL floor based on regime + ATR.
 * In ranging: SL floor = ATR * 1.5 (tight, since candles are small)
 * In normal:  SL floor = ATR * 1.8
 * In trending: SL floor = ATR * 2.2 (need more room, swings are bigger)
 * In choppy:  SL floor = ATR * 2.5 (avoid getting chopped)
 *
 * Minimum absolute floor: 4.0 pts (never go below this).
 */
export function dynamicSLFloor(regime: RegimeParams, zoneKey: string): number {
  const absoluteFloor = 4.0; // Never below this even in tight ranging

  // Multiplier based on regime
  let multiplier: number;
  switch (regime.regime) {
    case "ranging":  multiplier = 1.5; break;
    case "normal":   multiplier = 1.8; break;
    case "trending": multiplier = 2.2; break;
    case "choppy":   multiplier = 2.5; break;
  }

  // Swing highs/lows and Asian levels are high-precision → allow tighter SL
  if (zoneKey.startsWith("sh") || zoneKey.startsWith("sl") || zoneKey.startsWith("asian")) {
    multiplier *= 0.85; // 15% tighter for precise levels
  }

  const atrBased = regime.atr * multiplier;
  return Math.max(absoluteFloor, atrBased);
}

/**
 * Dynamic spread filter.
 * In ranging: max spread = 1.5 pts (tight candles, wide spread = noise)
 * In trending: max spread = 3.0 pts (wider candles tolerate more spread)
 * Normal: 2.0 pts (current hardcoded value)
 */
export function dynamicSpreadMax(regime: RegimeParams): number {
  switch (regime.regime) {
    case "ranging":  return 1.5;
    case "normal":   return 2.0;
    case "trending": return 3.0;
    case "choppy":   return 1.5; // Choppy = picky
  }
}

/**
 * Dynamic R:R targets.
 * Base: 1.5 / 2.5 / 4.0
 * In ranging: 1.2 / 2.0 / 3.0  (tighter, quicker exits)
 * In trending: 1.8 / 3.0 / 5.0  (let winners run)
 */
export function dynamicRRTargets(regime: RegimeParams): { tp1: number; tp2: number; tp3: number } {
  const m = regime.rrMultiplier;
  return {
    tp1: +(1.5 * m).toFixed(2),
    tp2: +(2.5 * m).toFixed(2),
    tp3: +(4.0 * m).toFixed(2),
  };
}

/**
 * Dynamic velocity thresholds for candle-less fallback detection.
 * Scales based on ATR — faster markets need higher velocity to confirm.
 */
export function dynamicVelocityThresholds(regime: RegimeParams): {
  revertMin: number;   // Min velocity to count as "reversing"
  strongMomentum: number; // Min velocity for "strong momentum"
} {
  // Base thresholds (from original code: 0.05 revert, 0.15 strong)
  const BASE_REVERT = 0.05;
  const BASE_STRONG = 0.15;
  return {
    revertMin: BASE_REVERT * Math.max(0.6, Math.min(2.5, regime.scale)),
    strongMomentum: BASE_STRONG * Math.max(0.6, Math.min(2.5, regime.scale)),
  };
}

/**
 * Dynamic spread classification for candle-less fallback.
 * Original: 2.0 = active, 1.0-2.0 = moderate, <1.0 = quiet
 * Scales with ATR so "active" means the same relative volatility.
 */
export function dynamicSpreadBands(regime: RegimeParams): {
  active: number;   // Above this = active spread
  moderateMin: number; // This to active = moderate
} {
  // Original: active=2.0, moderate=1.0
  const BASE_ACTIVE = 2.0;
  const BASE_MODERATE = 1.0;
  const s = Math.max(0.6, Math.min(2.5, regime.scale));
  return {
    active: +(BASE_ACTIVE * s).toFixed(2),
    moderateMin: +(BASE_MODERATE * s).toFixed(2),
  };
}
