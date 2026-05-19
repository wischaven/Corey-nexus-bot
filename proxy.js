'use strict';

require('dotenv').config();

const express = require('express');
const https   = require('https');
const crypto  = require('crypto');
const path    = require('path');
const fs      = require('fs');
const app     = express();

// ─── Autonomous trading state ─────────────────────────────────────────────
let _tradingEnabled  = false;
let _tradingActive   = false; // guard: one cycle at a time
const _openPositions = []; // { id, pair, side, size, entryPrice, stop, target, openedAt, krakenTxid }
const _tradeLog      = []; // last 200 completed trades

// ─── Kraken private API ───────────────────────────────────────────────────
function _krakenSign(path, nonce, postData) {
  const hash = crypto.createHash('sha256').update(nonce + postData).digest();
  const secret = Buffer.from(process.env.KRAKEN_API_SECRET || '', 'base64');
  return crypto.createHmac('sha512', secret).update(path).update(hash).digest('base64');
}

function _krakenPrivate(endpoint, params = {}) {
  const apiKey = process.env.KRAKEN_API_KEY;
  const apiSecret = process.env.KRAKEN_API_SECRET;
  if (!apiKey || !apiSecret || apiKey === 'paste_kraken_api_key_here') {
    return Promise.resolve({ error: 'Kraken API keys not set in .env' });
  }
  const nonce = String(Date.now() * 1000);
  const postData = new URLSearchParams({ nonce, ...params }).toString();
  const sign = _krakenSign(endpoint, nonce, postData);
  const body = Buffer.from(postData);
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.kraken.com', port: 443, path: endpoint, method: 'POST',
      headers: {
        'API-Key': apiKey, 'API-Sign': sign,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': body.length,
      },
    }, (res) => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => {
        try {
          const d = JSON.parse(raw);
          if (d.error && d.error.length) resolve({ error: d.error.join(', ') });
          else resolve({ ok: true, result: d.result });
        } catch { resolve({ error: 'Parse error' }); }
      });
    });
    req.setTimeout(12000, () => { req.destroy(); resolve({ error: 'Timeout' }); });
    req.on('error', e => resolve({ error: e.message }));
    req.write(body);
    req.end();
  });
}

async function _krakenPlaceOrder({ pair, side, ordertype = 'market', volume, price, validate = false }) {
  const params = { ordertype, type: side, pair, volume: String(volume) };
  if (price) params.price = String(price);
  if (validate) params.validate = 'true';
  const r = await _krakenPrivate('/0/private/AddOrder', params);
  if (r.error) return { ok: false, error: r.error };
  return { ok: true, txid: r.result?.txid?.[0], descr: r.result?.descr };
}

async function _krakenBalance() {
  const r = await _krakenPrivate('/0/private/Balance');
  return r.ok ? r.result : null;
}

async function _krakenCancelOrder(txid) {
  return _krakenPrivate('/0/private/CancelOrder', { txid });
}

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

// Convert NEXUS/Kraken pair → Binance symbol (e.g. XRPUSD → XRPUSDT, XXRPZUSD → XRPUSDT)
function _toBinanceSymbol(symbol) {
  let s = symbol.toUpperCase().replace('XBT', 'BTC');
  // Strip Kraken full-format double prefixes only (XXRPZUSD → XRPUSD)
  s = s.replace(/^X([A-Z]{2,4})Z([A-Z]{3})$/, '$1$2');
  // Ensure USDT suffix
  if (s.endsWith('USD') && !s.endsWith('USDT')) s += 'T';
  return s;
}

function fetchBinanceCandles(symbol, interval, limit=500) {
  return new Promise((resolve) => {
    const binSym = _toBinanceSymbol(symbol);
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
    req.setTimeout(12000, () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

// Server-side Kraken OHLC fetch — fallback when Binance is unavailable
// Kraken supports intervals (min): 1, 5, 15, 30, 60, 240, 1440, 10080
const KRAKEN_OHLC_INTERVALS = new Set([1, 5, 15, 30, 60, 240, 1440, 10080]);
function fetchKrakenCandles(pair, intervalMin, limit=720) {
  return new Promise((resolve) => {
    if (!KRAKEN_OHLC_INTERVALS.has(+intervalMin)) { resolve(null); return; }
    const url = `https://api.kraken.com/0/public/OHLC?pair=${pair}&interval=${intervalMin}`;
    const req = https.get(url, { headers: { 'User-Agent': 'NEXUS/4.0' } }, (res) => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => {
        try {
          const d = JSON.parse(raw);
          if (d.error && d.error.length) { resolve(null); return; }
          const key = Object.keys(d.result || {}).find(k => k !== 'last');
          if (!key) { resolve(null); return; }
          const rows = d.result[key].slice(-limit);
          resolve(rows.map(r => ({
            t: +r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[6],
            open: +r[1], high: +r[2], low: +r[3], close: +r[4], volume: +r[6],
          })));
        } catch { resolve(null); }
      });
    });
    req.setTimeout(10000, () => { req.destroy(); resolve(null); });
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

// ─── OHLC Cache + server-side candle proxy ────────────────────────────────

// Cache TTL per interval: shorter intervals need fresher data
function _ohlcTtlMs(intervalMin) {
  if (intervalMin <= 5)    return 15_000;    // 1m/5m   → 15s
  if (intervalMin <= 60)   return 60_000;    // 15m–1H  → 60s
  if (intervalMin <= 240)  return 5 * 60_000; // 2H–4H  → 5 min
  if (intervalMin <= 1440) return 30 * 60_000; // 6H–1D → 30 min
  return 60 * 60_000;                         // 1W+    → 1 hr
}

// key: `${pair}:${intervalMin}` → { candles, fetchedAt }
const _ohlcCache = new Map();

async function fetchOHLCCached(pair, intervalMin, limit) {
  const key = `${pair}:${intervalMin}`;
  const ttl = _ohlcTtlMs(intervalMin);
  const cached = _ohlcCache.get(key);
  if (cached && (Date.now() - cached.fetchedAt) < ttl) return cached.candles;

  // Try Binance — retry once after 1.5s on failure
  let candles = await fetchBinanceCandles(pair, intervalMin, limit);
  if (!candles || !candles.length) {
    await new Promise(r => setTimeout(r, 1500));
    candles = await fetchBinanceCandles(pair, intervalMin, limit);
  }

  // Kraken server-side fallback
  if (!candles || !candles.length) {
    candles = await fetchKrakenCandles(pair, intervalMin, limit);
  }

  if (candles && candles.length) {
    _ohlcCache.set(key, { candles, fetchedAt: Date.now() });
  }
  return candles;
}

// GET /ohlc?pair=XRPUSD&interval=5&limit=500
// Returns cached candles, fetching server-side (no CORS, rate-limit pooled across users)
app.get('/ohlc', async (req, res) => {
  const { pair = 'XRPUSD', interval = '60', limit = '500' } = req.query;
  const intervalMin = +interval;
  const lim = Math.min(+limit, 1000);
  if (!intervalMin || intervalMin < 1) return res.status(400).json({ error: 'Invalid interval' });

  try {
    const candles = await fetchOHLCCached(pair, intervalMin, lim);
    if (!candles || candles.length < 2) return res.status(503).json({ error: 'No candle data available' });
    res.json({ ok: true, pair, interval: intervalMin, count: candles.length, candles });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── SSE live kline streaming ─────────────────────────────────────────────
// Browser connects to GET /stream/kline?pair=XRPUSDT&interval=5
// Server polls Binance price every 2s and pushes ticks; also updates the cache

// clients: Map<`${pair}:${interval}`, Set<res>>
const _sseClients = new Map();

// Lightweight price-only fetch from Binance ticker endpoint
function _fetchBinanceLatestPrice(symbol) {
  return new Promise((resolve) => {
    const binSym = _toBinanceSymbol(symbol);
    const url = `https://api.binance.com/api/v3/ticker/price?symbol=${binSym}`;
    const req = https.get(url, { headers: { 'User-Agent': 'NEXUS/4.0' } }, (bRes) => {
      let raw = '';
      bRes.on('data', d => raw += d);
      bRes.on('end', () => {
        try { resolve(+JSON.parse(raw).price || null); } catch { resolve(null); }
      });
    });
    req.setTimeout(4000, () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

// Tick loop: runs every 2s, only active when there are SSE clients
let _sseTicker = null;

function _ensureSseTicker() {
  if (_sseTicker) return;
  _sseTicker = setInterval(async () => {
    if (_sseClients.size === 0) { clearInterval(_sseTicker); _sseTicker = null; return; }

    // Collect unique pairs
    const pairs = new Set([..._sseClients.keys()].map(k => k.split(':')[0]));

    for (const pair of pairs) {
      const price = await _fetchBinanceLatestPrice(pair);
      if (!price) continue;
      const now = Math.floor(Date.now() / 1000);

      // Push tick to all clients subscribed to this pair
      for (const [key, clients] of _sseClients.entries()) {
        if (!key.startsWith(pair + ':')) continue;
        const intervalMin = +key.split(':')[1];
        const payload = JSON.stringify({ pair, interval: intervalMin, price, t: now });
        for (const client of clients) {
          try { client.write(`data: ${payload}\n\n`); } catch (_) {}
        }
      }

      // Keep the last candle in cache live (high/low/close update)
      for (const [k, entry] of _ohlcCache.entries()) {
        if (!k.startsWith(pair + ':')) continue;
        if (entry.candles && entry.candles.length) {
          const last = entry.candles[entry.candles.length - 1];
          if (price > last.h) last.h = price;
          if (price < last.l) last.l = price;
          last.c = price;
        }
      }
    }
  }, 2000);
}

// GET /stream/kline?pair=XRPUSD&interval=5
app.get('/stream/kline', (req, res) => {
  const { pair = 'XRPUSD', interval = '60' } = req.query;
  const key = `${pair}:${+interval || 60}`;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // prevent nginx buffering on Railway
  res.flushHeaders();

  if (!_sseClients.has(key)) _sseClients.set(key, new Set());
  _sseClients.get(key).add(res);
  _ensureSseTicker();

  res.write('data: {"type":"connected"}\n\n');

  req.on('close', () => {
    const clients = _sseClients.get(key);
    if (clients) { clients.delete(res); if (clients.size === 0) _sseClients.delete(key); }
  });
});

// ─── NEXUS AI Agent endpoints ─────────────────────────────────────────────
const agent = require('./trading_engine/agent');

// Load persisted memory + knowledge from Supabase on startup
(async () => {
  try {
    const { data: mem } = await supabaseAdmin.from('agent_memory').select('*');
    if (mem && mem.length) agent.loadMemory(mem.map(r => ({ key: r.key, value: r.value, category: r.category, savedAt: r.created_at })));
    const { data: know } = await supabaseAdmin.from('agent_knowledge').select('*');
    if (know && know.length) agent.loadKnowledge(know.map(r => ({ ...r.data, id: r.id, uploadedAt: r.created_at })));
  } catch (e) { console.log('[Agent] Supabase memory load skipped (tables may not exist yet):', e.message); }
})();

// POST /agent/chat — main conversational endpoint with SSE streaming
app.post('/agent/chat', requireAuth, async (req, res) => {
  const { message, images = [], sessionId, model = 'claude-opus-4-7', pair = 'XRPUSD', canTrade = false } = req.body;
  if (!message && !images.length) return res.status(400).json({ error: 'message or images required' });

  // Stream response via SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const send = (obj) => { try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch (_) {} };

  try {
    const effectiveCanTrade = canTrade || _tradingEnabled;
    const context = {
      pair, canTrade: effectiveCanTrade,
      getTradeHistory: async (limit) => {
        const { data } = await supabaseAdmin.from('trade_log').select('*').eq('user_id', req.user.id).order('traded_at', { ascending: false }).limit(limit || 20);
        return data || [];
      },
      saveMemory: async (item) => {
        try { await supabaseAdmin.from('agent_memory').upsert({ user_id: req.user.id, key: item.key, value: item.value, category: item.category || 'general' }, { onConflict: 'user_id,key' }); } catch (_) {}
      },
      getOpenPositions: () => [..._openPositions],
      placeTrade: async (input) => {
        send({ type: 'trade_intent', data: input });
        return _executeTrade(input, req.user.id);
      },
      closePosition: async (posId) => {
        return _closePosition(posId, req.user.id);
      },
    };

    const result = await agent.agentChat({
      sessionId: sessionId || req.user.id,
      userMessage: message,
      images,
      context,
      model,
      onToken: (event) => send({ type: 'stream', event }),
    });

    // Save conversation to Supabase
    try {
      await supabaseAdmin.from('agent_conversations').insert({
        user_id: req.user.id, session_id: sessionId || req.user.id,
        role: 'assistant', content: result.text,
        tool_calls: result.toolCalls, model,
      });
    } catch (_) {}

    send({ type: 'done', text: result.text, toolCalls: result.toolCalls });
  } catch (e) {
    send({ type: 'error', message: e.message });
  }
  res.end();
});

// POST /agent/image — analyze uploaded images, extract trading knowledge
app.post('/agent/image', requireAuth, async (req, res) => {
  const { images, context: userContext = '', model = 'claude-opus-4-7' } = req.body;
  if (!images || !images.length) return res.status(400).json({ error: 'images required (base64 array)' });

  try {
    const result = await agent.analyzeImages({ images, userContext, model });

    // Persist to Supabase
    try {
      await supabaseAdmin.from('agent_knowledge').insert({ user_id: req.user.id, data: result, summary: result.summary, type: result.type });
    } catch (_) {}

    res.json({ ok: true, knowledge: result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /agent/memory — retrieve all memory + knowledge
app.get('/agent/memory', requireAuth, async (_req, res) => {
  res.json({ memory: agent.getMemory(), knowledge: agent.getKnowledge() });
});

// DELETE /agent/memory/:key — forget a specific memory item
app.delete('/agent/memory/:key', requireAuth, async (req, res) => {
  try { await supabaseAdmin.from('agent_memory').delete().eq('user_id', req.user.id).eq('key', req.params.key); } catch (_) {}
  res.json({ ok: true });
});

// GET /agent/conversations — retrieve conversation history
app.get('/agent/conversations', requireAuth, async (req, res) => {
  try {
    const { data } = await supabaseAdmin.from('agent_conversations').select('*').eq('user_id', req.user.id).order('created_at', { ascending: false }).limit(100);
    res.json({ conversations: data || [] });
  } catch (e) {
    res.json({ conversations: [] });
  }
});

// GET /agent/learn-log — return autonomous learning activity log
app.get('/agent/learn-log', requireAuth, (_req, res) => {
  res.json({ log: agent.getLearnLog() });
});

// POST /agent/learn-now — trigger an immediate learning cycle (owner only)
app.post('/agent/learn-now', requireAuth, async (req, res) => {
  if (!isOwner(req.user)) return res.status(403).json({ error: 'Owner only' });
  res.json({ status: 'started' });
  agent.runLearningCycle({ manual: true }).catch(e => console.error('[LearnCycle] manual error:', e));
});

// ─── Trade execution helpers ──────────────────────────────────────────────
async function _executeTrade(input, userId) {
  const { pair, side, size_usd, order_type = 'market', limit_price, stop_loss, take_profit, reasoning } = input;

  // Get current price to calculate volume
  let price = limit_price;
  if (!price || order_type === 'market') {
    try {
      const sym = pair.toUpperCase().replace('XBT', 'BTC').replace(/USD$/, 'USDT');
      const tickerRes = await new Promise((resolve) => {
        https.get(`https://api.binance.com/api/v3/ticker/price?symbol=${sym}`, { headers: { 'User-Agent': 'NEXUS/4.1' } }, (res) => {
          let raw = ''; res.on('data', d => raw += d);
          res.on('end', () => { try { resolve(JSON.parse(raw)); } catch { resolve(null); } });
        }).on('error', () => resolve(null));
      });
      if (tickerRes && tickerRes.price) price = +tickerRes.price;
    } catch (_) {}
  }

  if (!price) return { ok: false, error: 'Could not determine current price' };

  const volume = +(size_usd / price).toFixed(6);
  const position = {
    id: `pos_${Date.now()}`,
    pair, side, size: volume, sizeUsd: size_usd,
    entryPrice: price, stop: stop_loss, target: take_profit,
    openedAt: new Date().toISOString(), reasoning,
    status: 'open', krakenTxid: null,
  };

  // Try real Kraken execution
  const krakenPair = pair.toUpperCase().replace('USD', 'ZUSD').replace('XRPZUSD', 'XXRPZUSD').replace('BTCZUSD', 'XXBTZUSD').replace('ETHZUSD', 'XETHZUSD');
  const order = await _krakenPlaceOrder({ pair: krakenPair, side, ordertype: order_type, volume, price: order_type === 'limit' ? limit_price : undefined });

  if (order.ok) {
    position.krakenTxid = order.txid;
    position.status = 'open';
    console.log(`[Trade] ${side.toUpperCase()} ${volume} ${pair} @ ~$${price} | txid: ${order.txid}`);
  } else {
    position.status = 'sim';
    position.simNote = order.error || 'Kraken unavailable — simulated';
    console.log(`[Trade SIM] ${side.toUpperCase()} ${volume} ${pair} @ ~$${price} | reason: ${position.simNote}`);
  }

  _openPositions.push(position);

  // Persist to Supabase
  try {
    await supabaseAdmin.from('trade_log').insert({
      user_id: userId, pair, side, size: volume, size_usd,
      entry_price: price, stop_loss, take_profit, reasoning,
      kraken_txid: position.krakenTxid, status: position.status,
      traded_at: position.openedAt,
    });
  } catch (_) {}

  return { ok: true, position, krakenOk: order.ok, txid: order.txid };
}

async function _closePosition(posId, userId) {
  const idx = _openPositions.findIndex(p => p.id === posId);
  if (idx === -1) return { ok: false, error: 'Position not found' };
  const pos = _openPositions[idx];

  // Get current price
  let closePrice = null;
  try {
    const sym = pos.pair.toUpperCase().replace('XBT', 'BTC').replace(/USD$/, 'USDT');
    const tickerRes = await new Promise((resolve) => {
      https.get(`https://api.binance.com/api/v3/ticker/price?symbol=${sym}`, { headers: { 'User-Agent': 'NEXUS/4.1' } }, (res) => {
        let raw = ''; res.on('data', d => raw += d);
        res.on('end', () => { try { resolve(JSON.parse(raw)); } catch { resolve(null); } });
      }).on('error', () => resolve(null));
    });
    if (tickerRes && tickerRes.price) closePrice = +tickerRes.price;
  } catch (_) {}

  const closeSide = pos.side === 'buy' ? 'sell' : 'buy';
  let closeOrder = { ok: false, error: 'Kraken unavailable' };
  if (pos.krakenTxid) {
    const krakenPair = pos.pair.toUpperCase().replace('USD', 'ZUSD').replace('XRPZUSD', 'XXRPZUSD').replace('BTCZUSD', 'XXBTZUSD').replace('ETHZUSD', 'XETHZUSD');
    closeOrder = await _krakenPlaceOrder({ pair: krakenPair, side: closeSide, ordertype: 'market', volume: pos.size });
  }

  const pnl = closePrice ? (closeSide === 'sell' ? (closePrice - pos.entryPrice) * pos.size : (pos.entryPrice - closePrice) * pos.size) : null;
  pos.status = 'closed';
  pos.closePrice = closePrice;
  pos.closedAt = new Date().toISOString();
  pos.pnl = pnl;

  _openPositions.splice(idx, 1);
  _tradeLog.unshift({ ...pos });
  if (_tradeLog.length > 200) _tradeLog.pop();

  try {
    await supabaseAdmin.from('trade_log').update({
      status: 'closed', close_price: closePrice, closed_at: pos.closedAt, pnl,
    }).eq('user_id', userId).eq('kraken_txid', pos.krakenTxid || pos.id);
  } catch (_) {}

  return { ok: true, pnl, closePrice, krakenOk: closeOrder.ok };
}

// ─── Autonomous trading cycle ──────────────────────────────────────────────
async function _runTradingCycle() {
  if (_tradingActive || !_tradingEnabled) return;
  _tradingActive = true;
  console.log('[AutoTrade] Cycle started');
  try {
    const context = {
      pair: 'XRPUSD', canTrade: true,
      getTradeHistory: async (limit) => _tradeLog.slice(0, limit || 20),
      saveMemory: async (item) => {
        try { await supabaseAdmin.from('agent_memory').upsert({ user_id: 'owner', key: item.key, value: item.value, category: item.category || 'general' }, { onConflict: 'user_id,key' }); } catch (_) {}
      },
      getOpenPositions: () => [..._openPositions],
      placeTrade: (input) => _executeTrade(input, 'owner'),
      closePosition: (posId) => _closePosition(posId, 'owner'),
      autonomousTrading: true,
    };
    await agent.runTradingCycle(context);
  } catch (e) {
    console.error('[AutoTrade] Cycle error:', e.message);
  } finally {
    _tradingActive = false;
  }
}

// ─── Trading control endpoints ────────────────────────────────────────────
app.get('/agent/trading-status', requireAuth, (_req, res) => {
  res.json({
    enabled: _tradingEnabled,
    openPositions: _openPositions,
    recentTrades: _tradeLog.slice(0, 20),
    krakenConfigured: !!(process.env.KRAKEN_API_KEY && process.env.KRAKEN_API_KEY !== 'paste_kraken_api_key_here'),
  });
});

app.post('/agent/trading-enable', requireAuth, async (req, res) => {
  if (!isOwner(req.user)) return res.status(403).json({ error: 'Owner only' });
  _tradingEnabled = true;
  console.log('[AutoTrade] ENABLED by owner');
  res.json({ ok: true, enabled: true });
});

app.post('/agent/trading-disable', requireAuth, async (req, res) => {
  if (!isOwner(req.user)) return res.status(403).json({ error: 'Owner only' });
  _tradingEnabled = false;
  console.log('[AutoTrade] DISABLED by owner');
  res.json({ ok: true, enabled: false });
});

app.post('/agent/trading-close-all', requireAuth, async (req, res) => {
  if (!isOwner(req.user)) return res.status(403).json({ error: 'Owner only' });
  _tradingEnabled = false;
  const results = [];
  for (const pos of [..._openPositions]) {
    results.push(await _closePosition(pos.id, req.user.id));
  }
  res.json({ ok: true, closed: results.length, results });
});

app.delete('/agent/position/:id', requireAuth, async (req, res) => {
  if (!isOwner(req.user)) return res.status(403).json({ error: 'Owner only' });
  const result = await _closePosition(req.params.id, req.user.id);
  res.json(result);
});

app.get('/agent/balance', requireAuth, async (_req, res) => {
  const balance = await _krakenBalance();
  res.json({ ok: !!balance, balance });
});

// ─── Start ─────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`NEXUS proxy running on port ${PORT}`);
  setTimeout(() => simEngine.start(), 3000);
  startBackgroundRefresh();

  // Autonomous learning — first run 5 min after boot, then every hour
  setTimeout(() => {
    agent.runLearningCycle().catch(e => console.error('[LearnCycle] error:', e));
    setInterval(() => {
      agent.runLearningCycle().catch(e => console.error('[LearnCycle] error:', e));
    }, 60 * 60 * 1000);
  }, 5 * 60 * 1000);

  // Autonomous trading — every 5 minutes when enabled
  setInterval(_runTradingCycle, 5 * 60 * 1000);
});
