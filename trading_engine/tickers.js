'use strict';

// All Kraken pairs available to NEXUS users.
// Grouped by category for the UI picker dropdown.

const TICKERS = {
  'MAJOR — BTC': [
    { pair: 'XBTUSD',  label: 'BTC/USD' },
    { pair: 'XBTEUR',  label: 'BTC/EUR' },
    { pair: 'XBTGBP',  label: 'BTC/GBP' },
    { pair: 'XBTUSDT', label: 'BTC/USDT' },
    { pair: 'XBTUSDC', label: 'BTC/USDC' },
  ],
  'MAJOR — ETH': [
    { pair: 'ETHUSD',  label: 'ETH/USD' },
    { pair: 'ETHEUR',  label: 'ETH/EUR' },
    { pair: 'ETHBTC',  label: 'ETH/BTC' },
    { pair: 'ETHUSDT', label: 'ETH/USDT' },
    { pair: 'ETHUSDC', label: 'ETH/USDC' },
  ],
  'LAYER 1': [
    { pair: 'XRPUSD',  label: 'XRP/USD' },
    { pair: 'XRPEUR',  label: 'XRP/EUR' },
    { pair: 'XRPBTC',  label: 'XRP/BTC' },
    { pair: 'XRPUSDT', label: 'XRP/USDT' },
    { pair: 'SOLUSD',  label: 'SOL/USD' },
    { pair: 'SOLUSDT', label: 'SOL/USDT' },
    { pair: 'SOLBTC',  label: 'SOL/BTC' },
    { pair: 'ADAUSD',  label: 'ADA/USD' },
    { pair: 'ADAEUR',  label: 'ADA/EUR' },
    { pair: 'ADABTC',  label: 'ADA/BTC' },
    { pair: 'AVAXUSD', label: 'AVAX/USD' },
    { pair: 'AVAXBTC', label: 'AVAX/BTC' },
    { pair: 'DOTUSD',  label: 'DOT/USD' },
    { pair: 'DOTBTC',  label: 'DOT/BTC' },
    { pair: 'NEARUSD', label: 'NEAR/USD' },
    { pair: 'NEARBTC', label: 'NEAR/BTC' },
    { pair: 'ATOMUSD', label: 'ATOM/USD' },
    { pair: 'ATOMBTC', label: 'ATOM/BTC' },
    { pair: 'ALGOUSD', label: 'ALGO/USD' },
    { pair: 'TRONUSD', label: 'TRX/USD' },
  ],
  'LAYER 2 / SCALING': [
    { pair: 'MATICUSD',  label: 'MATIC/USD' },
    { pair: 'MATICBTC',  label: 'MATIC/BTC' },
    { pair: 'OPUSD',     label: 'OP/USD' },
    { pair: 'OPBTC',     label: 'OP/BTC' },
    { pair: 'ARBUSD',    label: 'ARB/USD' },
    { pair: 'ARBBTC',    label: 'ARB/BTC' },
    { pair: 'LDOUSD',    label: 'LDO/USD' },
    { pair: 'STRK',      label: 'STRK/USD' },
    { pair: 'ZKEVM',     label: 'ZK/USD' },
  ],
  'DeFi': [
    { pair: 'UNIUSD',   label: 'UNI/USD' },
    { pair: 'UNIBTC',   label: 'UNI/BTC' },
    { pair: 'AAVEUSD',  label: 'AAVE/USD' },
    { pair: 'AAVEBTC',  label: 'AAVE/BTC' },
    { pair: 'CRVUSD',   label: 'CRV/USD' },
    { pair: 'MKRUSD',   label: 'MKR/USD' },
    { pair: 'COMPUSD',  label: 'COMP/USD' },
    { pair: 'SNXUSD',   label: 'SNX/USD' },
    { pair: 'YFIUSD',   label: 'YFI/USD' },
    { pair: 'BALUSD',   label: 'BAL/USD' },
    { pair: 'LRCUSD',   label: 'LRC/USD' },
    { pair: 'GRTUSD',   label: 'GRT/USD' },
    { pair: 'RPLBTC',   label: 'RPL/BTC' },
    { pair: 'RPLUSD',   label: 'RPL/USD' },
    { pair: 'PENDLE',   label: 'PENDLE/USD' },
  ],
  'AI / DATA': [
    { pair: 'FETUSDT',  label: 'FET/USDT' },
    { pair: 'FETUSD',   label: 'FET/USD' },
    { pair: 'RENDERUSD',label: 'RENDER/USD' },
    { pair: 'WLDUSD',   label: 'WLD/USD' },
    { pair: 'TAOBTC',   label: 'TAO/BTC' },
    { pair: 'TAOUSD',   label: 'TAO/USD' },
    { pair: 'AGIXUSD',  label: 'AGIX/USD' },
    { pair: 'OCEANBTC', label: 'OCEAN/BTC' },
    { pair: 'OCEANUSD', label: 'OCEAN/USD' },
    { pair: 'AKTUSD',   label: 'AKT/USD' },
  ],
  'MEME': [
    { pair: 'DOGEUSD',  label: 'DOGE/USD' },
    { pair: 'DOGEBTC',  label: 'DOGE/BTC' },
    { pair: 'SHIBUSD',  label: 'SHIB/USD' },
    { pair: 'PEPEUSD',  label: 'PEPE/USD' },
    { pair: 'BONKUSD',  label: 'BONK/USD' },
    { pair: 'WIFUSD',   label: 'WIF/USD' },
    { pair: 'FLOKIUSD', label: 'FLOKI/USD' },
  ],
  'EXCHANGE TOKENS': [
    { pair: 'BNBUSD',   label: 'BNB/USD' },
    { pair: 'CROUPUSD', label: 'CRO/USD' },
    { pair: 'KNCUSD',   label: 'KNC/USD' },
  ],
  'GAMING / METAVERSE': [
    { pair: 'AXSUSD',   label: 'AXS/USD' },
    { pair: 'SANDUSD',  label: 'SAND/USD' },
    { pair: 'MANAUSD',  label: 'MANA/USD' },
    { pair: 'ENJUSD',   label: 'ENJ/USD' },
    { pair: 'GALAUSD',  label: 'GALA/USD' },
    { pair: 'IMXUSD',   label: 'IMX/USD' },
    { pair: 'FLOWUSD',  label: 'FLOW/USD' },
    { pair: 'ILVIUSD',  label: 'ILVI/USD' },
  ],
  'INFRASTRUCTURE': [
    { pair: 'LINKUSD',  label: 'LINK/USD' },
    { pair: 'LINKBTC',  label: 'LINK/BTC' },
    { pair: 'FILUSD',   label: 'FIL/USD' },
    { pair: 'ARRUSD',   label: 'AR/USD' },
    { pair: 'IOTAUSD',  label: 'IOTA/USD' },
    { pair: 'HBARUSD',  label: 'HBAR/USD' },
    { pair: 'ICPUSD',   label: 'ICP/USD' },
    { pair: 'STXUSD',   label: 'STX/USD' },
    { pair: 'APTUSD',   label: 'APT/USD' },
    { pair: 'SUIUSD',   label: 'SUI/USD' },
    { pair: 'SEIUSD',   label: 'SEI/USD' },
    { pair: 'INJUSD',   label: 'INJ/USD' },
    { pair: 'PYTHUSD',  label: 'PYTH/USD' },
    { pair: 'JUPUSD',   label: 'JUP/USD' },
    { pair: 'WUSD',     label: 'W/USD' },
  ],
  'PRIVACY': [
    { pair: 'XMRUSD',   label: 'XMR/USD' },
    { pair: 'XMRBTC',   label: 'XMR/BTC' },
    { pair: 'ZECUSD',   label: 'ZEC/USD' },
    { pair: 'DASHUSD',  label: 'DASH/USD' },
  ],
  'STABLECOINS / PAIRS': [
    { pair: 'USDTUSD',  label: 'USDT/USD' },
    { pair: 'USDCUSD',  label: 'USDC/USD' },
    { pair: 'DAIUSD',   label: 'DAI/USD' },
    { pair: 'PYUSDUSD', label: 'PYUSD/USD' },
    { pair: 'EUROUSD',  label: 'EUR/USD' },
    { pair: 'GBPUSD',   label: 'GBP/USD' },
  ],
};

// Flat list for quick lookup
const ALL_PAIRS = Object.values(TICKERS).flat();

function getPairLabel(pair) {
  const found = ALL_PAIRS.find(t => t.pair === pair);
  return found ? found.label : pair;
}

function isValidPair(pair) {
  return ALL_PAIRS.some(t => t.pair === pair);
}

module.exports = { TICKERS, ALL_PAIRS, getPairLabel, isValidPair };
