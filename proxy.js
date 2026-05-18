'use strict';

require('dotenv').config();

const express = require('express');
const https   = require('https');
const path    = require('path');
const fs      = require('fs');
const app     = express();

// ─── Supabase auth + DB ────────────────────────────────────────────────────
const { supabase, requireAuth, getUserPlan, isOwner } = require('./trading_engine/supabase');

// ─── Trading Engine ────────────────────────────────────────────────────────
const RiskManager = require('./trading_engine/risk_management');
const OrderTypes  = require('./trading_engine/order_types');
const MarketData  = require('./trading_engine/market_data');
const SimEngine   = require('./trading_engine/sim_engine');
const { isValidPair } = require('./trading_engine/tickers');
const { runScan, startBackgroundRefresh } = require('./trading_engine/scanner');

const simEngine = new SimEngine();

const config = { stopLoss: 0.01, takeProfit: 0.02, maxPositionSize: 1000 };
const riskManager  = new RiskManager(config);
const marketData   = new MarketData();
let position       = null;
let entryPrice     = null;
let accountBalance = 10000;
const riskPerTrade = 0.01;
let lastStatus     = { position: null, entryPrice: null, accountBalance, lastTick: null };

const simRiskManager  = new RiskManager({ ...config });
let simPosition       = null;
let simEntryPrice     = null;
const simAccountBalance = 10000;
let simLog            = [];

function tradingDataHandler(data) {
  lastStatus.lastTick = data;
  if (!position) {
    if (data.price < data.movingAvg * 0.995) {
      const size = riskManager.calculatePositionSize(accountBalance, riskPerTrade);
      position   = OrderTypes.createMarketOrder(data.symbol, size);
      entryPrice = data.price;
      lastStatus.position = position; lastStatus.entryPrice = entryPrice;
      lastStatus.liveTrade = { entry: data.price, time: Date.now() };
    }
  } else {
    if (riskManager.shouldStopLoss(entryPrice, data.price)) {
      position = null; entryPrice = null;
      lastStatus.position = null; lastStatus.entryPrice = null;
      lastStatus.liveTrade = { exit: data.price, reason: 'stopLoss', time: Date.now() };
    } else if (riskManager.shouldTakeProfit(entryPrice, data.price)) {
      position = null; entryPrice = null;
      lastStatus.position = null; lastStatus.entryPrice = null;
      lastStatus.liveTrade = { exit: data.price, reason: 'takeProfit', time: Date.now() };
    }
  }
  if (!simPosition) {
    if (data.price < data.movingAvg * 0.998) {
      const size = simRiskManager.calculatePositionSize(simAccountBalance, riskPerTrade);
      simPosition = OrderTypes.createMarketOrder(data.symbol, size);
      simEntryPrice = data.price;
      simLog.push({ type: 'entry', price: data.price, time: Date.now() });
    }
  } else {
    if (simRiskManager.shouldStopLoss(simEntryPrice, data.price)) {
      simLog.push({ type: 'exit', price: data.price, reason: 'stopLoss', time: Date.now() });
      simPosition = null; simEntryPrice = null;
    } else if (simRiskManager.shouldTakeProfit(simEntryPrice, data.price)) {
      simLog.push({ type: 'exit', price: data.price, reason: 'takeProfit', time: Date.now() });
      simPosition = null; simEntryPrice = null;
    }
  }
}
marketData.subscribe(tradingDataHandler);

// ─── CORS ──────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'API-Key,API-Sign,Content-Type,Accept,Authorization');
  if (req.method === 'OPTIONS') { res.sendStatus(200); return; }
  next();
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─── Static files + health check ──────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));
app.use(express.static(path.join(__dirname), { index: 'landing.html' }));
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'landing.html')));
app.get('/app', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// ─── Auth endpoints ────────────────────────────────────────────────────────

// Sign up
app.post('/auth/signup', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'email and password required' });
  const { data, error } = await supabase.auth.signUp({ email, password });
  if (error) return res.status(400).json({ error: error.message });
  res.json({ user: data.user, session: data.session });
});

// Sign in
app.post('/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'email and password required' });
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return res.status(400).json({ error: error.message });
  res.json({ user: data.user, session: data.session });
});

// Get current user + plan info
app.get('/auth/me', requireAuth, async (req, res) => {
  const settings = await getUserPlan(req.user.id);
  const plan = isOwner(req.user) ? 'elite' : settings.plan;
  res.json({ user: req.user, plan, ticker: settings.ticker });
});

// Update user ticker preference
app.post('/auth/ticker', requireAuth, async (req, res) => {
  const { ticker } = req.body;
  if (!ticker || !isValidPair(ticker)) return res.status(400).json({ error: 'Invalid ticker' });
  await supabase.from('user_settings').upsert({ user_id: req.user.id, ticker }, { onConflict: 'user_id' });
  res.json({ ok: true, ticker });
});

// ─── Legacy trading endpoints ──────────────────────────────────────────────
app.get('/trading/status', (req, res) => {
  res.json({
    live: lastStatus,
    simulation: { position: simPosition, entryPrice: simEntryPrice, accountBalance: simAccountBalance, log: simLog.slice(-20) },
  });
});

app.post('/trading/tick', (req, res) => {
  const { symbol, price, movingAvg } = req.body;
  if (!symbol || price === undefined || movingAvg === undefined)
    return res.status(400).json({ error: 'symbol, price, and movingAvg required' });
  marketData.simulateTick({ symbol, price, movingAvg });
  res.json({ status: 'tick processed', lastStatus });
});

// ─── Sim engine endpoints ──────────────────────────────────────────────────
app.get('/sim/status', (_req, res) => res.json(simEngine.getStatus()));

app.get('/sim/orderbook', (_req, res) => {
  const ob = simEngine.getOrderBook();
  if (!ob) return res.json({ ready: false, message: 'Order book not yet fetched' });
  res.json({ ready: true, ...ob });
});

app.post('/sim/pair', requireAuth, (req, res) => {
  const { pair } = req.body;
  if (!pair || typeof pair !== 'string') return res.status(400).json({ error: 'pair required' });
  simEngine.setPair(pair.toUpperCase());
  res.json({ ok: true, pair: simEngine.pair });
});

app.post('/sim/apply-params', (req, res) => {
  simEngine.applyParams(req.body);
  res.json({ status: 'ok', params: simEngine.params });
});

app.get('/sim/params', (_req, res) => {
  const s = simEngine.getStatus();
  res.json({ ready: s.totalTrades >= 10, currentParams: s.currentParams, featureImportance: s.featureImportance });
});

app.post('/sim/learn', (_req, res) => {
  const s = simEngine.getStatus();
  if (s.totalTrades < 10) return res.json({ ready: false, message: 'Need 10+ trades' });
  res.json({ ready: true, currentParams: s.currentParams, winRate: s.winRate, avgPnlBps: s.avgPnlBps });
});

// ─── Bot state — Supabase-backed, auth required ────────────────────────────

app.post('/bot/push', requireAuth, async (req, res) => {
  const settings = await getUserPlan(req.user.id);
  const plan = isOwner(req.user) ? 'elite' : settings.plan;
  if (plan === 'free') return res.status(403).json({ error: 'Live bot requires Pro or Elite plan' });
  const state = { ...req.body, user_id: req.user.id, updated_at: new Date().toISOString() };
  await supabase.from('bot_state').upsert(state, { onConflict: 'user_id' });
  res.json({ ok: true });
});

app.get('/bot/status', requireAuth, async (req, res) => {
  const { data } = await supabase.from('bot_state').select('*').eq('user_id', req.user.id).single();
  res.json(data || {});
});

app.get('/bot/history', requireAuth, async (req, res) => {
  const { data } = await supabase
    .from('trade_log')
    .select('*')
    .eq('user_id', req.user.id)
    .order('traded_at', { ascending: false })
    .limit(500);
  res.json({ trades: data || [], count: data?.length || 0 });
});

app.post('/bot/trade', requireAuth, async (req, res) => {
  const settings = await getUserPlan(req.user.id);
  const plan = isOwner(req.user) ? 'elite' : settings.plan;
  if (plan === 'free') return res.status(403).json({ error: 'Live bot requires Pro or Elite plan' });
  const trade = { ...req.body, user_id: req.user.id, traded_at: new Date().toISOString() };
  await supabase.from('trade_log').insert(trade);
  res.json({ ok: true });
});

// ─── Stripe billing endpoints ─────────────────────────────────────────────
const { createCheckoutSession, createPortalSession, verifyWebhookSignature } = require('./trading_engine/stripe_billing');

// Start a checkout session — redirects user to Stripe hosted page
app.post('/billing/checkout', requireAuth, async (req, res) => {
  const { plan } = req.body;
  if (!['pro', 'elite'].includes(plan)) return res.status(400).json({ error: 'Invalid plan' });
  try {
    const origin = req.headers.origin || `http://localhost:${process.env.PORT || 3000}`;
    const session = await createCheckoutSession({
      email:      req.user.email,
      userId:     req.user.id,
      plan,
      successUrl: origin + '/index.html?upgraded=1',
      cancelUrl:  origin + '/index.html',
    });
    res.json({ url: session.url });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Open billing portal (manage/cancel subscription)
app.post('/billing/portal', requireAuth, async (req, res) => {
  try {
    const origin = req.headers.origin || `http://localhost:${process.env.PORT || 3000}`;
    const session = await createPortalSession({
      email:     req.user.email,
      userId:    req.user.id,
      returnUrl: origin + '/index.html',
    });
    res.json({ url: session.url });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Stripe webhook — updates user plan in Supabase after payment
app.post('/billing/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig   = req.headers['stripe-signature'];
  const event = verifyWebhookSignature(req.body.toString(), sig);
  if (!event) return res.status(400).send('Invalid signature');

  const { supabaseAdmin } = require('./trading_engine/supabase');
  const db = supabaseAdmin || supabase;

  if (event.type === 'customer.subscription.created' || event.type === 'customer.subscription.updated') {
    const sub    = event.data.object;
    const userId = sub.metadata?.userId;
    const plan   = sub.metadata?.plan || 'pro';
    const active = sub.status === 'active' || sub.status === 'trialing';
    if (userId && active) {
      await db.from('user_settings').upsert(
        { user_id: userId, plan, stripe_subscription_id: sub.id, plan_expires_at: new Date(sub.current_period_end * 1000).toISOString() },
        { onConflict: 'user_id' }
      );
    }
  }

  if (event.type === 'customer.subscription.deleted') {
    const sub    = event.data.object;
    const userId = sub.metadata?.userId;
    if (userId) {
      await db.from('user_settings').update({ plan: 'free', stripe_subscription_id: null })
        .eq('user_id', userId);
    }
  }

  res.json({ received: true });
});

// ─── Push notification endpoints ─────────────────────────────────────────
const { saveSubscription, deleteSubscription, notify } = require('./trading_engine/push_notifications');

// Save browser push subscription
app.post('/push/subscribe', requireAuth, async (req, res) => {
  const { subscription } = req.body;
  if (!subscription?.endpoint) return res.status(400).json({ error: 'Invalid subscription object' });
  await saveSubscription(req.user.id, subscription);
  res.json({ ok: true });
});

// Remove push subscription (user turned off notifications)
app.post('/push/unsubscribe', requireAuth, async (req, res) => {
  await deleteSubscription(req.user.id);
  res.json({ ok: true });
});

// Send a test notification to the requesting user
app.post('/push/test', requireAuth, async (req, res) => {
  const { type } = req.body;
  const testData = {
    trade_entry:      { pair: 'XRPUSD', price: '0.5234', score: 87, regime: 'Trending' },
    trade_exit:       { pair: 'XRPUSD', price: '0.5301', pnl: 1, pnlBps: 12.6, reason: 'Take Profit' },
    stop_loss:        { pair: 'XRPUSD', price: '0.5180', pnlBps: -10.0 },
    take_profit:      { pair: 'XRPUSD', price: '0.5310', pnlBps: 14.5 },
    high_confluence:  { pair: 'XRPUSD', score: 91, verdict: 'Strong Buy', regime: 'Trending' },
    rsi_extreme:      { pair: 'XRPUSD', rsi: 27.3 },
    volume_spike:     { pair: 'XRPUSD', ratio: 3.2 },
    bb_squeeze:       { pair: 'XRPUSD' },
    regime_change:    { pair: 'XRPUSD', from: 'Ranging', to: 'Trending' },
    brain_update:     { pair: 'XRPUSD', message: 'Adjusted RSI threshold based on last 20 trades' },
    fear_greed:       { value: 14, label: 'Extreme Fear' },
    price_alert:      { pair: 'XRPUSD', price: '0.5250', targetPrice: '0.5250' },
    obi_spike:        { pair: 'XRPUSD', obi: 0.72 },
    support_resistance: { pair: 'XRPUSD', levelType: 'resistance', level: '0.5300' },
    bot_status:       { status: 'RUNNING', message: 'Bot started successfully' },
    weekly_report:    { trades: 47, winRate: 62, pnl: 1, pnlBps: 184 },
    connection_lost:  { exchange: 'Kraken' },
  };
  const data = testData[type] || testData.bot_status;
  await notify(req.user.id, type || 'bot_status', data);
  res.json({ ok: true });
});

// ─── Multi-ticker scanner (Elite — live) ─────────────────────────────────
app.get('/scanner/results', requireAuth, async (req, res) => {
  const settings = await getUserPlan(req.user.id);
  const plan = isOwner(req.user) ? 'elite' : settings.plan;
  if (plan !== 'elite') return res.status(403).json({ error: 'Elite plan required', upgrade: true });
  try {
    const data = await runScan();
    if (!data) return res.json({ scanning: true, results: [], top3: [] });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Public signal feed (no auth — 15-min delayed cache) ─────────────────
const PUBLIC_DELAY_MS = 15 * 60 * 1000;
let _publicCache = null;
let _publicCacheTime = 0;

app.get('/scanner/public', async (req, res) => {
  const now = Date.now();
  // Return cached public snapshot if fresh enough (refresh every 60s server-side)
  if (_publicCache && (now - _publicCacheTime) < 60_000) {
    return res.json(_publicCache);
  }
  try {
    const data = await runScan();
    if (!data) return res.json({ scanning: true, results: [], top3: [], delayed: true, delayMinutes: 15 });
    // Only expose data that is at least 15 minutes old — if the scan itself
    // is fresher than that, we hold back the top signals and redact scores.
    const ageMs = now - data.scannedAt;
    const isDelayed = ageMs >= PUBLIC_DELAY_MS;
    const payload = {
      delayed: true,
      delayMinutes: 15,
      scannedAt: isDelayed ? data.scannedAt : now - PUBLIC_DELAY_MS,
      count: data.count,
      // Show all pairs but redact score precision and hide top signal details if too fresh
      results: (data.results || []).map(r => ({
        pair:     r.pair,
        label:    r.label,
        price:    r.price,
        change24h: r.change24h,
        score:    isDelayed ? r.score : Math.round(r.score / 10) * 10, // round to nearest 10 when fresh
        verdict:  isDelayed ? r.verdict : (r.score >= 65 ? 'BULLISH' : r.score <= 40 ? 'BEARISH' : 'NEUTRAL'),
        regime:   r.regime,
        rsi:      isDelayed ? r.rsi : '--',
        volRatio: isDelayed ? r.volRatio : '--',
        divergence: null,
      })),
      top3: isDelayed ? data.top3 : [],
    };
    _publicCache = payload;
    _publicCacheTime = now;
    res.json(payload);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Indicator engine — fetch candles + compute full indicator bundle ─────────
// GET /indicators/calc?pair=XRPUSD&interval=60&limit=500
// Returns: { candles, indicators } — used by chart and strategy builder
const BINANCE_INTERVAL_MAP = {
  1:'1m',3:'3m',5:'5m',15:'15m',30:'30m',60:'1h',120:'2h',
  240:'4h',360:'6h',480:'8h',720:'12h',1440:'1d',4320:'3d',10080:'1w',43200:'1M'
};

function fetchBinanceCandles(symbol, interval, limit=500) {
  return new Promise((resolve) => {
    const binSym = symbol.replace('XBT','BTC').replace('USD','USDT').replace(/^X/,'').replace(/^Z/,'');
    const binInterval = BINANCE_INTERVAL_MAP[+interval] || '1h';
    const url = `https://api.binance.com/api/v3/klines?symbol=${binSym}&interval=${binInterval}&limit=${limit}`;
    const req = https.get(url, { headers: { 'User-Agent': 'NEXUS/4.0' } }, (res) => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => {
        try {
          const rows = JSON.parse(raw);
          if (!Array.isArray(rows)) { resolve(null); return; }
          resolve(rows.map(r => ({
            t: Math.floor(r[0] / 1000),
            open: +r[1], high: +r[2], low: +r[3], close: +r[4], volume: +r[5],
            o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5],
          })));
        } catch { resolve(null); }
      });
    });
    req.setTimeout(8000, () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

app.get('/indicators/calc', async (req, res) => {
  const { pair = 'XRPUSD', interval = '60', limit = '500', params: rawParams } = req.query;
  let indicatorParams = {};
  try { if (rawParams) indicatorParams = JSON.parse(rawParams); } catch {}

  try {
    const candles = await fetchBinanceCandles(pair, +interval, Math.min(+limit, 1000));
    if (!candles || candles.length < 10) return res.status(400).json({ error: 'No candle data available' });

    let indLib;
    try { indLib = require('./trading_engine/indicators'); } catch (e) {
      return res.status(500).json({ error: 'Indicator library not loaded: ' + e.message });
    }

    const indicators = indLib.calcAll ? indLib.calcAll(candles, indicatorParams) : {};

    // Also return slim candle array for chart rendering
    const slim = candles.map(c => ({ t: c.t, o: c.o||c.open, h: c.h||c.high, l: c.l||c.low, c: c.c||c.close, v: c.v||c.volume }));
    res.json({ ok: true, pair, interval: +interval, candles: slim, indicators, count: candles.length });
  } catch (e) {
    console.error('Indicators error:', e);
    res.status(500).json({ error: e.message });
  }
});

// GET /indicators/htf?pair=XRPUSD&timeframes=60,240,1440 — multi-timeframe bundle
app.get('/indicators/htf', async (req, res) => {
  const { pair = 'XRPUSD', timeframes = '60,240,1440' } = req.query;
  const tfs = timeframes.split(',').map(Number).filter(Boolean).slice(0, 5); // max 5 TFs
  try {
    let indLib;
    try { indLib = require('./trading_engine/indicators'); } catch (e) {
      return res.status(500).json({ error: 'Indicator library not loaded' });
    }
    const results = {};
    await Promise.all(tfs.map(async (tf) => {
      const candles = await fetchBinanceCandles(pair, tf, 300);
      if (candles && candles.length >= 10 && indLib.calcAll) {
        results[tf] = indLib.calcAll(candles, {});
      }
    }));
    res.json({ ok: true, pair, timeframes: tfs, indicators: results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Tickers list (public) ────────────────────────────────────────────────
app.get('/tickers', (_req, res) => {
  const { TICKERS, ALL_PAIRS } = require('./trading_engine/tickers');
  res.json({ groups: TICKERS, all: ALL_PAIRS });
});

// ─── Kraken proxy (public — market data is not sensitive) ──────────────────
app.all(/^\/api\/(.*)/, (req, res) => {
  const apiPath = req.params[0];
  const qs = Object.keys(req.query).length ? '?' + new URLSearchParams(req.query).toString() : '';
  const url = 'https://api.kraken.com/' + apiPath + qs;

  const options = { method: req.method, headers: { ...req.headers } };
  delete options.headers.host;

  const proxyReq = https.request(url, options, (proxyRes) => {
    res.status(proxyRes.statusCode);
    Object.keys(proxyRes.headers).forEach(k => res.setHeader(k, proxyRes.headers[k]));
    proxyRes.pipe(res);
  });
  proxyReq.on('error', (err) => { console.error('Proxy error:', err); res.status(500).send('Proxy error'); });
  if (req.body && Object.keys(req.body).length) proxyReq.write(new URLSearchParams(req.body).toString());
  proxyReq.end();
});

// ─── Backtester endpoints (Pro/Elite) ────────────────────────────────────────

let _backtestEngine = null;
function getBacktestEngine() {
  if (!_backtestEngine) _backtestEngine = require('./trading_engine/backtest_engine');
  return _backtestEngine;
}

// Run a single backtest
app.post('/backtest', requireAuth, async (req, res) => {
  const settings = await getUserPlan(req.user.id);
  const plan = isOwner(req.user) ? 'elite' : settings.plan;
  if (plan === 'free') return res.status(403).json({ error: 'Backtesting requires Pro or Elite plan' });

  const { pair = 'XRPUSD', interval = 60, daysBack = 90, slippage = 0.0005, feePct = 0.0016, params = {}, walkForward = false } = req.body;

  try {
    const eng = getBacktestEngine();
    const candles = await eng.fetchDeepHistory(pair, interval, daysBack);
    if (!candles || candles.length < 50) return res.status(400).json({ error: 'Not enough historical data' });

    let result;
    if (walkForward) {
      result = eng.runWalkForward(candles, params, slippage, feePct);
    } else {
      const { trades, equity } = eng.runBacktestOnCandles(candles, params, slippage, feePct);
      const metrics = eng.calcMetrics(trades, equity, 10000);
      result = { trades, equity, metrics, candles: candles.map(c => ({ t: c.t, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v })) };
    }
    res.json({ ok: true, pair, interval, daysBack, candleCount: candles.length, ...result });
  } catch (e) {
    console.error('Backtest error:', e);
    res.status(500).json({ error: e.message });
  }
});

// Run walk-forward grid optimizer (Elite only)
app.post('/backtest/optimize', requireAuth, async (req, res) => {
  const settings = await getUserPlan(req.user.id);
  const plan = isOwner(req.user) ? 'elite' : settings.plan;
  if (plan !== 'elite') return res.status(403).json({ error: 'Optimizer requires Elite plan', upgrade: true });

  const { pair = 'XRPUSD', interval = 60, daysBack = 180, slippage = 0.0005, feePct = 0.0016, maxCombos = 500 } = req.body;

  try {
    const eng = getBacktestEngine();
    const candles = await eng.fetchDeepHistory(pair, interval, daysBack);
    if (!candles || candles.length < 100) return res.status(400).json({ error: 'Not enough data for optimization' });

    const results = eng.runOptimizer(candles, slippage, feePct, maxCombos);
    res.json({ ok: true, pair, interval, daysBack, candleCount: candles.length, results });
  } catch (e) {
    console.error('Optimizer error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ─── Webhook signal endpoints ─────────────────────────────────────────────

// External POST /signal — authenticated with user's webhook token
app.post('/signal', async (req, res) => {
  const auth = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Bearer token required' });

  // Look up user by webhook token
  const { data: settings, error } = await supabase
    .from('user_settings')
    .select('user_id, webhook_token')
    .eq('webhook_token', token)
    .single();

  if (error || !settings) return res.status(401).json({ error: 'Invalid webhook token' });

  const { action, pair, price, confidence, source } = req.body;
  if (!action || !['buy', 'sell', 'close'].includes(action)) return res.status(400).json({ error: 'action must be buy|sell|close' });

  const signal = {
    user_id: settings.user_id,
    action,
    pair: pair || null,
    price: price || null,
    confidence: confidence || null,
    source: source || 'webhook',
    consumed: false,
    created_at: new Date().toISOString(),
  };

  const { error: insertErr } = await supabase.from('webhook_signals').insert(signal);
  if (insertErr) return res.status(500).json({ error: insertErr.message });

  res.json({ ok: true, queued: true });
});

// Client polls for pending signals (executed using client's own Kraken keys)
app.get('/signal/pending', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('webhook_signals')
    .select('*')
    .eq('user_id', req.user.id)
    .eq('consumed', false)
    .order('created_at', { ascending: true })
    .limit(10);

  if (error) return res.status(500).json({ error: error.message });

  // Mark all returned signals as consumed
  if (data && data.length > 0) {
    const ids = data.map(s => s.id);
    await supabase.from('webhook_signals').update({ consumed: true }).in('id', ids);
  }

  res.json({ signals: data || [] });
});

// Generate or rotate user's webhook token
app.post('/signal/token', requireAuth, async (req, res) => {
  const crypto = require('crypto');
  const token = crypto.randomBytes(32).toString('hex');
  await supabase.from('user_settings').upsert(
    { user_id: req.user.id, webhook_token: token },
    { onConflict: 'user_id' }
  );
  res.json({ ok: true, token });
});

// ─── Start ─────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`NEXUS proxy running on port ${PORT}`);
  // Delay sim engine start so health check passes first
  setTimeout(() => simEngine.start(), 3000);
  startBackgroundRefresh();
});
