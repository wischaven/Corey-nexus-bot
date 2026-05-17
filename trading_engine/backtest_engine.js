'use strict';

/**
 * NEXUS Backtest Engine
 * Production-quality, strategy-agnostic backtesting for crypto trading.
 * No external dependencies — uses only Node.js built-in `https`.
 *
 * Candle shape expected throughout: { t, o, h, l, c, v }
 *   t — unix timestamp (seconds)
 *   o — open price
 *   h — high price
 *   l — low price
 *   c — close price
 *   v — volume
 */

const https = require('https');

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 1 — Pure Indicator Functions
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Wilder's smoothed RSI.
 * @param {number[]} prices - Array of close prices.
 * @param {number} [period=14]
 * @returns {number} RSI value 0–100, or 50 if insufficient data.
 */
function calcRSI(prices, period = 14) {
  if (!prices || prices.length < period + 1) return 50;

  // Seed: simple average of first `period` changes
  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = prices[i] - prices[i - 1];
    if (d > 0) gains += d;
    else losses -= d;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;

  // Wilder's smoothing for the remaining prices
  for (let i = period + 1; i < prices.length; i++) {
    const d = prices[i] - prices[i - 1];
    const g = d > 0 ? d : 0;
    const l = d < 0 ? -d : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/**
 * Bollinger Bands.
 * @param {number[]} prices - Array of close prices.
 * @param {number} [period=20]
 * @param {number} [std=2] - Standard deviation multiplier.
 * @returns {{ upper: number, mid: number, lower: number, pct: number, width: number }|null}
 */
function calcBB(prices, period = 20, std = 2) {
  if (!prices || prices.length < period) return null;
  const slice = prices.slice(-period);
  const mid = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((s, v) => s + Math.pow(v - mid, 2), 0) / period;
  const sigma = Math.sqrt(variance);
  const upper = mid + std * sigma;
  const lower = mid - std * sigma;
  const last = prices[prices.length - 1];
  const pct = upper === lower ? 0.5 : (last - lower) / (upper - lower);
  const width = mid !== 0 ? ((upper - lower) / mid) * 100 : 0;
  return { upper, mid, lower, pct, width };
}

/**
 * Exponential Moving Average — single value (last element).
 * @param {number[]} prices
 * @param {number} period
 * @returns {number|null}
 */
function calcEMA(prices, period) {
  if (!prices || prices.length < period) return null;
  return calcEMAArr(prices, period).at(-1);
}

/**
 * Exponential Moving Average — full array.
 * @param {number[]} prices
 * @param {number} period
 * @returns {number[]}
 */
function calcEMAArr(prices, period) {
  if (!prices || prices.length === 0) return [];
  const k = 2 / (period + 1);
  const result = [prices[0]];
  for (let i = 1; i < prices.length; i++) {
    result.push(prices[i] * k + result[i - 1] * (1 - k));
  }
  return result;
}

/**
 * MACD with signal line and histogram.
 * @param {number[]} prices
 * @param {number} [fast=12]
 * @param {number} [slow=26]
 * @param {number} [signal=9]
 * @returns {{ macd: number, signal: number, hist: number }|null}
 */
function calcMACD(prices, fast = 12, slow = 26, signal = 9) {
  if (!prices || prices.length < slow + signal) return null;
  const fastArr = calcEMAArr(prices, fast);
  const slowArr = calcEMAArr(prices, slow);
  const macdLine = fastArr.map((v, i) => v - slowArr[i]);
  // Use only the valid portion starting from slow-1 for signal EMA
  const macdValid = macdLine.slice(slow - 1);
  const signalArr = calcEMAArr(macdValid, signal);
  const lastMACD = macdLine[macdLine.length - 1];
  const lastSignal = signalArr[signalArr.length - 1];
  return { macd: lastMACD, signal: lastSignal, hist: lastMACD - lastSignal };
}

/**
 * Average True Range (Wilder's smoothing).
 * @param {Array<{h:number,l:number,c:number}>} candles - Use h/l/c or high/low/close fields.
 * @param {number} [period=14]
 * @returns {number|null}
 */
function calcATR(candles, period = 14) {
  if (!candles || candles.length < period + 1) return null;

  // Normalise candle field names
  const get = (c) => ({
    high:  c.h  !== undefined ? c.h  : c.high,
    low:   c.l  !== undefined ? c.l  : c.low,
    close: c.c  !== undefined ? c.c  : c.close,
  });

  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const cur  = get(candles[i]);
    const prev = get(candles[i - 1]);
    trs.push(Math.max(
      cur.high - cur.low,
      Math.abs(cur.high - prev.close),
      Math.abs(cur.low  - prev.close)
    ));
  }

  // Seed ATR with simple average of first `period` true ranges
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
  }
  return atr;
}

/**
 * Cumulative session VWAP.
 * @param {Array<{h:number,l:number,c:number,v:number}>} candles
 * @returns {{ value: number, devPct: number, above: boolean }|null}
 */
function calcVWAP(candles) {
  if (!candles || candles.length < 2) return null;

  const get = (c) => ({
    high:   c.h !== undefined ? c.h  : c.high,
    low:    c.l !== undefined ? c.l  : c.low,
    close:  c.c !== undefined ? c.c  : c.close,
    volume: c.v !== undefined ? c.v  : c.volume,
  });

  let cumTPV = 0;
  let cumVol = 0;
  for (const raw of candles) {
    const c  = get(raw);
    const tp = (c.high + c.low + c.close) / 3;
    cumTPV  += tp * c.volume;
    cumVol  += c.volume;
  }
  if (cumVol === 0) return null;
  const value  = cumTPV / cumVol;
  const last   = get(candles[candles.length - 1]).close;
  const devPct = ((last - value) / value) * 100;
  return { value, devPct, above: last > value };
}

/**
 * Stochastic RSI with smoothed %K and %D.
 * @param {number[]} prices
 * @param {number} [rsiPeriod=14]
 * @param {number} [stochPeriod=14]
 * @param {number} [smoothK=3]
 * @param {number} [smoothD=3]
 * @returns {{ k: number, d: number }|null}
 */
function calcStochRSI(prices, rsiPeriod = 14, stochPeriod = 14, smoothK = 3, smoothD = 3) {
  const minLen = rsiPeriod + stochPeriod + smoothK + smoothD + 2;
  if (!prices || prices.length < minLen) return null;

  // Build RSI history (one per candle from rsiPeriod onwards)
  const rsiArr = [];
  for (let i = rsiPeriod; i < prices.length; i++) {
    rsiArr.push(calcRSI(prices.slice(0, i + 1), rsiPeriod));
  }
  if (rsiArr.length < stochPeriod) return null;

  // Raw stochastic of RSI
  const rawK = [];
  for (let i = stochPeriod - 1; i < rsiArr.length; i++) {
    const window = rsiArr.slice(i - stochPeriod + 1, i + 1);
    const lo = Math.min(...window);
    const hi = Math.max(...window);
    rawK.push(hi === lo ? 50 : ((rsiArr[i] - lo) / (hi - lo)) * 100);
  }

  if (rawK.length < smoothK + smoothD - 1) return null;

  // Smooth %K
  const smoothedK = calcEMAArr(rawK, smoothK);
  // %D = EMA of smoothed %K
  const smoothedD = calcEMAArr(smoothedK, smoothD);

  return {
    k: smoothedK[smoothedK.length - 1],
    d: smoothedD[smoothedD.length - 1],
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 2 — calcIndicators: Bundle all indicators into one object
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Compute all indicators for the given candle history slice.
 *
 * @param {Array<{t,o,h,l,c,v}>} candles - History up to and including the current candle.
 * @param {object} params - Strategy parameters (rsiOversold, bbPeriod, bbStd, etc.)
 * @returns {{
 *   rsi: number,
 *   bb: object|null,
 *   bbPct: number,
 *   bbWidth: number,
 *   macd: object|null,
 *   atr: number|null,
 *   vwap: object|null,
 *   ema9: number|null,
 *   ema21: number|null,
 *   stochRsi: object|null,
 *   volRatio: number,
 *   obi: number,
 *   confluence: number,
 *   cur: object
 * }}
 */
function calcIndicators(candles, params = {}) {
  const {
    bbPeriod = 20,
    bbStd    = 2,
  } = params;

  const closes  = candles.map(c => c.c !== undefined ? c.c : c.close);
  const volumes = candles.map(c => c.v !== undefined ? c.v : c.volume);

  const cur     = candles[candles.length - 1];
  const curClose = cur.c !== undefined ? cur.c : cur.close;

  // Core indicators
  const rsi     = calcRSI(closes);
  const bb      = calcBB(closes, bbPeriod, bbStd);
  const macd    = calcMACD(closes);
  const atr     = calcATR(candles);
  const vwap    = calcVWAP(candles);
  const ema9    = calcEMA(closes, 9);
  const ema21   = calcEMA(closes, 21);
  const stochRsi = calcStochRSI(closes);

  // Derived BB metrics
  const bbPct   = bb ? bb.pct : 0.5;
  const bbWidth = bb ? bb.width : 0;

  // Volume ratio: current vol vs 20-period average
  let volRatio = 1;
  if (volumes.length >= 21) {
    const avgVol = volumes.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;
    const lastVol = volumes[volumes.length - 1];
    volRatio = avgVol > 0 ? lastVol / avgVol : 1;
  }

  // OBI placeholder (0 in backtest — live order book not available)
  const obi = 0;

  // Confluence score
  const emaCross = (ema9 !== null && ema21 !== null) ? {
    bullish: ema9 > ema21,
    crossedUp: false,
    crossedDown: false,
  } : null;

  const confluence = calcConfluenceScore({
    rsi,
    bb,
    macd,
    obi,
    stochRsi: stochRsi ? { value: stochRsi.k / 100 } : null,
    vwap,
    emaCross,
    volRatio,
    price: curClose,
    divergence: null,
  });

  return {
    rsi,
    bb,
    bbPct,
    bbWidth,
    macd,
    atr,
    vwap,
    ema9,
    ema21,
    stochRsi,
    volRatio,
    obi,
    confluence,
    cur,
  };
}

/**
 * Internal confluence scorer (0–100).
 * Mirrors the scoring logic from indicators.js but self-contained here.
 * @param {object} opts
 * @returns {number}
 */
function calcConfluenceScore(opts) {
  const { rsi, bb, macd, obi, stochRsi, vwap, emaCross, volRatio, price, divergence } = opts;
  let score = 0;

  // OBI (weight 25)
  if (obi !== null && obi !== undefined) {
    if      (obi >  0.4)  score += 25;
    else if (obi >  0.2)  score += 18;
    else if (obi >  0.05) score += 10;
    else if (obi < -0.4)  score -= 20;
    else if (obi < -0.2)  score -= 12;
    else if (obi < -0.05) score -= 5;
    else                  score += 5;
  }

  // RSI (weight 18)
  if (rsi !== undefined) {
    if      (rsi < 25) score += 18;
    else if (rsi < 35) score += 13;
    else if (rsi < 45) score += 7;
    else if (rsi < 55) score += 3;
    else if (rsi > 72) score -= 18;
    else if (rsi > 65) score -= 10;
    else if (rsi > 58) score -= 4;
  }

  // BB %B (weight 18)
  if (bb) {
    if      (bb.pct < 0.1)  score += 18;
    else if (bb.pct < 0.25) score += 12;
    else if (bb.pct < 0.4)  score += 6;
    else if (bb.pct > 0.85) score -= 18;
    else if (bb.pct > 0.7)  score -= 10;
    else if (bb.pct > 0.55) score -= 4;
  }

  // StochRSI (weight 12)
  if (stochRsi) {
    const v = stochRsi.value;
    if      (v < 0.15) score += 12;
    else if (v < 0.30) score += 7;
    else if (v < 0.50) score += 2;
    else if (v > 0.85) score -= 12;
    else if (v > 0.70) score -= 7;
  }

  // MACD histogram (weight 10)
  if (macd) {
    const sigAbs = Math.abs(macd.signal || 0);
    if      (macd.hist > 0 && macd.hist > sigAbs * 0.3) score += 10;
    else if (macd.hist > 0)                              score += 6;
    else if (macd.hist < 0 && Math.abs(macd.hist) > sigAbs * 0.3) score -= 8;
    else if (macd.hist < 0)                              score -= 4;
  }

  // VWAP (weight 8)
  if (vwap && price) {
    const devPct = ((price - vwap.value) / vwap.value) * 100;
    if      (devPct < -0.5) score += 8;
    else if (devPct < 0)    score += 4;
    else if (devPct > 1.0)  score -= 6;
    else if (devPct > 0.3)  score -= 2;
  }

  // EMA cross (weight 5)
  if (emaCross) {
    if      (emaCross.crossedUp)   score += 5;
    else if (emaCross.bullish)     score += 3;
    else if (emaCross.crossedDown) score -= 5;
    else                           score -= 2;
  }

  // Volume (weight 4)
  if (volRatio !== undefined) {
    if      (volRatio > 2.0) score += 4;
    else if (volRatio > 1.3) score += 2;
    else if (volRatio < 0.5) score -= 2;
  }

  // RSI divergence bonus/penalty
  if (divergence) {
    const pts = divergence.strength === 'strong' ? 12 : divergence.strength === 'moderate' ? 8 : 5;
    if (divergence.bullish)       score += pts;
    if (divergence.bearish)       score -= pts;
    if (divergence.hiddenBullish) score += 4;
    if (divergence.hiddenBearish) score -= 4;
  }

  // +50 shifts zero-signal baseline to 50/100
  return Math.max(0, Math.min(100, score + 50));
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 3 — Default Strategy
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Default entry signal: RSI oversold + near BB lower band + confluence above threshold.
 *
 * @param {Array<{t,o,h,l,c,v}>} candles
 * @param {object} ind - Output of calcIndicators()
 * @param {object} params
 * @returns {{ buy: boolean }}
 */
function checkEntry(candles, ind, params) {
  const {
    rsiOversold          = 35,
    bbPctEntry           = 0.35,
    confluenceThreshold  = 60,
  } = params;

  const { rsi, bb, bbPct, confluence } = ind;

  if (!bb) return { buy: false };

  const rsiBuy   = rsi < rsiOversold;
  const bbBuy    = bbPct < bbPctEntry;
  const confBuy  = confluence >= confluenceThreshold;

  return { buy: rsiBuy && bbBuy && confBuy };
}

/**
 * Default exit signal: RSI overbought OR upper BB OR ATR stop-loss OR MACD cross OR timeout.
 *
 * @param {Array<{t,o,h,l,c,v}>} candles
 * @param {object} ind - Output of calcIndicators()
 * @param {object} params
 * @param {object} position - Current open position state
 * @returns {{ sell: boolean, reason: string }}
 */
function checkExit(candles, ind, params, position) {
  const {
    rsiOverbought = 68,
    atrStopMult   = 1.5,
    maxHoldCandles = 96,  // default 96 candles (e.g. 4 days on 1h)
  } = params;

  const { rsi, bb, macd, atr } = ind;
  const cur = candles[candles.length - 1];
  const curClose = cur.c !== undefined ? cur.c : cur.close;

  // RSI overbought exit
  if (rsi > rsiOverbought) return { sell: true, reason: 'RSI_OVERBOUGHT' };

  // Upper Bollinger Band exit
  if (bb && curClose >= bb.upper) return { sell: true, reason: 'BB_UPPER' };

  // ATR stop-loss
  if (atr !== null && position.atrAtEntry !== null) {
    const stopPrice = position.entryPx - atrStopMult * position.atrAtEntry;
    if (curClose <= stopPrice) return { sell: true, reason: 'ATR_STOP' };
  }

  // MACD bearish crossover (hist flips from positive to negative)
  if (macd && position.prevMacdHist !== null && position.prevMacdHist !== undefined) {
    if (position.prevMacdHist > 0 && macd.hist < 0) return { sell: true, reason: 'MACD_CROSS' };
  }

  // Timeout: max hold period
  if (position.holdCandles >= maxHoldCandles) return { sell: true, reason: 'TIMEOUT' };

  return { sell: false, reason: '' };
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 4 — runBacktestOnCandles
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Event-driven backtest loop over a candle array.
 *
 * @param {Array<{t,o,h,l,c,v}>} candles
 * @param {object} [params={}] - Strategy parameters
 * @param {number} [slippage=0.0005] - Slippage fraction (0.05%)
 * @param {number} [feePct=0.0016] - Fee fraction per side (0.16%)
 * @param {Function} [entryFn=checkEntry] - Custom entry function
 * @param {Function} [exitFn=checkExit]   - Custom exit function
 * @returns {{ trades: object[], equity: object[], finalCash: number, startCash: number }}
 */
function runBacktestOnCandles(
  candles,
  params      = {},
  slippage    = 0.0005,
  feePct      = 0.0016,
  entryFn     = checkEntry,
  exitFn      = checkExit
) {
  const WARMUP     = 30;
  const START_CASH = 10000;
  const { riskPct = 0.10 } = params;

  let cash     = START_CASH;
  let position = null;  // { entryPx, size, cost, entryFee, entryTime, entryIdx, atrAtEntry, prevMacdHist, holdCandles }
  const trades = [];
  const equity = [];

  // pendingEntry/Exit: filled on NEXT candle's open
  let pendingEntry = false;
  let pendingExit  = false;
  let pendingExitReason = '';

  for (let i = 0; i < candles.length; i++) {
    const cur      = candles[i];
    const curOpen  = cur.o !== undefined ? cur.o  : cur.open;
    const curClose = cur.c !== undefined ? cur.c  : cur.close;

    // ── Fill pending entry on this candle's open ────────────────────────────
    if (pendingEntry && position === null) {
      const fillPx  = curOpen * (1 + slippage);
      const capital = cash * riskPct;
      const fee     = capital * feePct;
      const cost    = capital + fee;

      if (cost <= cash) {
        const size = capital / fillPx;
        const histVal = (() => {
          if (i >= WARMUP) {
            const slice = candles.slice(0, i);
            const closes = slice.map(c => c.c !== undefined ? c.c : c.close);
            const m = calcMACD(closes);
            return m ? m.hist : null;
          }
          return null;
        })();

        const atrVal = i > 0 ? calcATR(candles.slice(0, i + 1)) : null;

        position = {
          entryPx:      fillPx,
          size,
          cost:         capital,
          entryFee:     fee,
          entryTime:    cur.t,
          entryIdx:     i,
          atrAtEntry:   atrVal,
          prevMacdHist: histVal,
          holdCandles:  0,
        };
        cash -= cost;
      }
      pendingEntry = false;
    }

    // ── Fill pending exit on this candle's open ─────────────────────────────
    if (pendingExit && position !== null) {
      const fillPx = curOpen * (1 - slippage);
      const gross  = position.size * fillPx;
      const fee    = gross * feePct;
      const net    = gross - fee;
      const pnl    = net - position.cost - position.entryFee;
      const pnlPct = pnl / (position.cost + position.entryFee);
      const holdMs = (cur.t - position.entryTime) * 1000;  // t is unix seconds

      trades.push({
        entryIdx:   position.entryIdx,
        exitIdx:    i,
        entryPx:    position.entryPx,
        exitPx:     fillPx,
        size:       position.size,
        gross,
        fee:        position.entryFee + fee,
        pnl,
        pnlPct,
        holdMs,
        reason:     pendingExitReason,
        entryTime:  position.entryTime,
        exitTime:   cur.t,
        win:        pnl > 0,
      });

      cash     += net;
      position  = null;
      pendingExit       = false;
      pendingExitReason = '';
    }

    // ── Skip warmup candles for signal generation ───────────────────────────
    if (i < WARMUP) {
      const posVal = position ? position.size * curClose : 0;
      equity.push({ t: cur.t, v: cash + posVal });
      continue;
    }

    // ── Compute indicators on history up to current candle ──────────────────
    const history = candles.slice(0, i + 1);
    const ind     = calcIndicators(history, params);

    // ── Update hold counter and prev MACD hist for open position ───────────
    if (position !== null) {
      position.holdCandles++;
      if (ind.macd) position.prevMacdHist = ind.macd.hist;
    }

    // ── Exit check (signal generated on current candle, fill on next open) ──
    if (position !== null && !pendingExit) {
      const exitSig = exitFn(history, ind, params, position);
      if (exitSig.sell) {
        pendingExit       = true;
        pendingExitReason = exitSig.reason;
      }
    }

    // ── Entry check ─────────────────────────────────────────────────────────
    if (position === null && !pendingEntry && !pendingExit) {
      const entrySig = entryFn(history, ind, params);
      if (entrySig.buy) {
        pendingEntry = true;
      }
    }

    // ── Equity snapshot ─────────────────────────────────────────────────────
    const posVal = position ? position.size * curClose : 0;
    equity.push({ t: cur.t, v: cash + posVal });
  }

  // ── Close any open position at end of data ──────────────────────────────
  if (position !== null && candles.length > 0) {
    const last     = candles[candles.length - 1];
    const fillPx   = last.c !== undefined ? last.c : last.close;
    const gross    = position.size * fillPx;
    const fee      = gross * feePct;
    const net      = gross - fee;
    const pnl      = net - position.cost - position.entryFee;
    const pnlPct   = pnl / (position.cost + position.entryFee);
    const holdMs   = (last.t - position.entryTime) * 1000;

    trades.push({
      entryIdx:  position.entryIdx,
      exitIdx:   candles.length - 1,
      entryPx:   position.entryPx,
      exitPx:    fillPx,
      size:      position.size,
      gross,
      fee:       position.entryFee + fee,
      pnl,
      pnlPct,
      holdMs,
      reason:    'END_OF_DATA',
      entryTime: position.entryTime,
      exitTime:  last.t,
      win:       pnl > 0,
    });

    cash += net;
  }

  return { trades, equity, finalCash: cash, startCash: START_CASH };
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 5 — calcMetrics
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Compute full quant performance metrics from backtest results.
 *
 * @param {object[]} trades  - Trade objects from runBacktestOnCandles
 * @param {object[]} equity  - Equity curve [{t, v}]
 * @param {number}   startCash
 * @returns {object} Full metrics object
 */
function calcMetrics(trades, equity, startCash) {
  if (!trades || trades.length === 0) {
    return {
      totalTrades: 0, wins: 0, losses: 0, winRate: 0,
      profitFactor: 0, netPnl: 0, totalReturnPct: 0, annReturnPct: 0,
      sharpe: 0, sortino: 0, maxDrawdownPct: 0, maxDrawdownDays: 0,
      calmar: 0, avgWin: 0, avgLoss: 0, bestTrade: 0, worstTrade: 0,
      avgHoldHours: 0, finalCash: startCash, startCash,
    };
  }

  // Basic counts
  const wins   = trades.filter(t => t.win);
  const losses = trades.filter(t => !t.win);
  const winRate = wins.length / trades.length;

  // Profit factor
  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss   = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

  // Net P&L and return
  const netPnl         = trades.reduce((s, t) => s + t.pnl, 0);
  const finalCash      = startCash + netPnl;
  const totalReturnPct = (finalCash / startCash - 1) * 100;

  // Annualised return using equity curve time span
  let annReturnPct = 0;
  if (equity.length >= 2) {
    const spanDays = (equity[equity.length - 1].t - equity[0].t) / 86400;
    if (spanDays > 0) {
      const totalRet = finalCash / startCash;
      annReturnPct = (Math.pow(totalRet, 365 / spanDays) - 1) * 100;
    }
  }

  // Daily returns from equity curve for Sharpe / Sortino
  const dailyReturns = [];
  if (equity.length >= 2) {
    // Group equity snapshots into calendar days and compute daily pct returns
    const dayBuckets = new Map();
    for (const pt of equity) {
      const dayKey = Math.floor(pt.t / 86400);
      dayBuckets.set(dayKey, pt.v);
    }
    const days     = Array.from(dayBuckets.keys()).sort((a, b) => a - b);
    const dayVals  = days.map(d => dayBuckets.get(d));
    for (let i = 1; i < dayVals.length; i++) {
      if (dayVals[i - 1] > 0) {
        dailyReturns.push((dayVals[i] - dayVals[i - 1]) / dayVals[i - 1]);
      }
    }
  }

  // Sharpe ratio (annualised, risk-free = 0)
  let sharpe = 0;
  if (dailyReturns.length >= 2) {
    const meanR = dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length;
    const variance = dailyReturns.reduce((s, r) => s + Math.pow(r - meanR, 2), 0) / (dailyReturns.length - 1);
    const stdR = Math.sqrt(variance);
    sharpe = stdR > 0 ? (meanR / stdR) * Math.sqrt(252) : 0;
  }

  // Sortino ratio (downside deviation only)
  let sortino = 0;
  if (dailyReturns.length >= 2) {
    const meanR = dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length;
    const downsideVals = dailyReturns.filter(r => r < 0);
    if (downsideVals.length > 0) {
      const downVar = downsideVals.reduce((s, r) => s + r * r, 0) / downsideVals.length;
      const downStd = Math.sqrt(downVar);
      sortino = downStd > 0 ? (meanR / downStd) * Math.sqrt(252) : 0;
    }
  }

  // Max drawdown
  let maxDrawdownPct  = 0;
  let maxDrawdownDays = 0;
  if (equity.length >= 2) {
    let peak     = equity[0].v;
    let peakTime = equity[0].t;
    let dd       = 0;
    let ddDays   = 0;

    for (const pt of equity) {
      if (pt.v > peak) {
        peak     = pt.v;
        peakTime = pt.t;
        dd       = 0;
        ddDays   = 0;
      } else {
        dd     = (peak - pt.v) / peak;
        ddDays = (pt.t - peakTime) / 86400;
        if (dd > maxDrawdownPct) {
          maxDrawdownPct  = dd;
          maxDrawdownDays = ddDays;
        }
      }
    }
    maxDrawdownPct *= 100;
  }

  // Calmar ratio
  const calmar = maxDrawdownPct > 0 ? annReturnPct / maxDrawdownPct : annReturnPct > 0 ? Infinity : 0;

  // Trade statistics
  const avgWin  = wins.length   > 0 ? wins.reduce((s, t)   => s + t.pnlPct, 0) / wins.length   * 100 : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + t.pnlPct, 0) / losses.length * 100 : 0;
  const bestTrade  = trades.length > 0 ? Math.max(...trades.map(t => t.pnlPct)) * 100 : 0;
  const worstTrade = trades.length > 0 ? Math.min(...trades.map(t => t.pnlPct)) * 100 : 0;
  const avgHoldHours = trades.length > 0
    ? trades.reduce((s, t) => s + t.holdMs, 0) / trades.length / 3_600_000
    : 0;

  return {
    totalTrades:    trades.length,
    wins:           wins.length,
    losses:         losses.length,
    winRate:        Math.round(winRate * 10000) / 100,  // percent, 2dp
    profitFactor:   Math.round(profitFactor * 100) / 100,
    netPnl:         Math.round(netPnl * 100) / 100,
    totalReturnPct: Math.round(totalReturnPct * 100) / 100,
    annReturnPct:   Math.round(annReturnPct * 100) / 100,
    sharpe:         Math.round(sharpe * 100) / 100,
    sortino:        Math.round(sortino * 100) / 100,
    maxDrawdownPct: Math.round(maxDrawdownPct * 100) / 100,
    maxDrawdownDays: Math.round(maxDrawdownDays * 10) / 10,
    calmar:         Math.round(calmar * 100) / 100,
    avgWin:         Math.round(avgWin * 100) / 100,
    avgLoss:        Math.round(avgLoss * 100) / 100,
    bestTrade:      Math.round(bestTrade * 100) / 100,
    worstTrade:     Math.round(worstTrade * 100) / 100,
    avgHoldHours:   Math.round(avgHoldHours * 10) / 10,
    finalCash:      Math.round(finalCash * 100) / 100,
    startCash,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 6 — runWalkForward
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Walk-forward validation: split candles 70/30, run backtest on each half.
 *
 * @param {Array<{t,o,h,l,c,v}>} candles
 * @param {object} [params={}]
 * @param {number} [slippage=0.0005]
 * @param {number} [feePct=0.0016]
 * @param {number} [splitRatio=0.7]
 * @returns {{
 *   inSample:  { trades, equity, metrics, candleSpan },
 *   outSample: { trades, equity, metrics, candleSpan },
 *   splitIdx: number
 * }}
 */
function runWalkForward(candles, params = {}, slippage = 0.0005, feePct = 0.0016, splitRatio = 0.7) {
  const splitIdx = Math.floor(candles.length * splitRatio);
  const inCandles  = candles.slice(0, splitIdx);
  const outCandles = candles.slice(splitIdx);

  const inRes  = runBacktestOnCandles(inCandles,  params, slippage, feePct);
  const outRes = runBacktestOnCandles(outCandles, params, slippage, feePct);

  const inMetrics  = calcMetrics(inRes.trades,  inRes.equity,  inRes.startCash);
  const outMetrics = calcMetrics(outRes.trades, outRes.equity, outRes.startCash);

  const spanDays = (c) => c.length >= 2
    ? Math.round((c[c.length - 1].t - c[0].t) / 86400)
    : 0;

  return {
    inSample: {
      trades:    inRes.trades,
      equity:    inRes.equity,
      metrics:   inMetrics,
      candleSpan: spanDays(inCandles),
    },
    outSample: {
      trades:    outRes.trades,
      equity:    outRes.equity,
      metrics:   outMetrics,
      candleSpan: spanDays(outCandles),
    },
    splitIdx,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 7 — runOptimizer
// ═══════════════════════════════════════════════════════════════════════════════

/** Parameter grid for optimisation. */
const PARAM_GRID = {
  rsiOversold:          [25, 30, 35, 40],
  rsiOverbought:        [65, 68, 72, 75],
  bbPeriod:             [15, 20, 25],
  bbStd:                [1.5, 2.0, 2.5],
  confluenceThreshold:  [55, 60, 65, 70],
  bbPctEntry:           [0.25, 0.35, 0.45],
  atrStopMult:          [1.2, 1.5, 2.0],
  riskPct:              [0.05, 0.10, 0.15],
};

/**
 * Generate all combinations from the param grid.
 * @param {object} grid
 * @returns {object[]}
 */
function generateCombinations(grid) {
  const keys   = Object.keys(grid);
  const combos = [{}];

  for (const key of keys) {
    const expanded = [];
    for (const existing of combos) {
      for (const val of grid[key]) {
        expanded.push({ ...existing, [key]: val });
      }
    }
    combos.length = 0;
    combos.push(...expanded);
  }
  return combos;
}

/**
 * Deterministic Fisher-Yates shuffle sample (no crypto dependency).
 * @param {any[]} arr
 * @param {number} n
 * @returns {any[]}
 */
function sampleRandom(arr, n) {
  const copy = arr.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, n);
}

/**
 * Grid-search optimiser with walk-forward validation.
 *
 * @param {Array<{t,o,h,l,c,v}>} candles
 * @param {number} [slippage=0.0005]
 * @param {number} [feePct=0.0016]
 * @param {number} [maxCombos=500]
 * @returns {{
 *   totalTested: number,
 *   top10: object[],
 *   best: object,
 *   inSamplePeriod:  { start: number, end: number, days: number },
 *   outSamplePeriod: { start: number, end: number, days: number }
 * }}
 */
function runOptimizer(candles, slippage = 0.0005, feePct = 0.0016, maxCombos = 500) {
  const splitIdx  = Math.floor(candles.length * 0.7);
  const inCandles  = candles.slice(0, splitIdx);
  const outCandles = candles.slice(splitIdx);

  let combos = generateCombinations(PARAM_GRID);
  if (combos.length > maxCombos) {
    combos = sampleRandom(combos, maxCombos);
  }

  const results = [];

  for (const params of combos) {
    const inRes = runBacktestOnCandles(inCandles, params, slippage, feePct);
    if (inRes.trades.length < 5) continue;  // too few trades — skip

    const inMetrics = calcMetrics(inRes.trades, inRes.equity, inRes.startCash);
    results.push({ params, inMetrics });
  }

  // Sort top 10 by in-sample Sharpe
  results.sort((a, b) => b.inMetrics.sharpe - a.inMetrics.sharpe);
  const top10raw = results.slice(0, 10);

  // Validate top 10 on out-of-sample
  const top10 = top10raw.map(r => {
    const outRes    = runBacktestOnCandles(outCandles, r.params, slippage, feePct);
    const outMetrics = calcMetrics(outRes.trades, outRes.equity, outRes.startCash);

    const degradation = r.inMetrics.sharpe > 0
      ? ((r.inMetrics.sharpe - outMetrics.sharpe) / r.inMetrics.sharpe) * 100
      : 0;
    const recommended = outMetrics.sharpe > 0.5 && degradation < 50;

    return {
      params:      r.params,
      inMetrics:   r.inMetrics,
      outMetrics,
      degradation: Math.round(degradation * 100) / 100,
      recommended,
    };
  });

  // Best = highest out-of-sample Sharpe among recommended; fallback to highest in-sample
  const recommended = top10.filter(r => r.recommended);
  const best = recommended.length > 0
    ? recommended.sort((a, b) => b.outMetrics.sharpe - a.outMetrics.sharpe)[0]
    : top10[0];

  const periodInfo = (c) => ({
    start: c.length ? c[0].t : 0,
    end:   c.length ? c[c.length - 1].t : 0,
    days:  c.length >= 2 ? Math.round((c[c.length - 1].t - c[0].t) / 86400) : 0,
  });

  return {
    totalTested:     results.length,
    top10,
    best,
    inSamplePeriod:  periodInfo(inCandles),
    outSamplePeriod: periodInfo(outCandles),
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 8 — Binance Data Fetcher
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Map Kraken pair names to Binance symbol strings.
 * @param {string} krakenPair
 * @returns {string} e.g. 'BTCUSDT'
 */
function krakenToBinancePair(krakenPair) {
  const MAP = {
    'XXBTZUSD':  'BTCUSDT',
    'XBTUSD':    'BTCUSDT',
    'BTCUSD':    'BTCUSDT',
    'XETHZUSD':  'ETHUSDT',
    'ETHUSD':    'ETHUSDT',
    'XRPUSD':    'XRPUSDT',
    'XXRPZUSD':  'XRPUSDT',
    'SOLUSD':    'SOLUSDT',
    'ADAUSD':    'ADAUSDT',
    'DOTUSD':    'DOTUSDT',
    'DOGEUSD':   'DOGEUSDT',
    'AVAXUSD':   'AVAXUSDT',
    'MATICUSD':  'MATICUSDT',
    'LINKUSD':   'LINKUSDT',
    'LTCUSD':    'LTCUSDT',
    'BCHUSD':    'BCHUSDT',
    'UNIUSD':    'UNIUSDT',
    'ATOMUSD':   'ATOMUSDT',
    'XLMUSD':    'XLMUSDT',
    'XMRUSD':    'XMRUSDT',
    'FILUSD':    'FILUSDT',
    'TRXUSD':    'TRXUSDT',
    'BNBUSD':    'BNBUSDT',
    'NEARUSD':   'NEARUSDT',
    'APTUSD':    'APTUSDT',
    'ARBUSD':    'ARBUSDT',
    'OPUSD':     'OPUSDT',
    'INJUSD':    'INJUSDT',
    'SUIUSD':    'SUIUSDT',
    'SEIUSD':    'SEIUSDT',
    'WIFUSD':    'WIFUSDT',
    'PEPEUSD':   'PEPEUSDT',
    'BONKUSD':   'BONKUSDT',
  };

  const upper = krakenPair.toUpperCase();
  if (MAP[upper]) return MAP[upper];

  // Generic fallback: strip trailing USD/ZUSD and append USDT
  const stripped = upper
    .replace(/^X([A-Z]{3,4})ZUSD$/, '$1')  // XXBTZUSD → XBT (special case handled above)
    .replace(/USD$/, '');
  return stripped + 'USDT';
}

/**
 * Map candle interval in minutes to Binance interval string.
 * @param {number} minutes
 * @returns {string}
 */
function krakenToBinanceInterval(minutes) {
  const MAP = {
    1:    '1m',
    3:    '3m',
    5:    '5m',
    15:   '15m',
    30:   '30m',
    60:   '1h',
    120:  '2h',
    240:  '4h',
    360:  '6h',
    480:  '8h',
    720:  '12h',
    1440: '1d',
    4320: '3d',
    10080:'1w',
  };
  return MAP[minutes] || '1h';
}

/**
 * Fetch Binance klines (candles) via HTTPS.
 *
 * @param {string} symbol   - e.g. 'BTCUSDT'
 * @param {string} interval - e.g. '1h'
 * @param {number} [limit=1000]
 * @param {number|null} [endTime=null] - Unix ms; if provided, fetch candles ending here
 * @returns {Promise<Array<{t,o,h,l,c,v}>>} Array of normalised candle objects
 */
function fetchBinanceKlines(symbol, interval, limit = 1000, endTime = null) {
  return new Promise((resolve, reject) => {
    let path = `/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    if (endTime) path += `&endTime=${endTime}`;

    const options = {
      hostname: 'api.binance.com',
      path,
      method:  'GET',
      headers: { 'User-Agent': 'NEXUS-Backtest/1.0' },
    };

    const req = https.request(options, (res) => {
      let raw = '';
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(raw);
          if (!Array.isArray(parsed)) {
            reject(new Error(`Binance error: ${raw.slice(0, 200)}`));
            return;
          }
          // Binance kline: [openTime, open, high, low, close, volume, ...]
          const candles = parsed.map(k => ({
            t: Math.floor(k[0] / 1000),  // ms → seconds
            o: parseFloat(k[1]),
            h: parseFloat(k[2]),
            l: parseFloat(k[3]),
            c: parseFloat(k[4]),
            v: parseFloat(k[5]),
          }));
          resolve(candles);
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Binance request timed out')); });
    req.end();
  });
}

/**
 * Paginate backwards through Binance API to collect `daysBack` days of candles.
 * Falls back to null on failure — caller should handle Kraken fallback.
 *
 * @param {string} krakenPair  - e.g. 'XRPUSD'
 * @param {number} candleInt   - Interval in minutes
 * @param {number} [daysBack=90]
 * @returns {Promise<Array<{t,o,h,l,c,v}>|null>}
 */
async function fetchDeepHistory(krakenPair, candleInt, daysBack = 90) {
  try {
    const symbol   = krakenToBinancePair(krakenPair);
    const interval = krakenToBinanceInterval(candleInt);
    const candleMs = candleInt * 60 * 1000;
    const nowMs    = Date.now();
    const startMs  = nowMs - daysBack * 24 * 60 * 60 * 1000;

    const allCandles = new Map();  // keyed by open-time seconds for dedup
    let   endTime    = nowMs;
    const BATCH      = 1000;

    // Safety cap: max iterations to prevent runaway loops
    const maxIter = Math.ceil((daysBack * 24 * 60) / (candleInt * BATCH)) + 5;
    let   iter    = 0;

    while (endTime > startMs && iter < maxIter) {
      iter++;
      const batch = await fetchBinanceKlines(symbol, interval, BATCH, endTime);
      if (!batch || batch.length === 0) break;

      for (const c of batch) {
        allCandles.set(c.t, c);
      }

      // Oldest candle in this batch
      const oldestT = batch[0].t;
      endTime = oldestT * 1000 - candleMs;  // move window back by one candle

      // If this batch starts before our target, we're done
      if (oldestT * 1000 <= startMs) break;
    }

    if (allCandles.size === 0) return null;

    // Sort ascending by time, trim to requested window
    const sorted = Array.from(allCandles.values())
      .filter(c => c.t * 1000 >= startMs)
      .sort((a, b) => a.t - b.t);

    return sorted.length > 0 ? sorted : null;
  } catch (err) {
    console.error('[fetchDeepHistory] Binance fetch failed:', err.message);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

module.exports = {
  // Indicator functions
  calcRSI,
  calcBB,
  calcEMA,
  calcEMAArr,
  calcMACD,
  calcATR,
  calcVWAP,
  calcStochRSI,

  // Composite indicator bundle
  calcIndicators,
  calcConfluenceScore,

  // Default strategy
  checkEntry,
  checkExit,

  // Core backtest loop
  runBacktestOnCandles,

  // Metrics
  calcMetrics,

  // Walk-forward
  runWalkForward,

  // Optimiser
  runOptimizer,
  PARAM_GRID,
  generateCombinations,

  // Binance data
  krakenToBinancePair,
  krakenToBinanceInterval,
  fetchBinanceKlines,
  fetchDeepHistory,
};
