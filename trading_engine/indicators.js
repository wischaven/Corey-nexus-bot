// ═══════════════════════════════════════════════════════════════════════════
// NEXUS Indicator Library — server-side (mirrors frontend formulas exactly)
// RSI · BB · MACD · ATR · VWAP · StochRSI · EMA Cross · ROC
// Regime Detection · Kelly Criterion · Confluence Scoring
// ═══════════════════════════════════════════════════════════════════════════

'use strict';

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

module.exports = {
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
};
