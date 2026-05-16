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

// ─── Health check (Railway uses this) ─────────────────────────────────────
app.get('/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));

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

// ─── Start ─────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`NEXUS proxy running on http://localhost:${PORT}`);
  simEngine.start();
});
