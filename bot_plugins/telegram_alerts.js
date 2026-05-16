'use strict';

// Telegram alert module — sends trade signals and bot status to a Telegram chat.
// Setup: create a bot via @BotFather, get the token, start a chat, get chat_id.
// Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env

const https = require('https');

const TOKEN   = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

function sendMessage(text) {
  if (!TOKEN || !CHAT_ID) return;
  const body = JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: 'HTML' });
  const opts = {
    hostname: 'api.telegram.org',
    path: `/bot${TOKEN}/sendMessage`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
  };
  const req = https.request(opts, () => {});
  req.on('error', () => {});
  req.write(body);
  req.end();
}

function alertEntry({ pair, price, score, regime, verdict }) {
  const emoji = verdict === 'BULLISH' ? '🟢' : verdict === 'BEARISH' ? '🔴' : '🟡';
  sendMessage(
    `${emoji} <b>NEXUS SIGNAL — ${pair}</b>\n` +
    `Price: <code>$${price}</code>\n` +
    `Confluence: <b>${score}/100</b>\n` +
    `Regime: ${regime} | Verdict: ${verdict}\n` +
    `<i>Signal triggered entry conditions</i>`
  );
}

function alertExit({ pair, entry, exit, pnlBps, reason }) {
  const emoji = pnlBps > 0 ? '✅' : '❌';
  sendMessage(
    `${emoji} <b>NEXUS EXIT — ${pair}</b>\n` +
    `Entry: <code>$${entry}</code> → Exit: <code>$${exit}</code>\n` +
    `P&amp;L: <b>${pnlBps > 0 ? '+' : ''}${pnlBps.toFixed(1)} bps</b>\n` +
    `Reason: ${reason}`
  );
}

function alertStatus({ pair, winRate, totalTrades, pnl }) {
  sendMessage(
    `📊 <b>NEXUS DAILY SUMMARY — ${pair}</b>\n` +
    `Trades: ${totalTrades} | Win Rate: ${(winRate * 100).toFixed(1)}%\n` +
    `Total P&amp;L: ${pnl > 0 ? '+' : ''}${pnl.toFixed(2)} bps`
  );
}

module.exports = { sendMessage, alertEntry, alertExit, alertStatus };
