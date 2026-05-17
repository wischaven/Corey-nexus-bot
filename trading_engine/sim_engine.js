// ═══════════════════════════════════════════════════════════════════════════
// NEXUS SimEngine v2 — Real-data parallel simulation + continuous learning
//
// DATA FLOW:
//   Kraken OHLC (1m, 200 candles) ──┐
//   Kraken Ticker (bid/ask/last)  ──┤→ Indicators → Confluence Score
//   Kraken Depth (20 levels)      ──┘              → Entry/Exit Decision
//                                                    → Online Parameter Adaptation
//                                                    → Regime-aware param sets
//                                                    → Kelly position sizing
//
// LEARNING:
//   After EVERY completed trade:
//     1. Stochastic gradient nudge on all params based on outcome
//     2. Feature importance weights updated (which signals predicted correctly?)
//     3. Regime-specific param set updated separately
//     4. Kelly fraction recalculated from rolling win/loss stats
//     5. Save to disk
// ═══════════════════════════════════════════════════════════════════════════

'use strict';

const https = require('https');
const fs    = require('fs');
const path  = require('path');

const {
  calcRSI, calcBB, calcMACD, calcATR, calcVWAP,
  calcStochRSI, calcEMACross, calcROC, calcVolumeRatio,
  detectRegime, getVerdict, calcKelly, calcConfluenceScore,
  detectDivergence,
} = require('./indicators');

const { fetchOrderBook, summarizeBook } = require('./order_book');

const DATA_FILE        = path.join(__dirname, '..', 'sim_data.json');
const POLL_INTERVAL_MS = 30000;  // main tick: 30s (matches Kraken rate limits)
const OB_INTERVAL_MS   = 12000;  // order book: every 12s (faster signal)

// ─── Default params (all tunable by learning) ────────────────────────────
const DEFAULT_PARAMS = {
  // Entry gates
  // SHX/USD fees = 0.16% × 2 sides = 32 bps round-trip break-even.
  // maxSpreadBps must be ABOVE 32 — wide spread = opportunity on thin markets.
  // minNetBps is profit after fees: need spread > (32 + minNetBps) to enter.
  confluenceThreshold: 50,   // 0–100, minimum score to enter trade
  maxSpreadBps:        200,  // SHX/USD can spread 50–200 bps — that's the opportunity
  minNetBps:           5,    // need 5 bps profit after 32 bps fees → spread must be > 37 bps
  rsiThreshold:        72,   // reject long if RSI above this

  // Exit / risk
  atrStopMult:    1.5,   // stop = entry − atrStopMult × ATR
  atrTpMult:      2.5,   // take-profit = entry + atrTpMult × ATR
  maxHoldSecs:    300,   // 5-min timeout

  // Sizing
  feeRatePct:    0.16,   // 0.16% maker
  baseOrderUSD:  50,     // base position size

  // Exploration (epsilon-greedy online learning)
  exploreRate:   0.10,   // 10% of trades use randomly perturbed params
};

// ─── Regime-specific param overrides ─────────────────────────────────────
const REGIME_DEFAULTS = {
  TRENDING_UP:   { confluenceThreshold: 50, atrStopMult: 1.2, atrTpMult: 3.0 },
  TRENDING_DOWN: { confluenceThreshold: 70, atrStopMult: 2.0, atrTpMult: 1.5 },
  RANGING:       { confluenceThreshold: 55, atrStopMult: 1.5, atrTpMult: 2.0 },
  VOLATILE:      { confluenceThreshold: 75, atrStopMult: 2.5, atrTpMult: 2.0 },
};

// ─── Feature names (for importance tracking) ─────────────────────────────
const FEATURES = ['obi', 'rsi', 'bb', 'stochRsi', 'macd', 'vwap', 'emaCross', 'volume'];

class SimEngine {
  constructor() {
    this.params = { ...DEFAULT_PARAMS };

    // Regime-specific params: each regime has its own copy, updated independently
    this.regimeParams = {
      TRENDING_UP:   { ...DEFAULT_PARAMS, ...REGIME_DEFAULTS.TRENDING_UP },
      TRENDING_DOWN: { ...DEFAULT_PARAMS, ...REGIME_DEFAULTS.TRENDING_DOWN },
      RANGING:       { ...DEFAULT_PARAMS, ...REGIME_DEFAULTS.RANGING },
      VOLATILE:      { ...DEFAULT_PARAMS, ...REGIME_DEFAULTS.VOLATILE },
    };

    // Feature importance: { featureName: { correct: 0, total: 0, weight: 0.5 } }
    this.featureImportance = {};
    for (const f of FEATURES) {
      this.featureImportance[f] = { correct: 0, total: 0, weight: 0.5 };
    }

    // Data
    this.candles   = [];
    this.ticker    = null;
    this.orderBook = null;
    this.indicators = {};

    // Trade state
    this.openTrade  = null;
    this.simTrades  = [];
    this.paramLog   = [];  // log of every param adjustment
    this.regime     = 'RANGING';
    this.kellyFrac  = 0.05;

    // Active pair — mirrors the user's selected ticker
    this.pair = 'XRPUSD';

    // Intervals
    this._tickInterval = null;
    this._obInterval   = null;
    this._ready        = false;
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────────

  start() {
    this._load();
    this._tickInterval = setInterval(() => this._tick(), POLL_INTERVAL_MS);
    this._obInterval   = setInterval(() => this._fetchOrderBook(), OB_INTERVAL_MS);
    this._tick();
    console.log('[SimEngine v2] Started — OHLC every 30s, order book every 12s');
  }

  stop() {
    clearInterval(this._tickInterval);
    clearInterval(this._obInterval);
  }

  // ─── Main tick ──────────────────────────────────────────────────────────

  async _tick() {
    try {
      await this._fetchOHLC();
      await this._fetchTicker();
      this._calcAllIndicators();
      this._checkOpenTrade();
      this._evalEntry();
    } catch (err) {
      console.error('[SimEngine] tick error:', err.message);
    }
  }

  // ─── HTTP helper ────────────────────────────────────────────────────────

  _krakenGet(endpoint) {
    return new Promise((resolve, reject) => {
      const req = https.request(
        { hostname: 'api.kraken.com', path: '/' + endpoint, method: 'GET',
          headers: { 'User-Agent': 'NexusBot/4.0' } },
        (res) => {
          let data = '';
          res.on('data', c => { data += c; });
          res.on('end', () => {
            try { resolve(JSON.parse(data)); }
            catch (e) { reject(new Error('JSON parse: ' + e.message)); }
          });
        }
      );
      req.on('error', reject);
      req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout')); });
      req.end();
    });
  }

  // ─── Data fetching ──────────────────────────────────────────────────────

  setPair(pair) {
    if (pair === this.pair) return;
    this.pair   = pair;
    this._ready = false;
    this.candles    = [];
    this.ticker     = null;
    this.orderBook  = null;
    this.openTrade  = null; // close any open paper trade on pair switch
    console.log('[SimEngine] Switched to pair:', pair);
    // Immediate tick on pair change so data populates quickly
    this._tick().catch(() => {});
  }

  async _fetchOHLC() {
    const res = await this._krakenGet(`0/public/OHLC?pair=${this.pair}&interval=1`);
    if (res.error && res.error.length) throw new Error(res.error.join(', '));
    const result = res.result || {};
    const key = Object.keys(result).find(k => k !== 'last');
    if (!key) throw new Error('No OHLC key');
    this.candles = result[key].slice(-200).map(c => ({
      time: c[0], open: parseFloat(c[1]), high: parseFloat(c[2]),
      low: parseFloat(c[3]), close: parseFloat(c[4]), volume: parseFloat(c[6]),
    }));
  }

  async _fetchTicker() {
    const res = await this._krakenGet(`0/public/Ticker?pair=${this.pair}`);
    if (res.error && res.error.length) throw new Error(res.error.join(', '));
    const key = Object.keys(res.result || {})[0];
    if (!key) throw new Error('No ticker key');
    const t = res.result[key];
    this.ticker = {
      bid: parseFloat(t.b[0]), ask: parseFloat(t.a[0]),
      last: parseFloat(t.c[0]), vol24: parseFloat(t.v[1]),
    };
    this._ready = true;
  }

  async _fetchOrderBook() {
    try {
      this.orderBook = await fetchOrderBook(this._krakenGet.bind(this), this.pair, 20);
    } catch (e) {
      // Order book errors are non-fatal — OBI will be null
      console.warn('[SimEngine] Order book fetch failed:', e.message);
    }
  }

  // ─── Indicator calculation ───────────────────────────────────────────────

  _calcAllIndicators() {
    if (this.candles.length < 35) return;

    const closes  = this.candles.map(c => c.close);
    const volumes = this.candles.map(c => c.volume);
    const last    = closes[closes.length - 1];

    const rsi      = calcRSI(closes, 14);
    const bb       = calcBB(closes, 20, 2);
    const macd     = calcMACD(closes, 12, 26, 9);
    const atr      = calcATR(this.candles, 14);
    const vwap     = calcVWAP(this.candles);
    const stochRsi = calcStochRSI(closes, 14, 14);
    const emaCross = calcEMACross(closes, 9, 21);
    const roc        = calcROC(closes, 10);
    const volRatio   = calcVolumeRatio(volumes, 20);
    const divergence = detectDivergence(closes, 14, 30);
    const verdict    = getVerdict(rsi, bb, macd);

    // Order book (may be null if fetch failed)
    const bookSummary = this.orderBook
      ? summarizeBook(this.orderBook, this.params.baseOrderUSD, last)
      : null;
    const obi = bookSummary ? bookSummary.obi : null;

    const regime = detectRegime(this.candles, emaCross, atr, bb);
    this.regime = regime;

    const confluenceScore = calcConfluenceScore({
      rsi, bb, macd, obi, stochRsi, vwap, emaCross, volRatio, price: last, divergence,
    });

    // Kelly from rolling trade stats
    const recent = this.simTrades.slice(-30);
    if (recent.length >= 10) {
      const wins    = recent.filter(t => t.win);
      const losses  = recent.filter(t => !t.win);
      const wr      = wins.length / recent.length;
      const avgWin  = wins.length  ? wins.reduce((s, t) => s + t.pnlBps, 0) / wins.length : 1;
      const avgLoss = losses.length ? Math.abs(losses.reduce((s, t) => s + t.pnlBps, 0) / losses.length) : 1;
      this.kellyFrac = calcKelly(wr, avgWin, avgLoss);
    }

    this.indicators = {
      rsi, bb, macd, atr, vwap, stochRsi, emaCross, roc,
      volRatio, verdict, obi, bookSummary, regime, confluenceScore,
      divergence,
      kellyFrac: this.kellyFrac,
      price: last,
    };
  }

  // ─── Entry decision (confluence-based) ──────────────────────────────────

  _evalEntry() {
    if (!this._ready || this.openTrade) return;
    if (!this.ticker || !this.indicators.bb) return;

    const ind    = this.indicators;
    const p      = this._getActiveParams();
    const { bid, ask } = this.ticker;

    const spreadBps = ((ask - bid) / bid) * 10000;
    const feesBps   = (p.feeRatePct / 100) * 2 * 10000;
    const netBps    = spreadBps - feesBps;

    // Hard filters (non-negotiable)
    if (spreadBps < 1 || spreadBps > p.maxSpreadBps) return;
    if (netBps < p.minNetBps) return;
    if (ind.rsi > p.rsiThreshold) return;

    // Confluence gate (replaces old BEARISH hard block)
    if (ind.confluenceScore < p.confluenceThreshold) return;

    // ATR-based stops and targets
    const atrVal = ind.atr ? ind.atr.value : (ask * 0.005); // fallback 0.5%
    const stopPrice   = ask - (p.atrStopMult * atrVal);
    const targetPrice = ask + (p.atrTpMult  * atrVal);

    // Kelly-adjusted order size
    const orderSizeUSD = p.baseOrderUSD * Math.max(0.5, Math.min(2.0, this.kellyFrac / 0.05));

    // Epsilon-greedy: occasionally perturb params to explore new territory
    const exploring = Math.random() < p.exploreRate;

    this.openTrade = {
      id:              Date.now(),
      entryTime:       Date.now(),
      entryPrice:      ask,
      stopPrice,
      targetPrice,
      spreadBpsAtEntry: spreadBps,
      netBpsAtEntry:    netBps,
      feesBps,
      orderSizeUSD,
      // Snapshot all signals at entry (used for feature importance + online learning)
      rsi:             ind.rsi,
      bbPct:           ind.bb ? ind.bb.pct : null,
      bbWidth:         ind.bb ? ind.bb.width : null,
      macdHist:        ind.macd ? ind.macd.hist : null,
      obi:             ind.obi,
      stochRsi:        ind.stochRsi ? ind.stochRsi.value : null,
      vwapDev:         ind.vwap ? ind.vwap.devPct : null,
      emaBullish:      ind.emaCross ? ind.emaCross.bullish : null,
      volRatio:        ind.volRatio,
      confluenceScore: ind.confluenceScore,
      verdict:         ind.verdict,
      regime:          ind.regime,
      kellyFrac:       this.kellyFrac,
      exploring,
      paramsUsed:      { ...p },
    };

    console.log(
      `[SimEngine] ENTER @ ${ask.toFixed(6)}` +
      ` score=${ind.confluenceScore.toFixed(0)} OBI=${(ind.obi||0).toFixed(2)}` +
      ` regime=${ind.regime} spread=${spreadBps.toFixed(1)}bps` +
      (exploring ? ' [EXPLORE]' : '')
    );
  }

  // ─── Exit decision ───────────────────────────────────────────────────────

  _checkOpenTrade() {
    if (!this.openTrade || !this.ticker) return;

    const price   = this.ticker.last;
    const elapsed = (Date.now() - this.openTrade.entryTime) / 1000;
    let exit = null;

    if (price >= this.openTrade.targetPrice) {
      exit = { reason: 'takeProfit', exitPrice: price };
    } else if (price <= this.openTrade.stopPrice) {
      exit = { reason: 'stopLoss', exitPrice: price };
    } else if (elapsed > this._getActiveParams().maxHoldSecs) {
      exit = { reason: 'timeout', exitPrice: price };
    }

    // Early exit: if OBI flips strongly bearish while in a trade, exit early
    if (!exit && this.indicators.obi !== null && this.indicators.obi < -0.4) {
      const unrealised = ((price - this.openTrade.entryPrice) / this.openTrade.entryPrice) * 10000;
      if (unrealised > 0) {
        exit = { reason: 'obiExit', exitPrice: price }; // lock in profit before reversal
      }
    }

    if (!exit) return;

    const grossBps = ((exit.exitPrice - this.openTrade.entryPrice) / this.openTrade.entryPrice) * 10000;
    const pnlBps   = grossBps - this.openTrade.feesBps;
    const pnlUSD   = (pnlBps / 10000) * this.openTrade.orderSizeUSD;

    const trade = {
      ...this.openTrade,
      exitTime:   Date.now(),
      exitPrice:  exit.exitPrice,
      exitReason: exit.reason,
      grossBps,
      pnlBps,
      pnlUSD,
      win: pnlBps > 0,
    };

    this.simTrades.push(trade);
    this.openTrade = null;

    console.log(
      `[SimEngine] EXIT ${exit.reason} pnl=${pnlBps.toFixed(2)}bps` +
      ` ($${pnlUSD.toFixed(4)}) total=${this.simTrades.length} trades`
    );

    // ── Online learning: adapt after every trade ──────────────────────────
    this._onlineAdapt(trade);
    this._updateFeatureImportance(trade);
    this._save();
  }

  // ─── Continuous online parameter adaptation ──────────────────────────────
  // Stochastic gradient: nudge params toward better outcomes after every trade.
  // Each param moves a small amount (lr) in the direction that would have
  // improved this trade's outcome. Separate regime params updated independently.

  _onlineAdapt(trade) {
    const lr   = 0.04;  // learning rate per trade
    const won  = trade.win;
    const p    = this.params;
    const adjustments = {};

    // ── Confluence threshold ──────────────────────────────────────────────
    if (!won && trade.confluenceScore < 65) {
      // Lost on low-confidence signal — raise the bar
      const adj = lr * (65 - trade.confluenceScore) / 10;
      p.confluenceThreshold = clamp(p.confluenceThreshold + adj, 40, 80);
      adjustments.confluenceThreshold = +adj.toFixed(2);
    } else if (won && trade.confluenceScore >= p.confluenceThreshold) {
      // Won — this threshold is working, slight decay toward 55
      p.confluenceThreshold = clamp(p.confluenceThreshold - lr * 0.3, 40, 80);
      adjustments.confluenceThreshold = -(lr * 0.3).toFixed(2);
    }

    // ── RSI threshold ─────────────────────────────────────────────────────
    if (!won && trade.rsi > 60) {
      const adj = lr * (trade.rsi - 55) / 10;
      p.rsiThreshold = clamp(p.rsiThreshold - adj, 55, 75);
      adjustments.rsiThreshold = -adj.toFixed(2);
    } else if (won) {
      p.rsiThreshold = clamp(p.rsiThreshold + lr * 0.2, 55, 75);
      adjustments.rsiThreshold = +(lr * 0.2).toFixed(2);
    }

    // ── Max spread ────────────────────────────────────────────────────────
    if (!won && trade.spreadBpsAtEntry > 12) {
      const adj = lr * 0.8;
      p.maxSpreadBps = clamp(p.maxSpreadBps - adj, 8, 60);
      adjustments.maxSpreadBps = -adj.toFixed(2);
    } else if (won) {
      const adj = lr * 0.25;
      p.maxSpreadBps = clamp(p.maxSpreadBps + adj, 8, 60);
      adjustments.maxSpreadBps = +adj.toFixed(2);
    }

    // ── Min net bps ───────────────────────────────────────────────────────
    if (!won) {
      const adj = lr * 0.4;
      p.minNetBps = clamp(p.minNetBps + adj, 0.5, 12);
      adjustments.minNetBps = +adj.toFixed(2);
    } else if (won && trade.pnlBps > p.minNetBps * 3) {
      const adj = lr * 0.15;
      p.minNetBps = clamp(p.minNetBps - adj, 0.5, 12);
      adjustments.minNetBps = -adj.toFixed(2);
    }

    // ── ATR stop multiplier ───────────────────────────────────────────────
    if (trade.exitReason === 'stopLoss') {
      // Hit stop — it might be too tight
      p.atrStopMult = clamp(p.atrStopMult + 0.06, 1.0, 4.0);
      adjustments.atrStopMult = +0.06;
    } else if (won && trade.exitReason === 'takeProfit') {
      // Clean TP hit — stop was fine
      p.atrStopMult = clamp(p.atrStopMult - 0.02, 1.0, 4.0);
      adjustments.atrStopMult = -0.02;
    }

    // ── ATR take-profit multiplier ────────────────────────────────────────
    if (trade.exitReason === 'timeout' && !won) {
      // Held too long and didn't hit TP — TP might be too ambitious
      p.atrTpMult = clamp(p.atrTpMult - 0.05, 1.0, 5.0);
      adjustments.atrTpMult = -0.05;
    } else if (won && trade.exitReason === 'takeProfit') {
      p.atrTpMult = clamp(p.atrTpMult + 0.02, 1.0, 5.0);
      adjustments.atrTpMult = +0.02;
    }

    // ── Apply same adjustments to the active regime's params ──────────────
    const rp = this.regimeParams[trade.regime];
    if (rp) {
      if (adjustments.confluenceThreshold !== undefined)
        rp.confluenceThreshold = clamp(rp.confluenceThreshold + adjustments.confluenceThreshold * 0.5, 40, 85);
      if (adjustments.maxSpreadBps !== undefined)
        rp.maxSpreadBps = clamp(rp.maxSpreadBps + adjustments.maxSpreadBps * 0.5, 8, 60);
      if (adjustments.minNetBps !== undefined)
        rp.minNetBps = clamp(rp.minNetBps + adjustments.minNetBps * 0.5, 0.5, 12);
      if (adjustments.atrStopMult !== undefined)
        rp.atrStopMult = clamp(rp.atrStopMult + adjustments.atrStopMult * 0.5, 1.0, 4.0);
    }

    // Log adjustment
    if (Object.keys(adjustments).length > 0) {
      this.paramLog.push({
        time: Date.now(),
        won,
        regime: trade.regime,
        score: trade.confluenceScore,
        pnlBps: +trade.pnlBps.toFixed(2),
        adjustments,
        params: {
          confluenceThreshold: +p.confluenceThreshold.toFixed(1),
          rsiThreshold:        +p.rsiThreshold.toFixed(1),
          maxSpreadBps:        +p.maxSpreadBps.toFixed(1),
          minNetBps:           +p.minNetBps.toFixed(2),
          atrStopMult:         +p.atrStopMult.toFixed(2),
          atrTpMult:           +p.atrTpMult.toFixed(2),
        },
      });
      // Keep log to last 200 entries
      if (this.paramLog.length > 200) this.paramLog.shift();
    }
  }

  // ─── Feature importance update ───────────────────────────────────────────
  // Tracks how often each signal was pointing in the right direction at entry.
  // "Correct" = signal was bullish and trade won, or signal was bearish and was avoided.

  _updateFeatureImportance(trade) {
    const update = (name, signalBullish) => {
      const fi = this.featureImportance[name];
      fi.total++;
      if ((signalBullish && trade.win) || (!signalBullish && !trade.win)) fi.correct++;
      fi.weight = fi.total > 0 ? fi.correct / fi.total : 0.5;
    };

    if (trade.obi !== null)      update('obi',      trade.obi > 0);
    if (trade.rsi !== null)      update('rsi',      trade.rsi < 50);
    if (trade.bbPct !== null)    update('bb',       trade.bbPct < 0.5);
    if (trade.stochRsi !== null) update('stochRsi', trade.stochRsi < 0.5);
    if (trade.macdHist !== null) update('macd',     trade.macdHist > 0);
    if (trade.vwapDev !== null)  update('vwap',     trade.vwapDev < 0);
    if (trade.emaBullish !== null) update('emaCross', trade.emaBullish);
    if (trade.volRatio !== null) update('volume',   trade.volRatio > 1);
  }

  // ─── Active params: merge global + regime overrides ──────────────────────

  _getActiveParams() {
    const regimeP = this.regimeParams[this.regime] || {};
    return { ...this.params, ...regimeP };
  }

  // ─── Public API ──────────────────────────────────────────────────────────

  getStatus() {
    const all    = this.simTrades;
    const recent = all.slice(-20);
    const wins   = all.filter(t => t.win);
    const losses = all.filter(t => !t.win);

    const avgWinBps  = wins.length   ? wins.reduce((s, t) => s + t.pnlBps, 0) / wins.length : 0;
    const avgLossBps = losses.length ? losses.reduce((s, t) => s + t.pnlBps, 0) / losses.length : 0;

    // Profit factor: gross wins / gross losses (> 1 = profitable)
    const grossWins   = wins.reduce((s, t) => s + t.pnlBps, 0);
    const grossLosses = Math.abs(losses.reduce((s, t) => s + t.pnlBps, 0));
    const profitFactor = grossLosses > 0 ? grossWins / grossLosses : grossWins > 0 ? 99 : 0;

    // Running P&L curve
    let running = 0;
    const pnlCurve = all.slice(-50).map(t => {
      running += t.pnlUSD;
      return { time: t.exitTime, pnl: +running.toFixed(4) };
    });

    return {
      ready:        this._ready,
      pair:         this.pair,
      totalTrades:  all.length,
      winRate:      all.length > 0 ? wins.length / all.length : 0,
      totalPnlBps:  all.reduce((s, t) => s + t.pnlBps, 0),
      totalPnlUSD:  all.reduce((s, t) => s + t.pnlUSD, 0),
      avgPnlBps:    all.length > 0 ? all.reduce((s, t) => s + t.pnlBps, 0) / all.length : 0,
      avgWinBps,
      avgLossBps,
      profitFactor: +profitFactor.toFixed(2),
      openTrade:    this.openTrade,
      recentTrades: recent.map(t => ({
        time:        t.entryTime,
        exitTime:    t.exitTime,
        entry:       t.entryPrice,
        exit:        t.exitPrice,
        reason:      t.exitReason,
        pnlBps:      +t.pnlBps.toFixed(2),
        pnlUSD:      +t.pnlUSD.toFixed(4),
        spreadBps:   +t.spreadBpsAtEntry.toFixed(1),
        rsi:         +t.rsi.toFixed(1),
        obi:         t.obi !== null ? +t.obi.toFixed(3) : null,
        score:       +t.confluenceScore.toFixed(0),
        verdict:     t.verdict,
        regime:      t.regime,
        win:         t.win,
      })),
      indicators:       this.indicators,
      ticker:           this.ticker,
      currentParams:    this._getActiveParams(),
      globalParams:     { ...this.params },
      regimeParams:     this.regimeParams,
      regime:           this.regime,
      kellyFrac:        this.kellyFrac,
      featureImportance: this.featureImportance,
      recentParamLog:   this.paramLog.slice(-10),
      pnlCurve,
    };
  }

  getOrderBook() {
    if (!this.orderBook) return null;
    const ind = this.indicators;
    return {
      ...summarizeBook(this.orderBook, this.params.baseOrderUSD, this.ticker ? this.ticker.last : 0),
      bids: this.orderBook.bids.slice(0, 10),
      asks: this.orderBook.asks.slice(0, 10),
      confluenceScore: ind.confluenceScore,
      regime: this.regime,
    };
  }

  applyParams(newParams) {
    const allowed = [
      'maxSpreadBps', 'minNetBps', 'rsiThreshold', 'feeRatePct',
      'atrStopMult', 'atrTpMult', 'confluenceThreshold', 'baseOrderUSD',
      'maxHoldSecs', 'exploreRate',
    ];
    for (const k of allowed) {
      if (newParams[k] !== undefined) this.params[k] = newParams[k];
    }
    this._save();
    console.log('[SimEngine] Params applied externally:', this.params);
  }

  // ─── Persistence ────────────────────────────────────────────────────────

  _save() {
    try {
      fs.writeFileSync(DATA_FILE, JSON.stringify({
        params:           this.params,
        regimeParams:     this.regimeParams,
        featureImportance: this.featureImportance,
        simTrades:        this.simTrades.slice(-1000),
        paramLog:         this.paramLog.slice(-200),
        savedAt:          Date.now(),
      }, null, 2));
    } catch (e) {
      console.error('[SimEngine] save error:', e.message);
    }
  }

  _load() {
    try {
      const d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      if (d.params)            this.params            = { ...DEFAULT_PARAMS, ...d.params };
      if (d.regimeParams)      this.regimeParams      = d.regimeParams;
      if (d.featureImportance) this.featureImportance = d.featureImportance;
      if (d.simTrades)         this.simTrades         = d.simTrades;
      if (d.paramLog)          this.paramLog          = d.paramLog;
      console.log(`[SimEngine] Loaded ${this.simTrades.length} trades, ${this.paramLog.length} param adjustments`);
    } catch (_) {
      console.log('[SimEngine] No saved data, starting fresh');
    }
  }
}

// ─── Util ────────────────────────────────────────────────────────────────

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

module.exports = SimEngine;
