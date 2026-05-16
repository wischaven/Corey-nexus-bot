// ═══════════════════════════════════════════════════════════════════════════
// Order Book Analysis — Kraken Level-2 depth, OBI, wall detection
//
// Order Book Imbalance (OBI) is the #1 microstructure signal for short-term
// price prediction in thin markets. If bids dominate → price goes up.
// Range: -1.0 (pure sell pressure) to +1.0 (pure buy pressure)
// ═══════════════════════════════════════════════════════════════════════════

'use strict';

// ─── Fetch Kraken depth ───────────────────────────────────────────────────
// Returns raw { bids: [[price,vol,ts],...], asks: [[price,vol,ts],...] }
// krakenGet is a function(endpoint) → Promise<json> passed in from sim_engine

async function fetchOrderBook(krakenGet, pair = 'SHXUSD', levels = 20) {
  const res = await krakenGet(`0/public/Depth?pair=${pair}&count=${levels}`);
  if (res.error && res.error.length) {
    throw new Error('Order book error: ' + res.error.join(', '));
  }
  const result = res.result || {};
  const key = Object.keys(result)[0];
  if (!key) throw new Error('No order book key found');
  const raw = result[key];
  return {
    bids: raw.bids.map(r => ({ price: parseFloat(r[0]), vol: parseFloat(r[1]) })),
    asks: raw.asks.map(r => ({ price: parseFloat(r[0]), vol: parseFloat(r[1]) })),
  };
}

// ─── Order Book Imbalance ─────────────────────────────────────────────────
// OBI = (bidVol - askVol) / (bidVol + askVol)
// Positive = buy pressure, negative = sell pressure.
// levels: how many price levels to include (shallower = more leading, noisier)

function calcOBI(book, levels = 10) {
  if (!book || !book.bids || !book.asks) return 0;
  const bids = book.bids.slice(0, levels);
  const asks = book.asks.slice(0, levels);
  const bidVol = bids.reduce((s, r) => s + r.vol, 0);
  const askVol = asks.reduce((s, r) => s + r.vol, 0);
  const total = bidVol + askVol;
  if (total === 0) return 0;
  return (bidVol - askVol) / total;
}

// ─── Bid/Ask wall detection ───────────────────────────────────────────────
// A "wall" is a single level whose volume is > threshold× average level volume.
// Large walls act as price magnets and barriers — knowing where they are helps
// predict where price will stall or reverse.

function detectWalls(book, threshold = 3.0) {
  if (!book || !book.bids || !book.asks) return { bidWall: null, askWall: null };

  function findWall(levels) {
    if (!levels.length) return null;
    const avg = levels.reduce((s, r) => s + r.vol, 0) / levels.length;
    let biggest = null;
    for (const r of levels) {
      if (r.vol > avg * threshold) {
        if (!biggest || r.vol > biggest.vol) biggest = r;
      }
    }
    return biggest;
  }

  const bidWall = findWall(book.bids.slice(0, 15));
  const askWall = findWall(book.asks.slice(0, 15));

  return { bidWall, askWall };
}

// ─── Effective spread for our order size ─────────────────────────────────
// When we buy, we walk up the ask side. If our order size is larger than the
// best ask, we get partial fills at worse prices. This returns the true cost.

function calcEffectiveSpread(book, orderSizeUSD, currentPrice) {
  if (!book || !book.asks || !book.bids) return null;
  const orderSizeCoin = currentPrice > 0 ? orderSizeUSD / currentPrice : 0;

  let remaining = orderSizeCoin;
  let totalCost = 0;
  for (const ask of book.asks) {
    const fill = Math.min(remaining, ask.vol);
    totalCost += fill * ask.price;
    remaining -= fill;
    if (remaining <= 0) break;
  }
  if (remaining > 0) return null; // not enough liquidity

  const effectiveAsk = totalCost / orderSizeCoin;
  const effectiveBid = book.bids[0] ? book.bids[0].price : currentPrice;
  const spreadBps = ((effectiveAsk - effectiveBid) / effectiveBid) * 10000;

  return {
    effectiveAsk,
    effectiveBid,
    spreadBps,
    filled: true,
  };
}

// ─── Book pressure summary ────────────────────────────────────────────────
// Quick single-object summary of book state for logging/display

function summarizeBook(book, orderSizeUSD = 50, currentPrice = 0) {
  const obi    = calcOBI(book, 10);
  const walls  = detectWalls(book, 3.0);
  const effSpr = calcEffectiveSpread(book, orderSizeUSD, currentPrice);

  // Depth within 0.5% of mid price
  const mid = currentPrice || (book.bids[0] && book.asks[0]
    ? (book.bids[0].price + book.asks[0].price) / 2 : 0);
  const halfPct = mid * 0.005;
  const bidDepth = book.bids
    .filter(r => r.price >= mid - halfPct)
    .reduce((s, r) => s + r.vol * r.price, 0);
  const askDepth = book.asks
    .filter(r => r.price <= mid + halfPct)
    .reduce((s, r) => s + r.vol * r.price, 0);

  return {
    obi,
    obiLabel: obi > 0.3 ? 'STRONG BUY' : obi > 0.1 ? 'BUY' : obi < -0.3 ? 'STRONG SELL' : obi < -0.1 ? 'SELL' : 'NEUTRAL',
    bidWall: walls.bidWall,
    askWall: walls.askWall,
    effectiveSpreadBps: effSpr ? effSpr.spreadBps : null,
    bidDepthUSD: bidDepth,
    askDepthUSD: askDepth,
    bid: book.bids[0] ? book.bids[0].price : null,
    ask: book.asks[0] ? book.asks[0].price : null,
  };
}

module.exports = { fetchOrderBook, calcOBI, detectWalls, calcEffectiveSpread, summarizeBook };
