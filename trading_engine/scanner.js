'use strict';

const https = require('https');
const {
  calcRSI, calcBB, calcMACD, calcATR, calcVWAP,
  calcStochRSI, calcEMACross, calcVolumeRatio,
  detectRegime, getVerdict, calcConfluenceScore,
} = require('./indicators');

// ─── Pairs to scan (most liquid USD pairs on Kraken) ──────────────────────
const SCAN_PAIRS = [
  'XBTUSD', 'ETHUSD', 'XRPUSD', 'SOLUSD', 'ADAUSD', 'DOTUSD',
  'MATICUSD', 'LINKUSD', 'AVAXUSD', 'UNIUSD', 'ATOMUSD', 'ALGOUSD',
  'LTCUSD', 'BCHUSD', 'XLMUSD', 'FILUSD', 'AAVEUSD', 'MKRUSD',
  'SNXUSD', 'COMPUSD', 'GRTUSD', 'ENJUSD', 'MANAUSD', 'SANDUSD',
  'APEUSD', 'KSMUSD', 'FLOWUSD', 'IMXUSD', 'OPUSD', 'ARBUSD',
];

// Display labels for pairs
const PAIR_LABELS = {
  XBTUSD: 'BTC/USD', ETHUSD: 'ETH/USD', XRPUSD: 'XRP/USD', SOLUSD: 'SOL/USD',
  ADAUSD: 'ADA/USD', DOTUSD: 'DOT/USD', MATICUSD: 'MATIC/USD', LINKUSD: 'LINK/USD',
  AVAXUSD: 'AVAX/USD', UNIUSD: 'UNI/USD', ATOMUSD: 'ATOM/USD', ALGOUSD: 'ALGO/USD',
  LTCUSD: 'LTC/USD', BCHUSD: 'BCH/USD', XLMUSD: 'XLM/USD', FILUSD: 'FIL/USD',
  AAVEUSD: 'AAVE/USD', MKRUSD: 'MKR/USD', SNXUSD: 'SNX/USD', COMPUSD: 'COMP/USD',
  GRTUSD: 'GRT/USD', ENJUSD: 'ENJ/USD', MANAUSD: 'MANA/USD', SANDUSD: 'SAND/USD',
  APEUSD: 'APE/USD', KSMUSD: 'KSM/USD', FLOWUSD: 'FLOW/USD', IMXUSD: 'IMX/USD',
  OPUSD: 'OP/USD', ARBUSD: 'ARB/USD',
};

// ─── HTTP helper ─────────────────────────────────────────────────────────
function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'NEXUS-Scanner/1.0' } }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('JSON parse error: ' + e.message)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(new Error('timeout')); });
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Fetch OHLC for one pair (60-min candles, last 100) ─────────────────
async function fetchOHLC(pair) {
  try {
    const url = `https://api.kraken.com/0/public/OHLC?pair=${pair}&interval=60&count=100`;
    const json = await fetchJSON(url);
    if (json.error && json.error.length) return null;
    const key = Object.keys(json.result || {}).find(k => k !== 'last');
    if (!key) return null;
    return json.result[key].map(c => ({
      time:   c[0],
      open:   parseFloat(c[1]),
      high:   parseFloat(c[2]),
      low:    parseFloat(c[3]),
      close:  parseFloat(c[4]),
      volume: parseFloat(c[6]),
    }));
  } catch { return null; }
}

// ─── Bulk ticker fetch for quick pre-scoring ──────────────────────────────
async function fetchBulkTickers(pairs) {
  try {
    const url = `https://api.kraken.com/0/public/Ticker?pair=${pairs.join(',')}`;
    const json = await fetchJSON(url);
    if (json.error && json.error.length) return {};
    return json.result || {};
  } catch { return {}; }
}

// ─── Score one pair from its OHLC data ───────────────────────────────────
function scorePair(pair, candles, tickerInfo) {
  const closes  = candles.map(c => c.close);
  const volumes = candles.map(c => c.volume);
  const price   = closes[closes.length - 1];

  const rsi      = calcRSI(closes);
  const bb       = calcBB(closes);
  const macd     = calcMACD(closes);
  const atr      = calcATR(candles);
  const vwap     = calcVWAP(candles);
  const stochRsi = calcStochRSI(closes);
  const emaCross = calcEMACross(closes);
  const volRatio = calcVolumeRatio(volumes);
  const regime   = detectRegime(candles, emaCross, atr, bb);
  const verdict  = getVerdict(rsi, bb, macd);

  // OBI from ticker (ask vs bid volume at top of book)
  let obi = null;
  if (tickerInfo) {
    const bid = parseFloat(tickerInfo.b?.[2] || 0);
    const ask = parseFloat(tickerInfo.a?.[2] || 0);
    const total = bid + ask;
    if (total > 0) obi = (bid - ask) / total;
  }

  const score = calcConfluenceScore({ rsi, bb, macd, obi, stochRsi, vwap, emaCross, volRatio, price });

  // 24h change
  let change24h = null;
  if (tickerInfo) {
    const open24h = parseFloat(tickerInfo.o);
    if (open24h > 0) change24h = ((price - open24h) / open24h) * 100;
  }

  // 24h volume in USD
  let volume24h = null;
  if (tickerInfo) {
    const vol = parseFloat(tickerInfo.v?.[1] || 0);
    volume24h = vol * price;
  }

  return {
    pair,
    label:     PAIR_LABELS[pair] || pair,
    score:     Math.round(score),
    price,
    change24h: change24h !== null ? +change24h.toFixed(2) : null,
    volume24h: volume24h !== null ? Math.round(volume24h) : null,
    regime,
    verdict,
    rsi:       +rsi.toFixed(1),
    bb:        bb ? { pct: +bb.pct.toFixed(3), width: +bb.width.toFixed(2) } : null,
    macd:      macd ? { hist: +macd.hist.toFixed(6) } : null,
    emaCross:  emaCross ? { bullish: emaCross.bullish, crossedUp: emaCross.crossedUp, crossedDown: emaCross.crossedDown } : null,
    volRatio:  +volRatio.toFixed(2),
    obi:       obi !== null ? +obi.toFixed(3) : null,
    atr:       atr ? +atr.value.toFixed(6) : null,
  };
}

// ─── Cache ────────────────────────────────────────────────────────────────
let _cache = null;
let _cacheTime = 0;
const CACHE_TTL_MS = 55 * 1000;

let _scanning = false;

// ─── Main scan function ───────────────────────────────────────────────────
async function runScan() {
  if (_scanning) {
    // Return stale cache while scanning, or null if no cache yet
    return _cache;
  }

  const now = Date.now();
  if (_cache && (now - _cacheTime) < CACHE_TTL_MS) {
    return _cache;
  }

  _scanning = true;
  try {
    // Step 1: bulk ticker for all pairs at once
    const tickerMap = await fetchBulkTickers(SCAN_PAIRS);

    // Step 2: fetch OHLC in small batches to avoid rate limits
    const BATCH = 5;
    const results = [];

    for (let i = 0; i < SCAN_PAIRS.length; i += BATCH) {
      const batch = SCAN_PAIRS.slice(i, i + BATCH);
      const fetches = batch.map(pair => fetchOHLC(pair));
      const ohlcArr = await Promise.all(fetches);

      for (let j = 0; j < batch.length; j++) {
        const pair   = batch[j];
        const candles = ohlcArr[j];
        if (!candles || candles.length < 30) continue;

        // Find ticker key — Kraken may return XXBTZUSD instead of XBTUSD, etc.
        const tickerKey = Object.keys(tickerMap).find(k =>
          k === pair || k === 'X' + pair || k.replace(/^X|Z/g, '') === pair || k.includes(pair.slice(0, 3))
        );
        const tickerInfo = tickerKey ? tickerMap[tickerKey] : null;

        try {
          const result = scorePair(pair, candles, tickerInfo);
          results.push(result);
        } catch { /* skip bad pair */ }
      }

      // Throttle between batches: 300ms gap
      if (i + BATCH < SCAN_PAIRS.length) await sleep(300);
    }

    // Sort by score descending
    results.sort((a, b) => b.score - a.score);

    _cache = {
      scannedAt: Date.now(),
      count:     results.length,
      results,
      top3:      results.slice(0, 3),
    };
    _cacheTime = Date.now();

    return _cache;
  } finally {
    _scanning = false;
  }
}

// ─── Background refresh — keeps cache warm ────────────────────────────────
function startBackgroundRefresh() {
  // First scan after 5s startup delay
  setTimeout(() => {
    runScan().catch(() => {});
    // Then refresh every 60s
    setInterval(() => runScan().catch(() => {}), 60 * 1000);
  }, 5000);
}

module.exports = { runScan, startBackgroundRefresh, SCAN_PAIRS, PAIR_LABELS };
