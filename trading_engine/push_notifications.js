'use strict';

require('dotenv').config();
const webpush = require('web-push');
const { supabase, supabaseAdmin } = require('./supabase');

const db = supabaseAdmin || supabase;

const _vapidReady = !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
if (_vapidReady) {
  webpush.setVapidDetails(
    process.env.VAPID_EMAIL || 'mailto:admin@nexus.app',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
} else {
  console.warn('[push] VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY not set — push notifications disabled');
}

// ─── Save push subscription for a user ────────────────────────────────────
async function saveSubscription(userId, subscription) {
  await db.from('push_subscriptions').upsert(
    { user_id: userId, subscription: JSON.stringify(subscription), updated_at: new Date().toISOString() },
    { onConflict: 'user_id' }
  );
}

// ─── Delete subscription (user disabled notifications) ────────────────────
async function deleteSubscription(userId) {
  await db.from('push_subscriptions').delete().eq('user_id', userId);
}

// ─── Send push to a single user ──────────────────────────────────────────
async function sendToUser(userId, payload) {
  if (!_vapidReady) return;
  const { data } = await db.from('push_subscriptions').select('subscription').eq('user_id', userId).single();
  if (!data?.subscription) return;
  try {
    await webpush.sendNotification(JSON.parse(data.subscription), JSON.stringify(payload));
  } catch (e) {
    if (e.statusCode === 410) await deleteSubscription(userId); // expired
  }
}

// ─── Notification builders ────────────────────────────────────────────────
function notify(userId, type, data) {
  const payloads = {
    trade_entry: {
      title: `⚡ NEXUS SIGNAL — ${data.pair}`,
      body: `Entry @ $${data.price} | Score: ${data.score}/100 | ${data.regime}`,
      icon: '/icon.png', tag: 'trade_entry'
    },
    trade_exit: {
      title: `${data.pnl >= 0 ? '✅ WIN' : '❌ LOSS'} — ${data.pair}`,
      body: `Exit @ $${data.price} | ${data.pnl >= 0 ? '+' : ''}${data.pnlBps?.toFixed(1)} bps | ${data.reason}`,
      icon: '/icon.png', tag: 'trade_exit'
    },
    stop_loss: {
      title: `🛑 STOP LOSS — ${data.pair}`,
      body: `Stopped out @ $${data.price} | Loss: ${data.pnlBps?.toFixed(1)} bps`,
      icon: '/icon.png', tag: 'stop_loss'
    },
    take_profit: {
      title: `🎯 TAKE PROFIT — ${data.pair}`,
      body: `Target hit @ $${data.price} | Profit: +${data.pnlBps?.toFixed(1)} bps`,
      icon: '/icon.png', tag: 'take_profit'
    },
    price_alert: {
      title: `📍 PRICE ALERT — ${data.pair}`,
      body: `${data.pair} hit your target of $${data.targetPrice} — current: $${data.price}`,
      icon: '/icon.png', tag: 'price_alert'
    },
    rsi_extreme: {
      title: `📊 RSI EXTREME — ${data.pair}`,
      body: `RSI ${data.rsi?.toFixed(1)} — ${data.rsi < 30 ? 'Oversold — potential buy zone' : 'Overbought — potential sell zone'}`,
      icon: '/icon.png', tag: 'rsi_extreme'
    },
    high_confluence: {
      title: `🔥 HIGH CONFLUENCE — ${data.pair}`,
      body: `Score: ${data.score}/100 | ${data.verdict} | ${data.regime}`,
      icon: '/icon.png', tag: 'high_confluence'
    },
    volume_spike: {
      title: `📈 VOLUME SPIKE — ${data.pair}`,
      body: `Volume ${data.ratio?.toFixed(1)}x above average — unusual activity detected`,
      icon: '/icon.png', tag: 'volume_spike'
    },
    bb_squeeze: {
      title: `🎯 BB SQUEEZE — ${data.pair}`,
      body: `Bollinger Bands compressing — breakout likely incoming on ${data.pair}`,
      icon: '/icon.png', tag: 'bb_squeeze'
    },
    regime_change: {
      title: `🔄 REGIME CHANGE — ${data.pair}`,
      body: `Market shifted: ${data.from} → ${data.to} | Bot adjusting strategy`,
      icon: '/icon.png', tag: 'regime_change'
    },
    brain_update: {
      title: `🧠 NEXUS LEARNED — ${data.pair}`,
      body: data.message || 'Bot updated parameters based on recent trades',
      icon: '/icon.png', tag: 'brain_update'
    },
    fear_greed: {
      title: `😱 FEAR & GREED ALERT`,
      body: `Market sentiment: ${data.label} (${data.value}/100) — ${data.value < 20 ? 'Historically strong buy zone' : 'Extreme greed — caution advised'}`,
      icon: '/icon.png', tag: 'fear_greed'
    },
    obi_spike: {
      title: `🐋 OBI SPIKE — ${data.pair}`,
      body: `Order book imbalance: ${data.obi?.toFixed(2)} — ${data.obi > 0 ? 'Strong buy pressure' : 'Strong sell pressure'}`,
      icon: '/icon.png', tag: 'obi_spike'
    },
    support_resistance: {
      title: `📍 LEVEL HIT — ${data.pair}`,
      body: `${data.pair} approaching ${data.levelType} at $${data.level} — watch for reaction`,
      icon: '/icon.png', tag: 'support_resistance'
    },
    bot_status: {
      title: `🤖 BOT ${data.status} — NEXUS`,
      body: data.message || `Bot is now ${data.status}`,
      icon: '/icon.png', tag: 'bot_status'
    },
    weekly_report: {
      title: `📊 WEEKLY REPORT`,
      body: `${data.trades} trades | Win rate: ${data.winRate}% | P&L: ${data.pnl > 0 ? '+' : ''}${data.pnlBps?.toFixed(0)} bps`,
      icon: '/icon.png', tag: 'weekly_report'
    },
    connection_lost: {
      title: `⚠️ CONNECTION LOST`,
      body: `NEXUS lost connection to ${data.exchange || 'exchange'} — check your API keys`,
      icon: '/icon.png', tag: 'connection_lost'
    },
  };

  const payload = payloads[type];
  if (!payload) return;
  return sendToUser(userId, payload);
}

module.exports = { saveSubscription, deleteSubscription, sendToUser, notify };
