// ═══════════════════════════════════════════════════════════════════════════
// NEXUS Indicator Library — server-side (mirrors frontend formulas exactly)
// RSI · BB · MACD · ATR · VWAP · StochRSI · EMA Cross · ROC
// Regime Detection · Kelly Criterion · Confluence Scoring
// + Full Extended Library: 50+ indicators, market structure, order blocks
// ═══════════════════════════════════════════════════════════════════════════

'use strict';

// ─── Candle field accessors (handle both {open,high,low,close,volume} and {o,h,l,c,v}) ──
function O(c) { return c.open   ?? c.o; }
function H(c) { return c.high   ?? c.h; }
function L(c) { return c.low    ?? c.l; }
function C(c) { return c.close  ?? c.c; }
function V(c) { return c.volume ?? c.v; }

// ═══════════════════════════════════════════════════════════════════════════
// ORIGINAL FUNCTIONS (verbatim)
// ═══════════════════════════════════════════════════════════════════════════

// ─── Core math helpers ────────────────────────────────────────────────────

function calcEMAArr(data, period) {
  const k = 2 / (period + 1);
  const ema = [data[0]];
  for (let i = 1; i < data.length; i++) {
    ema.push(data[i] * k + ema[i - 1] * (1 - k));
  }
  return ema;
}

// ─── RSI (14) ─────────────────────────────────────────────────────────────
// Same formula as frontend calcRSI()

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

// ─── Bollinger Bands (20, 2) ──────────────────────────────────────────────

function calcBB(closes, period = 20, mult = 2) {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  const mid = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((a, b) => a + Math.pow(b - mid, 2), 0) / period;
  const std = Math.sqrt(variance);
  const upper = mid + mult * std;
  const lower = mid - mult * std;
  const last = closes[closes.length - 1];
  const pct = upper === lower ? 0.5 : (last - lower) / (upper - lower);
  const width = ((upper - lower) / mid) * 100;
  return { upper, mid, lower, pct, width };
}

// ─── MACD (12, 26, 9) ─────────────────────────────────────────────────────

function calcMACD(closes, fast = 12, slow = 26, signal = 9) {
  if (closes.length < slow + signal) return null;
  const fastEMA = calcEMAArr(closes, fast);
  const slowEMA = calcEMAArr(closes, slow);
  const macdLine = fastEMA.map((v, i) => v - slowEMA[i]);
  const signalLine = calcEMAArr(macdLine.slice(slow - 1), signal);
  const lastMACD = macdLine[macdLine.length - 1];
  const lastSignal = signalLine[signalLine.length - 1];
  return { macd: lastMACD, signal: lastSignal, hist: lastMACD - lastSignal };
}

// ─── ATR — Average True Range (14) ───────────────────────────────────────
// Key for: dynamic stop-loss placement, volatility regime, position sizing

function calcATR(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const trueRanges = [];
  for (let i = 1; i < candles.length; i++) {
    const high = candles[i].high;
    const low  = candles[i].low;
    const prevClose = candles[i - 1].close;
    trueRanges.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
  }
  // Wilder's smoothed ATR
  const initial = trueRanges.slice(0, period).reduce((a, b) => a + b, 0) / period;
  let atr = initial;
  for (let i = period; i < trueRanges.length; i++) {
    atr = (atr * (period - 1) + trueRanges[i]) / period;
  }
  const avgATR = trueRanges.slice(-period).reduce((a, b) => a + b, 0) / period;
  return {
    value: atr,
    avg: avgATR,
    ratio: atr / avgATR, // > 1.5 = elevated volatility
  };
}

// ─── VWAP — Volume Weighted Average Price ────────────────────────────────
// Institutional benchmark. Price above VWAP = bullish bias.
// Resets each session; here we use all available candles as session.

function calcVWAP(candles) {
  if (candles.length < 2) return null;
  let cumTPV = 0, cumVol = 0;
  const vwapArr = [];
  for (const c of candles) {
    const tp = (c.high + c.low + c.close) / 3;
    cumTPV += tp * c.volume;
    cumVol += c.volume;
    vwapArr.push(cumVol > 0 ? cumTPV / cumVol : c.close);
  }
  const vwap = vwapArr[vwapArr.length - 1];
  const last = candles[candles.length - 1].close;
  const devPct = ((last - vwap) / vwap) * 100;
  return { value: vwap, devPct, above: last > vwap };
}

// ─── Stochastic RSI ───────────────────────────────────────────────────────
// RSI of RSI — much more sensitive for overbought/oversold.
// Range 0–1. < 0.2 = oversold, > 0.8 = overbought.

function calcStochRSI(closes, rsiPeriod = 14, stochPeriod = 14) {
  if (closes.length < rsiPeriod + stochPeriod + 2) return null;
  // Build RSI history
  const rsiArr = [];
  for (let i = rsiPeriod; i <= closes.length - 1; i++) {
    rsiArr.push(calcRSI(closes.slice(0, i + 1), rsiPeriod));
  }
  if (rsiArr.length < stochPeriod) return null;
  const recent = rsiArr.slice(-stochPeriod);
  const lo = Math.min(...recent);
  const hi = Math.max(...recent);
  const last = rsiArr[rsiArr.length - 1];
  const stoch = hi === lo ? 0.5 : (last - lo) / (hi - lo);
  return { value: stoch, rsi: last };
}

// ─── EMA Cross (9/21) ─────────────────────────────────────────────────────
// Fast EMA above slow = uptrend. Cross = trend change.

function calcEMACross(closes, fast = 9, slow = 21) {
  if (closes.length < slow + 1) return null;
  const fastEMA = calcEMAArr(closes, fast);
  const slowEMA = calcEMAArr(closes, slow);
  const diff = fastEMA[fastEMA.length - 1] - slowEMA[slowEMA.length - 1];
  const prevDiff = fastEMA[fastEMA.length - 2] - slowEMA[slowEMA.length - 2];
  const crossedUp   = prevDiff <= 0 && diff > 0;
  const crossedDown = prevDiff >= 0 && diff < 0;
  return {
    diff,
    bullish: diff > 0,
    crossedUp,
    crossedDown,
    fastEMA: fastEMA[fastEMA.length - 1],
    slowEMA: slowEMA[slowEMA.length - 1],
  };
}

// ─── RSI Divergence ───────────────────────────────────────────────────────
// Compares price swing highs/lows vs RSI swing highs/lows over a lookback window.
// Regular bullish: price lower low + RSI higher low → reversal signal
// Regular bearish: price higher high + RSI lower high → reversal signal
// Hidden bullish: price higher low + RSI lower low → trend continuation up
// Hidden bearish: price lower high + RSI higher high → trend continuation down

function detectDivergence(closes, period = 14, lookback = 30) {
  const needed = period + lookback + 5;
  if (closes.length < needed) return null;

  // Build rolling RSI array for the lookback window
  const buf   = period + 5;
  const slice = closes.slice(-(lookback + buf));
  const rsiArr = [];
  for (let i = period; i < slice.length; i++) {
    rsiArr.push(calcRSI(slice.slice(0, i + 1), period));
  }

  // Align: priceWindow[i] ↔ rsiArr[i]
  const priceWindow = slice.slice(period);
  const n = Math.min(lookback, priceWindow.length);
  const prices = priceWindow.slice(-n);
  const rsis   = rsiArr.slice(-n);

  // Find local minima / maxima with a minimum separation distance
  function findSwings(arr, type, minDist = 3) {
    const swings = [];
    for (let i = 1; i < arr.length - 1; i++) {
      const isLow  = type === 'low'  && arr[i] <= arr[i-1] && arr[i] <= arr[i+1];
      const isHigh = type === 'high' && arr[i] >= arr[i-1] && arr[i] >= arr[i+1];
      if (!isLow && !isHigh) continue;
      if (swings.length && i - swings[swings.length - 1].i < minDist) {
        // Replace if this extreme is more extreme than the last within the min distance
        const last = swings[swings.length - 1];
        if ((type === 'low' && arr[i] < last.val) || (type === 'high' && arr[i] > last.val)) {
          swings[swings.length - 1] = { i, val: arr[i] };
        }
      } else {
        swings.push({ i, val: arr[i] });
      }
    }
    return swings;
  }

  const priceLows  = findSwings(prices, 'low');
  const priceHighs = findSwings(prices, 'high');

  let bullish = false, bearish = false, hiddenBullish = false, hiddenBearish = false;
  let strengthScore = 0; // 0–2: 0=weak, 1=moderate, 2=strong

  if (priceLows.length >= 2) {
    const prev = priceLows[priceLows.length - 2];
    const curr = priceLows[priceLows.length - 1];
    // Regular bullish: price lower low + RSI higher low
    if (curr.val < prev.val && rsis[curr.i] > rsis[prev.i]) {
      bullish = true;
      const pDiff  = (prev.val - curr.val) / prev.val * 100;
      const rDiff  = rsis[curr.i] - rsis[prev.i];
      strengthScore = pDiff > 1 && rDiff > 5 ? 2 : rDiff > 2 ? 1 : 0;
    }
    // Hidden bullish: price higher low + RSI lower low
    if (!bullish && curr.val > prev.val && rsis[curr.i] < rsis[prev.i]) {
      hiddenBullish = true;
    }
  }

  if (priceHighs.length >= 2) {
    const prev = priceHighs[priceHighs.length - 2];
    const curr = priceHighs[priceHighs.length - 1];
    // Regular bearish: price higher high + RSI lower high
    if (curr.val > prev.val && rsis[curr.i] < rsis[prev.i]) {
      bearish = true;
      const pDiff  = (curr.val - prev.val) / prev.val * 100;
      const rDiff  = rsis[prev.i] - rsis[curr.i];
      if (!bullish) strengthScore = pDiff > 1 && rDiff > 5 ? 2 : rDiff > 2 ? 1 : 0;
    }
    // Hidden bearish: price lower high + RSI higher high
    if (!bearish && curr.val < prev.val && rsis[curr.i] > rsis[prev.i]) {
      hiddenBearish = true;
    }
  }

  const strength = strengthScore === 2 ? 'strong' : strengthScore === 1 ? 'moderate' : 'weak';
  return { bullish, bearish, hiddenBullish, hiddenBearish, strength };
}

// ─── Rate of Change / Momentum ────────────────────────────────────────────
// Price velocity. Positive = upward momentum.

function calcROC(closes, period = 10) {
  if (closes.length < period + 1) return 0;
  const current = closes[closes.length - 1];
  const past    = closes[closes.length - 1 - period];
  if (past === 0) return 0;
  return ((current - past) / past) * 100;
}

// ─── Volume ratio ─────────────────────────────────────────────────────────

function calcVolumeRatio(volumes, period = 20) {
  if (volumes.length < period + 1) return 1;
  const avg = volumes.slice(-period - 1, -1).reduce((a, b) => a + b, 0) / period;
  if (avg === 0) return 1;
  return volumes[volumes.length - 1] / avg;
}

// ─── Regime Detection ─────────────────────────────────────────────────────
// Returns: 'TRENDING_UP' | 'TRENDING_DOWN' | 'RANGING' | 'VOLATILE'
// Used to switch between regime-specific parameter sets.

function detectRegime(candles, emaCross, atr, bb) {
  if (!emaCross || !atr || !bb) return 'RANGING';

  // High volatility = ATR significantly above average
  if (atr.ratio > 1.8) return 'VOLATILE';

  // Trending: EMA aligned + price moving consistently
  const closes = candles.slice(-10).map(c => c.close);
  const slope = (closes[closes.length - 1] - closes[0]) / closes[0];

  if (emaCross.bullish && slope > 0.002) return 'TRENDING_UP';
  if (!emaCross.bullish && slope < -0.002) return 'TRENDING_DOWN';

  return 'RANGING';
}

// ─── Verdict (matches frontend getVerdict exactly) ────────────────────────

function getVerdict(rsi, bb, macd) {
  if (!bb || !macd) return 'NEUTRAL';
  const bullish = (rsi < 30 && macd.hist > 0) || bb.pct < 0.2;
  const bearish = (rsi > 70 && macd.hist < 0) || bb.pct > 0.8;
  if (bullish) return 'BULLISH';
  if (bearish) return 'BEARISH';
  if (bb.width > 2) return 'RANGING';
  return 'NEUTRAL';
}

// ─── Kelly Criterion ──────────────────────────────────────────────────────
// Optimal fraction of capital to risk per trade.
// f* = (p*b - q) / b  where b = avg_win / avg_loss
// Capped at 25% (half-Kelly for safety).

function calcKelly(winRate, avgWinBps, avgLossBps) {
  if (winRate <= 0 || winRate >= 1) return 0.05;
  if (avgLossBps <= 0) return 0.05;
  const b = avgWinBps / avgLossBps;
  const q = 1 - winRate;
  const kelly = (winRate * b - q) / b;
  // Half-Kelly, capped 2%–25%
  return Math.max(0.02, Math.min(0.25, kelly * 0.5));
}

// ─── Confluence Scoring ────────────────────────────────────────────────────
// Weighted multi-factor score 0–100.
// Higher score = stronger combined signal for a long entry.
// This REPLACES hard gates with a flexible probability-based filter.
//
// Weights (must sum to 100):
//   OBI        25  — order book pressure (real-time edge)
//   RSI        18  — momentum oscillator
//   BB %B      18  — mean-reversion position
//   StochRSI   12  — sensitive oversold signal
//   MACD hist  10  — trend confirmation
//   VWAP       8   — institutional reference
//   EMA cross  5   — trend alignment
//   Volume     4   — participation confirmation

function calcConfluenceScore(opts) {
  const {
    rsi, bb, macd, obi, stochRsi, vwap, emaCross,
    volRatio, price, divergence,
  } = opts;

  let score = 0;

  // OBI — Order Book Imbalance (weight 25) ─────────────────────
  // Most important signal for microstructure scalping.
  if (obi !== null && obi !== undefined) {
    if      (obi >  0.4) score += 25;
    else if (obi >  0.2) score += 18;
    else if (obi >  0.05) score += 10;
    else if (obi < -0.4) score -= 20;
    else if (obi < -0.2) score -= 12;
    else if (obi < -0.05) score -= 5;
    // neutral OBI adds 5 (no directional pressure, spread capture safer)
    else score += 5;
  }

  // RSI (weight 18) ─────────────────────────────────────────────
  if (rsi !== undefined) {
    if      (rsi < 25) score += 18;   // extreme oversold
    else if (rsi < 35) score += 13;
    else if (rsi < 45) score += 7;
    else if (rsi < 55) score += 3;    // neutral
    else if (rsi > 72) score -= 18;   // overbought, bad for long entry
    else if (rsi > 65) score -= 10;
    else if (rsi > 58) score -= 4;
  }

  // BB %B (weight 18) ────────────────────────────────────────────
  if (bb) {
    if      (bb.pct < 0.1) score += 18;  // tight to lower band
    else if (bb.pct < 0.25) score += 12;
    else if (bb.pct < 0.4)  score += 6;
    else if (bb.pct > 0.85) score -= 18;
    else if (bb.pct > 0.7)  score -= 10;
    else if (bb.pct > 0.55) score -= 4;
  }

  // StochRSI (weight 12) ─────────────────────────────────────────
  if (stochRsi) {
    if      (stochRsi.value < 0.15) score += 12;
    else if (stochRsi.value < 0.30) score += 7;
    else if (stochRsi.value < 0.50) score += 2;
    else if (stochRsi.value > 0.85) score -= 12;
    else if (stochRsi.value > 0.70) score -= 7;
  }

  // MACD histogram (weight 10) ──────────────────────────────────
  if (macd) {
    if      (macd.hist > 0 && macd.hist > Math.abs(macd.signal) * 0.3) score += 10;
    else if (macd.hist > 0) score += 6;
    else if (macd.hist < 0 && Math.abs(macd.hist) > Math.abs(macd.signal) * 0.3) score -= 8;
    else if (macd.hist < 0) score -= 4;
  }

  // VWAP (weight 8) ──────────────────────────────────────────────
  if (vwap && price) {
    const devPct = ((price - vwap.value) / vwap.value) * 100;
    if      (devPct < -0.5) score += 8;   // meaningfully below VWAP
    else if (devPct < 0)    score += 4;   // slightly below
    else if (devPct > 1.0)  score -= 6;   // extended above VWAP
    else if (devPct > 0.3)  score -= 2;
  }

  // EMA cross (weight 5) ─────────────────────────────────────────
  if (emaCross) {
    if      (emaCross.crossedUp) score += 5;   // fresh bullish cross
    else if (emaCross.bullish)   score += 3;   // sustained uptrend
    else if (emaCross.crossedDown) score -= 5;
    else    score -= 2;
  }

  // Volume (weight 4) ────────────────────────────────────────────
  if (volRatio !== undefined) {
    if      (volRatio > 2.0) score += 4;
    else if (volRatio > 1.3) score += 2;
    else if (volRatio < 0.5) score -= 2;
  }

  // RSI Divergence (bonus/penalty up to ±12) ────────────────────
  // Applied after base scoring — divergence confirms or contradicts other signals
  if (divergence) {
    const pts = divergence.strength === 'strong' ? 12 : divergence.strength === 'moderate' ? 8 : 5;
    if (divergence.bullish)      score += pts;
    if (divergence.bearish)      score -= pts;
    if (divergence.hiddenBullish) score += 4;
    if (divergence.hiddenBearish) score -= 4;
  }

  // Clamp to 0–100
  return Math.max(0, Math.min(100, score + 50));
  // +50 shifts baseline: a "zero signal" market starts at 50/100
}

// ═══════════════════════════════════════════════════════════════════════════
// EXTENDED INDICATOR LIBRARY
// ═══════════════════════════════════════════════════════════════════════════

// ─── Moving Averages ──────────────────────────────────────────────────────

/**
 * Simple Moving Average — returns last value only
 */
function calcSMA(closes, period) {
  if (!closes || closes.length < period) return null;
  const slice = closes.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

/**
 * Weighted Moving Average — linearly weighted, most recent = highest weight
 */
function calcWMA(closes, period) {
  if (!closes || closes.length < period) return null;
  const slice = closes.slice(-period);
  let weightedSum = 0;
  let weightTotal = 0;
  for (let i = 0; i < period; i++) {
    const weight = i + 1;
    weightedSum += slice[i] * weight;
    weightTotal += weight;
  }
  return weightedSum / weightTotal;
}

/**
 * Hull Moving Average: WMA(2*WMA(n/2) - WMA(n), sqrt(n))
 */
function calcHMA(closes, period) {
  if (!closes || closes.length < period) return null;
  const half = Math.floor(period / 2);
  const sqrtPeriod = Math.round(Math.sqrt(period));

  // We need sqrtPeriod values of (2*WMA(half) - WMA(period))
  const needed = period + sqrtPeriod - 1;
  if (closes.length < needed) return null;

  const diff = [];
  for (let i = needed - sqrtPeriod; i < closes.length; i++) {
    const slice = closes.slice(0, i + 1);
    const wmaHalf = calcWMAArr(slice, half);
    const wmaFull = calcWMAArr(slice, period);
    if (wmaHalf === null || wmaFull === null) return null;
    diff.push(2 * wmaHalf - wmaFull);
  }
  if (diff.length < sqrtPeriod) return null;
  return calcWMAArr(diff, sqrtPeriod);
}

// Internal helper: WMA returning last value from array
function calcWMAArr(arr, period) {
  if (!arr || arr.length < period) return null;
  const slice = arr.slice(-period);
  let weightedSum = 0, weightTotal = 0;
  for (let i = 0; i < period; i++) {
    const weight = i + 1;
    weightedSum += slice[i] * weight;
    weightTotal += weight;
  }
  return weightedSum / weightTotal;
}

/**
 * Double EMA: 2*EMA(n) - EMA(EMA(n))
 */
function calcDEMA(closes, period) {
  if (!closes || closes.length < period * 2 - 1) return null;
  const ema1 = calcEMAArr(closes, period);
  const ema2 = calcEMAArr(ema1, period);
  return 2 * ema1[ema1.length - 1] - ema2[ema2.length - 1];
}

/**
 * Triple EMA: 3*EMA - 3*EMA(EMA) + EMA(EMA(EMA))
 */
function calcTEMA(closes, period) {
  if (!closes || closes.length < period * 3 - 2) return null;
  const ema1 = calcEMAArr(closes, period);
  const ema2 = calcEMAArr(ema1, period);
  const ema3 = calcEMAArr(ema2, period);
  const e1 = ema1[ema1.length - 1];
  const e2 = ema2[ema2.length - 1];
  const e3 = ema3[ema3.length - 1];
  return 3 * e1 - 3 * e2 + e3;
}

/**
 * Triangular MA: SMA of SMA
 */
function calcTRIMA(closes, period) {
  if (!closes || closes.length < period * 2 - 1) return null;
  // Build SMA array
  const smaArr = [];
  for (let i = period - 1; i < closes.length; i++) {
    smaArr.push(closes.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0) / period);
  }
  if (smaArr.length < period) return null;
  return smaArr.slice(-period).reduce((a, b) => a + b, 0) / period;
}

/**
 * Zero-Lag EMA: EMA with lag correction.
 * Uses 2*EMA(n) - EMA(EMA(n)) (same as DEMA concept but intended as lag reducer)
 */
function calcZLEMA(closes, period) {
  if (!closes || closes.length < period * 2 - 1) return null;
  const lag = Math.floor((period - 1) / 2);
  // Adjusted data: close + (close - close[lag])
  if (closes.length < lag + 1) return null;
  const adjusted = [];
  for (let i = lag; i < closes.length; i++) {
    adjusted.push(2 * closes[i] - closes[i - lag]);
  }
  if (adjusted.length < period) return null;
  const emaAdj = calcEMAArr(adjusted, period);
  return emaAdj[emaAdj.length - 1];
}

/**
 * Arnaud Legoux Moving Average
 */
function calcALMA(closes, period = 9, offset = 0.85, sigma = 6) {
  if (!closes || closes.length < period) return null;
  const slice = closes.slice(-period);
  const m = offset * (period - 1);
  const s = period / sigma;
  let weightSum = 0, total = 0;
  for (let i = 0; i < period; i++) {
    const w = Math.exp(-((i - m) * (i - m)) / (2 * s * s));
    weightSum += w * slice[i];
    total += w;
  }
  return total === 0 ? null : weightSum / total;
}

/**
 * Volume-Weighted Moving Average
 */
function calcVWMA(candles, period) {
  if (!candles || candles.length < period) return null;
  const slice = candles.slice(-period);
  let priceVolSum = 0, volSum = 0;
  for (const c of slice) {
    priceVolSum += C(c) * V(c);
    volSum += V(c);
  }
  return volSum === 0 ? null : priceVolSum / volSum;
}

/**
 * McGinley Dynamic — stateful. Pass prevMcG from last call or null to seed.
 */
function calcMcGinley(closes, period, prevMcG = null) {
  if (!closes || closes.length < 1) return null;
  const last = closes[closes.length - 1];
  if (prevMcG === null) {
    // Seed with SMA if no previous value
    if (closes.length < period) return last;
    return closes.slice(-period).reduce((a, b) => a + b, 0) / period;
  }
  // McGinley Dynamic formula
  const denom = period * Math.pow(last / prevMcG, 4);
  if (denom === 0) return prevMcG;
  return prevMcG + (last - prevMcG) / denom;
}

// ─── Trend Indicators ────────────────────────────────────────────────────

/**
 * Average Directional Index — Wilder's smoothing
 * Returns { adx, diPlus, diMinus, trending }
 */
function calcADX(candles, period = 14) {
  if (!candles || candles.length < period * 2 + 1) return null;

  const trArr = [], dmPlusArr = [], dmMinusArr = [];
  for (let i = 1; i < candles.length; i++) {
    const h  = H(candles[i]);
    const l  = L(candles[i]);
    const ph = H(candles[i - 1]);
    const pl = L(candles[i - 1]);
    const pc = C(candles[i - 1]);

    const tr = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
    const upMove   = h - ph;
    const downMove = pl - l;

    trArr.push(tr);
    dmPlusArr.push(upMove > downMove && upMove > 0 ? upMove : 0);
    dmMinusArr.push(downMove > upMove && downMove > 0 ? downMove : 0);
  }

  // Wilder's smoothed initial sums
  let smoothTR    = trArr.slice(0, period).reduce((a, b) => a + b, 0);
  let smoothDMPlus  = dmPlusArr.slice(0, period).reduce((a, b) => a + b, 0);
  let smoothDMMinus = dmMinusArr.slice(0, period).reduce((a, b) => a + b, 0);

  const dxArr = [];
  for (let i = period; i < trArr.length; i++) {
    smoothTR    = smoothTR    - smoothTR / period    + trArr[i];
    smoothDMPlus  = smoothDMPlus  - smoothDMPlus / period  + dmPlusArr[i];
    smoothDMMinus = smoothDMMinus - smoothDMMinus / period + dmMinusArr[i];

    const diPlus  = smoothTR === 0 ? 0 : (smoothDMPlus  / smoothTR) * 100;
    const diMinus = smoothTR === 0 ? 0 : (smoothDMMinus / smoothTR) * 100;
    const dx = (diPlus + diMinus) === 0 ? 0 : Math.abs(diPlus - diMinus) / (diPlus + diMinus) * 100;
    dxArr.push({ dx, diPlus, diMinus });
  }

  if (dxArr.length < period) return null;

  // ADX = Wilder's smoothed DX
  let adx = dxArr.slice(0, period).reduce((a, b) => a + b.dx, 0) / period;
  for (let i = period; i < dxArr.length; i++) {
    adx = (adx * (period - 1) + dxArr[i].dx) / period;
  }

  const last = dxArr[dxArr.length - 1];
  return {
    adx,
    diPlus: last.diPlus,
    diMinus: last.diMinus,
    trending: adx > 25,
  };
}

/**
 * Aroon Indicator
 * Returns { up, down, oscillator }
 */
function calcAroon(candles, period = 25) {
  if (!candles || candles.length < period + 1) return null;
  const slice = candles.slice(-(period + 1));
  let highIdx = 0, lowIdx = 0;
  for (let i = 1; i <= period; i++) {
    if (H(slice[i]) >= H(slice[highIdx])) highIdx = i;
    if (L(slice[i]) <= L(slice[lowIdx]))  lowIdx  = i;
  }
  const barsSinceHigh = period - highIdx;
  const barsSinceLow  = period - lowIdx;
  const up   = ((period - barsSinceHigh) / period) * 100;
  const down = ((period - barsSinceLow)  / period) * 100;
  return { up, down, oscillator: up - down };
}

/**
 * Parabolic SAR — computed from scratch on each call
 * Returns { value, bull } for the last candle
 */
function calcPSAR(candles, step = 0.02, max = 0.2) {
  if (!candles || candles.length < 2) return null;

  let bull = true;
  let af   = step;
  let ep   = H(candles[0]);  // extreme point
  let sar  = L(candles[0]);

  for (let i = 1; i < candles.length; i++) {
    const h = H(candles[i]);
    const l = L(candles[i]);

    // Advance SAR
    let newSar = sar + af * (ep - sar);

    if (bull) {
      newSar = Math.min(newSar, L(candles[i - 1]));
      if (i >= 2) newSar = Math.min(newSar, L(candles[i - 2]));
      if (l < newSar) {
        // Reversal to bearish
        bull = false;
        newSar = ep;
        ep = l;
        af = step;
      } else {
        if (h > ep) {
          ep = h;
          af = Math.min(af + step, max);
        }
      }
    } else {
      newSar = Math.max(newSar, H(candles[i - 1]));
      if (i >= 2) newSar = Math.max(newSar, H(candles[i - 2]));
      if (h > newSar) {
        // Reversal to bullish
        bull = true;
        newSar = ep;
        ep = h;
        af = step;
      } else {
        if (l < ep) {
          ep = l;
          af = Math.min(af + step, max);
        }
      }
    }

    sar = newSar;
  }

  return { value: sar, bull };
}

/**
 * Ichimoku Cloud
 * Returns { tenkan, kijun, senkouA, senkouB, chikou, aboveCloud, cloudBull }
 * Senkou A/B are the values that were plotted 26 bars ago (current cloud position)
 */
function calcIchimoku(candles) {
  if (!candles || candles.length < 52 + 26) return null;

  function midpoint(arr, from, to) {
    let hi = -Infinity, lo = Infinity;
    for (let i = from; i <= to; i++) {
      if (H(arr[i]) > hi) hi = H(arr[i]);
      if (L(arr[i]) < lo) lo = L(arr[i]);
    }
    return (hi + lo) / 2;
  }

  const n = candles.length;
  const idx = n - 1;

  // Tenkan-sen: 9-period midpoint
  if (idx < 8) return null;
  const tenkan = midpoint(candles, idx - 8, idx);

  // Kijun-sen: 26-period midpoint
  if (idx < 25) return null;
  const kijun = midpoint(candles, idx - 25, idx);

  // Senkou A: (tenkan + kijun) / 2 as of 26 bars ago
  const prevIdx = idx - 26;
  if (prevIdx < 8) return null;
  const prevTenkan = midpoint(candles, prevIdx - 8, prevIdx);
  const prevKijun  = midpoint(candles, Math.max(0, prevIdx - 25), prevIdx);
  const senkouA    = (prevTenkan + prevKijun) / 2;

  // Senkou B: 52-period midpoint as of 26 bars ago
  if (prevIdx < 51) return null;
  const senkouB = midpoint(candles, prevIdx - 51, prevIdx);

  // Chikou: close shifted back 26 bars (i.e., the close 26 bars ago)
  const chikou = C(candles[Math.max(0, idx - 26)]);

  const close = C(candles[idx]);
  const aboveCloud = close > Math.max(senkouA, senkouB);
  const cloudBull  = senkouA > senkouB;

  return { tenkan, kijun, senkouA, senkouB, chikou, aboveCloud, cloudBull };
}

/**
 * Supertrend Indicator
 * Returns { value, bull, changed }
 */
function calcSupertrend(candles, period = 10, mult = 3) {
  if (!candles || candles.length < period + 1) return null;

  // Build TR array
  const tr = [];
  for (let i = 1; i < candles.length; i++) {
    const h  = H(candles[i]);
    const l  = L(candles[i]);
    const pc = C(candles[i - 1]);
    tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }

  // Wilder's ATR
  let atr = tr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const atrArr = [atr];
  for (let i = period; i < tr.length; i++) {
    atr = (atr * (period - 1) + tr[i]) / period;
    atrArr.push(atr);
  }

  // Compute supertrend from period index onward
  let upperBand, lowerBand, prevUpper = 0, prevLower = 0;
  let bull = true, prevBull = true;
  let value = 0;

  for (let i = 0; i < atrArr.length; i++) {
    const ci = i + 1; // candle index (offset by 1 for TR)
    const mid = (H(candles[ci]) + L(candles[ci])) / 2;
    const atrVal = atrArr[i];

    upperBand = mid + mult * atrVal;
    lowerBand = mid - mult * atrVal;

    // Prevent bands from moving against trend
    upperBand = (i > 0 && upperBand > prevUpper) ? upperBand
      : (i > 0 ? Math.min(upperBand, prevUpper) : upperBand);
    lowerBand = (i > 0 && lowerBand < prevLower) ? lowerBand
      : (i > 0 ? Math.max(lowerBand, prevLower) : lowerBand);

    const close = C(candles[ci]);
    prevBull = bull;
    if (prevBull) {
      bull = close >= lowerBand;
    } else {
      bull = close > upperBand;
    }

    value = bull ? lowerBand : upperBand;
    prevUpper = upperBand;
    prevLower = lowerBand;
  }

  return { value, bull, changed: bull !== prevBull };
}

// ─── Volatility Indicators ───────────────────────────────────────────────

/**
 * Keltner Channels
 * Returns { upper, mid, lower, pct }
 */
function calcKeltner(candles, period = 20, mult = 2) {
  if (!candles || candles.length < period + 1) return null;
  const closes = candles.map(C);
  const emaArr = calcEMAArr(closes, period);
  const mid = emaArr[emaArr.length - 1];

  // ATR with period 10 for Keltner
  const atrPeriod = 10;
  if (candles.length < atrPeriod + 1) return null;
  const tr = [];
  for (let i = 1; i < candles.length; i++) {
    const h  = H(candles[i]);
    const l  = L(candles[i]);
    const pc = C(candles[i - 1]);
    tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  let atr = tr.slice(0, atrPeriod).reduce((a, b) => a + b, 0) / atrPeriod;
  for (let i = atrPeriod; i < tr.length; i++) {
    atr = (atr * (atrPeriod - 1) + tr[i]) / atrPeriod;
  }

  const upper = mid + mult * atr;
  const lower = mid - mult * atr;
  const last  = closes[closes.length - 1];
  const pct   = upper === lower ? 0.5 : (last - lower) / (upper - lower);
  return { upper, mid, lower, pct };
}

/**
 * Donchian Channels
 * Returns { upper, mid, lower }
 */
function calcDonchian(candles, period = 20) {
  if (!candles || candles.length < period) return null;
  const slice = candles.slice(-period);
  let upper = -Infinity, lower = Infinity;
  for (const c of slice) {
    if (H(c) > upper) upper = H(c);
    if (L(c) < lower) lower = L(c);
  }
  return { upper, mid: (upper + lower) / 2, lower };
}

/**
 * Historical Volatility — annualized stddev of log returns
 * Returns decimal (e.g., 0.35 = 35% annualized vol)
 */
function calcHistVol(closes, period = 20) {
  if (!closes || closes.length < period + 1) return null;
  const slice = closes.slice(-(period + 1));
  const logReturns = [];
  for (let i = 1; i < slice.length; i++) {
    if (slice[i - 1] <= 0) return null;
    logReturns.push(Math.log(slice[i] / slice[i - 1]));
  }
  const mean = logReturns.reduce((a, b) => a + b, 0) / logReturns.length;
  const variance = logReturns.reduce((a, b) => a + (b - mean) ** 2, 0) / (logReturns.length - 1);
  const stddev = Math.sqrt(variance);
  // Annualize: assume 1-minute candles → 252 * 1440 periods per year
  return stddev * Math.sqrt(252 * 1440);
}

/**
 * Choppiness Index — 0–100. High = choppy, Low = trending.
 */
function calcChoppiness(candles, period = 14) {
  if (!candles || candles.length < period + 1) return null;
  const slice = candles.slice(-period);

  // Sum of ATR(1) over period
  let atrSum = 0;
  for (let i = 1; i < candles.length; i++) {
    if (i < candles.length - period) continue;
    const h  = H(candles[i]);
    const l  = L(candles[i]);
    const pc = C(candles[i - 1]);
    atrSum += Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  }

  // Donchian range over period
  let high = -Infinity, low = Infinity;
  for (const c of slice) {
    if (H(c) > high) high = H(c);
    if (L(c) < low)  low  = L(c);
  }
  const range = high - low;
  if (range === 0 || atrSum === 0) return null;

  return 100 * (Math.log10(atrSum / range) / Math.log10(period));
}

/**
 * Ulcer Index — sqrt(mean of squared % drawdowns from rolling max)
 */
function calcUlcerIndex(closes, period = 14) {
  if (!closes || closes.length < period) return null;
  const slice = closes.slice(-period);
  let maxVal = -Infinity;
  let sumSqDrawdown = 0;
  for (const c of slice) {
    if (c > maxVal) maxVal = c;
    const drawdownPct = maxVal > 0 ? ((c - maxVal) / maxVal) * 100 : 0;
    sumSqDrawdown += drawdownPct * drawdownPct;
  }
  return Math.sqrt(sumSqDrawdown / period);
}

// ─── Oscillators ─────────────────────────────────────────────────────────

/**
 * Stochastic Oscillator
 * Returns { k, d }
 */
function calcStochastic(candles, kPeriod = 14, dPeriod = 3) {
  if (!candles || candles.length < kPeriod + dPeriod - 1) return null;

  const kArr = [];
  for (let i = kPeriod - 1; i < candles.length; i++) {
    const slice = candles.slice(i - kPeriod + 1, i + 1);
    let lo = Infinity, hi = -Infinity;
    for (const c of slice) {
      if (H(c) > hi) hi = H(c);
      if (L(c) < lo) lo = L(c);
    }
    const range = hi - lo;
    kArr.push(range === 0 ? 50 : ((C(candles[i]) - lo) / range) * 100);
  }

  if (kArr.length < dPeriod) return null;
  const k = kArr[kArr.length - 1];
  const d = kArr.slice(-dPeriod).reduce((a, b) => a + b, 0) / dPeriod;
  return { k, d };
}

/**
 * Williams %R
 * Returns value -100 to 0
 */
function calcWilliamsR(candles, period = 14) {
  if (!candles || candles.length < period) return null;
  const slice = candles.slice(-period);
  let hi = -Infinity, lo = Infinity;
  for (const c of slice) {
    if (H(c) > hi) hi = H(c);
    if (L(c) < lo) lo = L(c);
  }
  if (hi === lo) return -50;
  return ((hi - C(candles[candles.length - 1])) / (hi - lo)) * -100;
}

/**
 * Commodity Channel Index
 */
function calcCCI(candles, period = 20) {
  if (!candles || candles.length < period) return null;
  const slice = candles.slice(-period);
  const tps = slice.map(c => (H(c) + L(c) + C(c)) / 3);
  const mean = tps.reduce((a, b) => a + b, 0) / period;
  const meanDev = tps.reduce((a, b) => a + Math.abs(b - mean), 0) / period;
  if (meanDev === 0) return 0;
  return (tps[tps.length - 1] - mean) / (0.015 * meanDev);
}

/**
 * Money Flow Index
 * Returns 0–100
 */
function calcMFI(candles, period = 14) {
  if (!candles || candles.length < period + 1) return null;
  let posMF = 0, negMF = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const tp    = (H(candles[i]) + L(candles[i]) + C(candles[i])) / 3;
    const prevTp = (H(candles[i - 1]) + L(candles[i - 1]) + C(candles[i - 1])) / 3;
    const mf = tp * V(candles[i]);
    if (tp >= prevTp) posMF += mf;
    else              negMF += mf;
  }
  if (negMF === 0) return 100;
  const mfRatio = posMF / negMF;
  return 100 - (100 / (1 + mfRatio));
}

/**
 * Chaikin Money Flow
 * Returns -1 to +1
 */
function calcCMF(candles, period = 20) {
  if (!candles || candles.length < period) return null;
  const slice = candles.slice(-period);
  let mfvSum = 0, volSum = 0;
  for (const c of slice) {
    const h = H(c), l = L(c), cl = C(c), v = V(c);
    const range = h - l;
    const mfm = range === 0 ? 0 : ((cl - l) - (h - cl)) / range;
    mfvSum += mfm * v;
    volSum += v;
  }
  return volSum === 0 ? 0 : mfvSum / volSum;
}

/**
 * Elder Ray
 * Returns { bullPower, bearPower }
 */
function calcElderRay(candles, period = 13) {
  if (!candles || candles.length < period) return null;
  const closes = candles.map(C);
  const emaArr = calcEMAArr(closes, period);
  const ema    = emaArr[emaArr.length - 1];
  const last   = candles[candles.length - 1];
  return {
    bullPower: H(last) - ema,
    bearPower: L(last) - ema,
  };
}

/**
 * Chande Momentum Oscillator
 */
function calcCMO(closes, period = 14) {
  if (!closes || closes.length < period + 1) return null;
  let gainSum = 0, lossSum = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gainSum += d;
    else       lossSum += Math.abs(d);
  }
  const total = gainSum + lossSum;
  if (total === 0) return 0;
  return ((gainSum - lossSum) / total) * 100;
}

/**
 * Ultimate Oscillator — weighted combination of 3 time periods
 */
function calcUltimateOscillator(candles, p1 = 7, p2 = 14, p3 = 28) {
  const minLen = p3 + 1;
  if (!candles || candles.length < minLen) return null;

  const bpArr = [], trArr = [];
  for (let i = 1; i < candles.length; i++) {
    const h  = H(candles[i]);
    const l  = L(candles[i]);
    const pc = C(candles[i - 1]);
    const trueHigh = Math.max(h, pc);
    const trueLow  = Math.min(l, pc);
    bpArr.push(C(candles[i]) - trueLow);
    trArr.push(trueHigh - trueLow);
  }

  function avgBpTr(period) {
    const bp = bpArr.slice(-period).reduce((a, b) => a + b, 0);
    const tr = trArr.slice(-period).reduce((a, b) => a + b, 0);
    return tr === 0 ? 0 : bp / tr;
  }

  const avg7  = avgBpTr(p1);
  const avg14 = avgBpTr(p2);
  const avg28 = avgBpTr(p3);

  return (4 * avg7 + 2 * avg14 + avg28) / 7 * 100;
}

/**
 * Awesome Oscillator: SMA(midpoint, 5) - SMA(midpoint, 34)
 */
function calcAwesomeOscillator(candles) {
  if (!candles || candles.length < 34) return null;
  const midpoints = candles.map(c => (H(c) + L(c)) / 2);
  const sma5  = midpoints.slice(-5).reduce((a, b) => a + b, 0) / 5;
  const sma34 = midpoints.slice(-34).reduce((a, b) => a + b, 0) / 34;
  return sma5 - sma34;
}

/**
 * Detrended Price Oscillator
 */
function calcDPO(closes, period = 20) {
  if (!closes || closes.length < period + Math.floor(period / 2) + 1) return null;
  const shift = Math.floor(period / 2) + 1;
  // SMA at position [length - shift - 1] (i.e., back in time)
  const smaIdx = closes.length - shift - 1;
  if (smaIdx < period - 1) return null;
  const sma = closes.slice(smaIdx - period + 1, smaIdx + 1).reduce((a, b) => a + b, 0) / period;
  return closes[closes.length - 1] - sma;
}

/**
 * Percentage Price Oscillator
 * Returns { ppo, signal, histogram }
 */
function calcPPO(closes, fast = 12, slow = 26, signal = 9) {
  if (!closes || closes.length < slow + signal) return null;
  const fastEMA = calcEMAArr(closes, fast);
  const slowEMA = calcEMAArr(closes, slow);
  const ppoLine = fastEMA.map((v, i) => slowEMA[i] === 0 ? 0 : ((v - slowEMA[i]) / slowEMA[i]) * 100);
  const sigLine = calcEMAArr(ppoLine.slice(slow - 1), signal);
  const ppo     = ppoLine[ppoLine.length - 1];
  const sig     = sigLine[sigLine.length - 1];
  return { ppo, signal: sig, histogram: ppo - sig };
}

/**
 * TRIX — triple-smoothed EMA 1-period % rate of change
 * Returns { trix, signal }
 */
function calcTRIX(closes, period = 15) {
  if (!closes || closes.length < period * 3) return null;
  const ema1 = calcEMAArr(closes, period);
  const ema2 = calcEMAArr(ema1, period);
  const ema3 = calcEMAArr(ema2, period);

  const trixArr = [];
  for (let i = 1; i < ema3.length; i++) {
    if (ema3[i - 1] === 0) trixArr.push(0);
    else trixArr.push(((ema3[i] - ema3[i - 1]) / ema3[i - 1]) * 100);
  }

  if (trixArr.length < 9) return null;
  const sigArr = calcEMAArr(trixArr, 9);
  return {
    trix: trixArr[trixArr.length - 1],
    signal: sigArr[sigArr.length - 1],
  };
}

/**
 * Know Sure Thing — weighted sum of 4 smoothed ROC values
 * Returns { kst, signal }
 */
function calcKST(closes) {
  // KST parameters: ROC periods [10,13,14,15], SMA periods [10,13,14,15], weights [1,2,3,4]
  const rocPeriods = [10, 13, 14, 15];
  const smaPeriods = [10, 13, 14, 15];
  const weights    = [1, 2, 3, 4];
  const signalPeriod = 9;

  const minLen = Math.max(...rocPeriods) + Math.max(...smaPeriods) + signalPeriod;
  if (!closes || closes.length < minLen) return null;

  // Build arrays of smoothed ROC
  function rocAt(idx, period) {
    if (idx < period) return 0;
    const past = closes[idx - period];
    return past === 0 ? 0 : ((closes[idx] - past) / past) * 100;
  }

  // Build KST line
  const kstArr = [];
  const startIdx = Math.max(...rocPeriods) + Math.max(...smaPeriods) - 1;
  for (let i = startIdx; i < closes.length; i++) {
    let kst = 0;
    for (let j = 0; j < rocPeriods.length; j++) {
      // SMA of ROC for this period
      const rp = rocPeriods[j];
      const sp = smaPeriods[j];
      let rocSum = 0;
      for (let k = 0; k < sp; k++) {
        rocSum += rocAt(i - k, rp);
      }
      const smoothedRoc = rocSum / sp;
      kst += smoothedRoc * weights[j];
    }
    kstArr.push(kst);
  }

  if (kstArr.length < signalPeriod) return null;
  const sigArr = calcEMAArr(kstArr, signalPeriod);
  return {
    kst: kstArr[kstArr.length - 1],
    signal: sigArr[sigArr.length - 1],
  };
}

/**
 * True Strength Index — double-smoothed price momentum
 * Returns { tsi, signal }
 */
function calcTSI(closes, long = 25, short = 13) {
  if (!closes || closes.length < long + short + 10) return null;

  // Momentum: close - prevClose
  const momentum = [];
  for (let i = 1; i < closes.length; i++) {
    momentum.push(closes[i] - closes[i - 1]);
  }

  // Double-smooth momentum and |momentum|
  const smoothM  = calcEMAArr(calcEMAArr(momentum, long), short);
  const smoothAM = calcEMAArr(calcEMAArr(momentum.map(Math.abs), long), short);

  const lastM  = smoothM[smoothM.length - 1];
  const lastAM = smoothAM[smoothAM.length - 1];

  if (lastAM === 0) return null;
  const tsiArr = smoothM.map((v, i) => smoothAM[i] === 0 ? 0 : (v / smoothAM[i]) * 100);
  const tsi    = tsiArr[tsiArr.length - 1];
  const sigArr = calcEMAArr(tsiArr, 13);

  return {
    tsi,
    signal: sigArr[sigArr.length - 1],
  };
}

/**
 * DMI (Directional Movement Index) — same math as ADX, different return shape
 * Returns { diPlus, diMinus, dx }
 */
function calcDMI(candles, period = 14) {
  const adx = calcADX(candles, period);
  if (!adx) return null;
  const { diPlus, diMinus } = adx;
  const dx = (diPlus + diMinus) === 0 ? 0 : Math.abs(diPlus - diMinus) / (diPlus + diMinus) * 100;
  return { diPlus, diMinus, dx };
}

// ─── Volume Indicators ────────────────────────────────────────────────────

/**
 * On Balance Volume
 * Returns { value, trend }
 */
function calcOBV(candles) {
  if (!candles || candles.length < 2) return null;
  let obv = 0;
  const obvArr = [0];
  for (let i = 1; i < candles.length; i++) {
    const diff = C(candles[i]) - C(candles[i - 1]);
    if (diff > 0)      obv += V(candles[i]);
    else if (diff < 0) obv -= V(candles[i]);
    obvArr.push(obv);
  }

  // Trend based on last 5 OBV values
  const recent = obvArr.slice(-5);
  const first  = recent[0];
  const last   = recent[recent.length - 1];
  const diff   = last - first;
  const threshold = Math.abs(first) * 0.01; // 1% change = trending
  let trend = 'flat';
  if (diff > threshold)       trend = 'rising';
  else if (diff < -threshold) trend = 'falling';

  return { value: obv, trend };
}

/**
 * Elder Force Index: EMA((close - prevClose) * volume, period)
 */
function calcForceIndex(candles, period = 13) {
  if (!candles || candles.length < period + 1) return null;
  const fi = [];
  for (let i = 1; i < candles.length; i++) {
    fi.push((C(candles[i]) - C(candles[i - 1])) * V(candles[i]));
  }
  const emaArr = calcEMAArr(fi, period);
  return emaArr[emaArr.length - 1];
}

/**
 * Ease of Movement: SMA of ((midpoint change) / (volume / range))
 */
function calcEMV(candles, period = 14) {
  if (!candles || candles.length < period + 1) return null;
  const emvRaw = [];
  for (let i = 1; i < candles.length; i++) {
    const h   = H(candles[i]),   l   = L(candles[i]);
    const ph  = H(candles[i-1]), pl  = L(candles[i-1]);
    const vol = V(candles[i]);
    const range = h - l;
    if (range === 0 || vol === 0) { emvRaw.push(0); continue; }
    const midMove = (h + l) / 2 - (ph + pl) / 2;
    emvRaw.push(midMove / (vol / range));
  }
  if (emvRaw.length < period) return null;
  return emvRaw.slice(-period).reduce((a, b) => a + b, 0) / period;
}

/**
 * Accumulation/Distribution — cumulative
 */
function calcAD(candles) {
  if (!candles || candles.length < 1) return null;
  let ad = 0;
  for (const c of candles) {
    const h = H(c), l = L(c), cl = C(c), v = V(c);
    const range = h - l;
    if (range === 0) continue;
    const clv = ((cl - l) - (h - cl)) / range;
    ad += clv * v;
  }
  return ad;
}

// ─── Pivot Points ─────────────────────────────────────────────────────────

/**
 * Classic Pivot Points from previous completed candle
 * Returns { pp, r1, r2, r3, s1, s2, s3 }
 */
function calcPivotPoints(candles) {
  if (!candles || candles.length < 2) return null;
  const prev = candles[candles.length - 2];
  const h = H(prev), l = L(prev), c = C(prev);
  const pp = (h + l + c) / 3;
  return {
    pp,
    r1: 2 * pp - l,
    r2: pp + (h - l),
    r3: h + 2 * (pp - l),
    s1: 2 * pp - h,
    s2: pp - (h - l),
    s3: l - 2 * (h - pp),
  };
}

/**
 * Fibonacci Pivot Points
 * Returns { pp, r1, r2, r3, s1, s2, s3 }
 */
function calcFibPivots(candles) {
  if (!candles || candles.length < 2) return null;
  const prev = candles[candles.length - 2];
  const h = H(prev), l = L(prev), c = C(prev);
  const pp    = (h + l + c) / 3;
  const range = h - l;
  return {
    pp,
    r1: pp + 0.382 * range,
    r2: pp + 0.618 * range,
    r3: pp + 1.000 * range,
    s1: pp - 0.382 * range,
    s2: pp - 0.618 * range,
    s3: pp - 1.000 * range,
  };
}

// ─── Market Structure ─────────────────────────────────────────────────────

/**
 * Detect Market Structure — trend, swing highs/lows, BOS and CHoCH
 * Returns { trend, swingHighs, swingLows, lastBOS, lastCHoCH }
 */
function detectMarketStructure(candles, lookback = 50) {
  if (!candles || candles.length < 10) return null;
  const slice = candles.slice(-Math.min(lookback, candles.length));

  // Find swing highs and lows with at least 2 bars on each side
  const swingHighs = [], swingLows = [];
  for (let i = 2; i < slice.length - 2; i++) {
    const h = H(slice[i]);
    if (h > H(slice[i-1]) && h > H(slice[i-2]) && h > H(slice[i+1]) && h > H(slice[i+2])) {
      swingHighs.push({ i, value: h, time: slice[i].t });
    }
    const l = L(slice[i]);
    if (l < L(slice[i-1]) && l < L(slice[i-2]) && l < L(slice[i+1]) && l < L(slice[i+2])) {
      swingLows.push({ i, value: l, time: slice[i].t });
    }
  }

  // Determine trend from swing structure
  let trend = 'ranging';
  if (swingHighs.length >= 2 && swingLows.length >= 2) {
    const lastHH = swingHighs[swingHighs.length - 1].value;
    const prevHH = swingHighs[swingHighs.length - 2].value;
    const lastLL = swingLows[swingLows.length - 1].value;
    const prevLL = swingLows[swingLows.length - 2].value;

    const higherHighs = lastHH > prevHH;
    const higherLows  = lastLL > prevLL;
    const lowerLows   = lastLL < prevLL;
    const lowerHighs  = lastHH < prevHH;

    if (higherHighs && higherLows)  trend = 'bullish';
    else if (lowerLows && lowerHighs) trend = 'bearish';
  }

  // Detect Break of Structure (BOS) — price breaks past a significant swing level
  let lastBOS = null;
  const currentClose = C(slice[slice.length - 1]);
  if (swingHighs.length >= 1) {
    const lastSwingHigh = swingHighs[swingHighs.length - 1].value;
    if (currentClose > lastSwingHigh) {
      lastBOS = { type: 'bullish', level: lastSwingHigh, time: slice[slice.length - 1].t };
    }
  }
  if (!lastBOS && swingLows.length >= 1) {
    const lastSwingLow = swingLows[swingLows.length - 1].value;
    if (currentClose < lastSwingLow) {
      lastBOS = { type: 'bearish', level: lastSwingLow, time: slice[slice.length - 1].t };
    }
  }

  // Detect Change of Character (CHoCH) — trend change signal
  let lastCHoCH = null;
  if (swingHighs.length >= 2 && swingLows.length >= 2) {
    const lastSwingHigh = swingHighs[swingHighs.length - 1];
    const lastSwingLow  = swingLows[swingLows.length - 1];
    // Bearish CHoCH: in uptrend, price breaks below most recent swing low
    if (trend === 'bullish' && currentClose < lastSwingLow.value) {
      lastCHoCH = { type: 'bearish', level: lastSwingLow.value, time: slice[slice.length - 1].t };
    }
    // Bullish CHoCH: in downtrend, price breaks above most recent swing high
    if (trend === 'bearish' && currentClose > lastSwingHigh.value) {
      lastCHoCH = { type: 'bullish', level: lastSwingHigh.value, time: slice[slice.length - 1].t };
    }
  }

  return { trend, swingHighs, swingLows, lastBOS, lastCHoCH };
}

/**
 * Detect Order Blocks — last up/down candle before an impulse move
 * Returns array of { type, high, low, time, tested }
 * Only returns high-confidence blocks.
 */
function detectOrderBlocks(candles, lookback = 50) {
  if (!candles || candles.length < 5) return [];
  const slice = candles.slice(-Math.min(lookback, candles.length));
  const blocks = [];

  // Minimum impulse: 3x average candle body size
  const avgBody = slice.reduce((a, c) => a + Math.abs(C(c) - O(c)), 0) / slice.length;
  const impulseThresh = avgBody * 3;

  for (let i = 1; i < slice.length - 2; i++) {
    const body = Math.abs(C(slice[i]) - O(slice[i]));

    // Look for a significant impulse move (2+ candle move) after this candle
    const nextBody1 = Math.abs(C(slice[i+1]) - O(slice[i+1]));
    const nextBody2 = i + 2 < slice.length ? Math.abs(C(slice[i+2]) - O(slice[i+2])) : 0;
    const impulse = nextBody1 + nextBody2;
    if (impulse < impulseThresh) continue;

    // Bearish order block: bullish candle (up) before a bearish impulse
    if (C(slice[i]) > O(slice[i]) && C(slice[i+1]) < O(slice[i+1]) && C(slice[i+2]) < O(slice[i+2])) {
      const blockHigh = H(slice[i]);
      const blockLow  = L(slice[i]);
      // Check if current price has tested this zone
      const lastClose = C(slice[slice.length - 1]);
      const tested    = lastClose >= blockLow && lastClose <= blockHigh;
      blocks.push({ type: 'bear', high: blockHigh, low: blockLow, time: slice[i].t, tested });
    }

    // Bullish order block: bearish candle (down) before a bullish impulse
    if (C(slice[i]) < O(slice[i]) && C(slice[i+1]) > O(slice[i+1]) && C(slice[i+2]) > O(slice[i+2])) {
      const blockHigh = H(slice[i]);
      const blockLow  = L(slice[i]);
      const lastClose = C(slice[slice.length - 1]);
      const tested    = lastClose >= blockLow && lastClose <= blockHigh;
      blocks.push({ type: 'bull', high: blockHigh, low: blockLow, time: slice[i].t, tested });
    }
  }

  // Return only the most recent 5 blocks
  return blocks.slice(-5);
}

// ═══════════════════════════════════════════════════════════════════════════
// UNIFIED calcAll — returns complete indicator bundle
// ═══════════════════════════════════════════════════════════════════════════

function calcAll(candles, params = {}) {
  if (!candles || candles.length < 2) return {};
  const closes  = candles.map(C);
  const volumes = candles.map(V);
  const p = {
    rsiPeriod:   14,
    bbPeriod:    20,
    bbStd:       2,
    macdFast:    12,
    macdSlow:    26,
    macdSignal:  9,
    atrPeriod:   14,
    ...params,
  };

  const result = {};

  // Price
  try { result.price = closes[closes.length - 1]; } catch (e) { result.price = null; }

  // ── Moving Averages ──────────────────────────────────────────────────────
  try { result.sma20  = calcSMA(closes, 20);  } catch (e) { result.sma20  = null; }
  try { result.sma50  = calcSMA(closes, 50);  } catch (e) { result.sma50  = null; }
  try { result.sma200 = calcSMA(closes, 200); } catch (e) { result.sma200 = null; }
  try {
    const e9 = calcEMAArr(closes, 9);
    result.ema9 = e9 ? e9[e9.length - 1] : null;
  } catch (e) { result.ema9 = null; }
  try {
    const e21 = calcEMAArr(closes, 21);
    result.ema21 = e21 ? e21[e21.length - 1] : null;
  } catch (e) { result.ema21 = null; }
  try {
    const e50 = calcEMAArr(closes, 50);
    result.ema50 = e50 ? e50[e50.length - 1] : null;
  } catch (e) { result.ema50 = null; }
  try {
    const e200 = calcEMAArr(closes, 200);
    result.ema200 = e200 ? e200[e200.length - 1] : null;
  } catch (e) { result.ema200 = null; }
  try { result.hma20   = calcHMA(closes, 20);       } catch (e) { result.hma20   = null; }
  try { result.dema20  = calcDEMA(closes, 20);       } catch (e) { result.dema20  = null; }
  try { result.tema20  = calcTEMA(closes, 20);       } catch (e) { result.tema20  = null; }
  try { result.vwma20  = calcVWMA(candles, 20);      } catch (e) { result.vwma20  = null; }
  try { result.wma20   = calcWMA(closes, 20);        } catch (e) { result.wma20   = null; }
  try { result.alma9   = calcALMA(closes, 9);        } catch (e) { result.alma9   = null; }
  try { result.zlema20 = calcZLEMA(closes, 20);      } catch (e) { result.zlema20 = null; }
  try { result.trima20 = calcTRIMA(closes, 20);      } catch (e) { result.trima20 = null; }

  // ── Core Trend / Oscillator ──────────────────────────────────────────────
  try { result.rsi      = calcRSI(closes, p.rsiPeriod);                          } catch (e) { result.rsi      = null; }
  try { result.bb       = calcBB(closes, p.bbPeriod, p.bbStd);                   } catch (e) { result.bb       = null; }
  try { result.macd     = calcMACD(closes, p.macdFast, p.macdSlow, p.macdSignal);} catch (e) { result.macd     = null; }
  try { result.atr      = calcATR(candles, p.atrPeriod);                         } catch (e) { result.atr      = null; }
  try { result.vwap     = calcVWAP(candles);                                      } catch (e) { result.vwap     = null; }
  try { result.stochRsi = calcStochRSI(closes);                                  } catch (e) { result.stochRsi = null; }
  try { result.emaCross = calcEMACross(closes);                                   } catch (e) { result.emaCross = null; }

  // ── Trend Indicators ─────────────────────────────────────────────────────
  try { result.adx        = calcADX(candles);        } catch (e) { result.adx        = null; }
  try { result.aroon      = calcAroon(candles);       } catch (e) { result.aroon      = null; }
  try { result.psar       = calcPSAR(candles);        } catch (e) { result.psar       = null; }
  try { result.ichimoku   = calcIchimoku(candles);    } catch (e) { result.ichimoku   = null; }
  try { result.supertrend = calcSupertrend(candles);  } catch (e) { result.supertrend = null; }

  // ── Volatility ───────────────────────────────────────────────────────────
  try { result.keltner    = calcKeltner(candles);    } catch (e) { result.keltner    = null; }
  try { result.donchian   = calcDonchian(candles);   } catch (e) { result.donchian   = null; }
  try { result.choppiness = calcChoppiness(candles); } catch (e) { result.choppiness = null; }
  try { result.histVol    = calcHistVol(closes);     } catch (e) { result.histVol    = null; }
  try { result.ulcerIndex = calcUlcerIndex(closes);  } catch (e) { result.ulcerIndex = null; }

  // ── Oscillators ──────────────────────────────────────────────────────────
  try { result.stochastic   = calcStochastic(candles);         } catch (e) { result.stochastic   = null; }
  try { result.williamsR    = calcWilliamsR(candles);          } catch (e) { result.williamsR    = null; }
  try { result.cci          = calcCCI(candles);                } catch (e) { result.cci          = null; }
  try { result.mfi          = calcMFI(candles);                } catch (e) { result.mfi          = null; }
  try { result.cmf          = calcCMF(candles);                } catch (e) { result.cmf          = null; }
  try { result.elderRay     = calcElderRay(candles);           } catch (e) { result.elderRay     = null; }
  try { result.cmo          = calcCMO(closes);                 } catch (e) { result.cmo          = null; }
  try { result.ultimateOsc  = calcUltimateOscillator(candles); } catch (e) { result.ultimateOsc  = null; }
  try { result.awesomeOsc   = calcAwesomeOscillator(candles);  } catch (e) { result.awesomeOsc   = null; }
  try { result.dpo          = calcDPO(closes);                 } catch (e) { result.dpo          = null; }
  try { result.ppo          = calcPPO(closes);                 } catch (e) { result.ppo          = null; }
  try { result.trix         = calcTRIX(closes);                } catch (e) { result.trix         = null; }
  try { result.kst          = calcKST(closes);                 } catch (e) { result.kst          = null; }
  try { result.tsi          = calcTSI(closes);                 } catch (e) { result.tsi          = null; }
  try { result.dmi          = calcDMI(candles);                } catch (e) { result.dmi          = null; }
  try { result.roc          = calcROC(closes);                 } catch (e) { result.roc          = null; }

  // ── Volume Indicators ────────────────────────────────────────────────────
  try { result.obv        = calcOBV(candles);              } catch (e) { result.obv        = null; }
  try { result.forceIndex = calcForceIndex(candles);       } catch (e) { result.forceIndex = null; }
  try { result.emv        = calcEMV(candles);              } catch (e) { result.emv        = null; }
  try { result.ad         = calcAD(candles);               } catch (e) { result.ad         = null; }
  try { result.volRatio   = calcVolumeRatio(volumes);      } catch (e) { result.volRatio   = null; }
  try { result.cmfVal     = calcCMF(candles);              } catch (e) { result.cmfVal     = null; }

  // ── Pivot Points ─────────────────────────────────────────────────────────
  try { result.pivots    = calcPivotPoints(candles); } catch (e) { result.pivots    = null; }
  try { result.fibPivots = calcFibPivots(candles);   } catch (e) { result.fibPivots = null; }

  // ── Market Structure ─────────────────────────────────────────────────────
  try { result.marketStructure = detectMarketStructure(candles); } catch (e) { result.marketStructure = null; }
  try { result.orderBlocks     = detectOrderBlocks(candles);     } catch (e) { result.orderBlocks     = []; }
  try { result.divergence      = detectDivergence(closes);       } catch (e) { result.divergence      = null; }

  // ── Composite ────────────────────────────────────────────────────────────
  try {
    result.regime = detectRegime(candles, result.emaCross, result.atr, result.bb);
  } catch (e) { result.regime = null; }

  // Confluence is computed by the caller with OBI data
  result.confluence = null;

  return result;
}

// ═══════════════════════════════════════════════════════════════════════════
// MODULE EXPORTS
// ═══════════════════════════════════════════════════════════════════════════

module.exports = {
  // Original exports
  calcEMAArr,
  calcRSI,
  calcBB,
  calcMACD,
  calcATR,
  calcVWAP,
  calcStochRSI,
  calcEMACross,
  calcROC,
  calcVolumeRatio,
  detectRegime,
  getVerdict,
  calcKelly,
  calcConfluenceScore,
  detectDivergence,

  // Moving Averages
  calcSMA,
  calcWMA,
  calcHMA,
  calcDEMA,
  calcTEMA,
  calcTRIMA,
  calcZLEMA,
  calcALMA,
  calcVWMA,
  calcMcGinley,

  // Trend Indicators
  calcADX,
  calcAroon,
  calcPSAR,
  calcIchimoku,
  calcSupertrend,

  // Volatility
  calcKeltner,
  calcDonchian,
  calcHistVol,
  calcChoppiness,
  calcUlcerIndex,

  // Oscillators
  calcStochastic,
  calcWilliamsR,
  calcCCI,
  calcMFI,
  calcCMF,
  calcElderRay,
  calcCMO,
  calcUltimateOscillator,
  calcAwesomeOscillator,
  calcDPO,
  calcPPO,
  calcTRIX,
  calcKST,
  calcTSI,
  calcDMI,

  // Volume
  calcOBV,
  calcForceIndex,
  calcEMV,
  calcAD,

  // Pivots
  calcPivotPoints,
  calcFibPivots,

  // Market Structure
  detectMarketStructure,
  detectOrderBlocks,

  // Unified bundle
  calcAll,
};
