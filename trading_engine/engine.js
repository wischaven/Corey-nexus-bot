// Trading Engine: Connects risk management, order types, and market data
const RiskManager = require('./risk_management');
const OrderTypes = require('./order_types');
const MarketData = require('./market_data');

// Example config
const config = {
  stopLoss: 0.01, // 1%
  takeProfit: 0.02, // 2%
  maxPositionSize: 1000,
};

const riskManager = new RiskManager(config);
const marketData = new MarketData();

let position = null;
let entryPrice = null;
let accountBalance = 10000;
const riskPerTrade = 0.01; // 1% of balance

// Subscribe to market data
dataHandler = (data) => {
  if (!position) {
    // Example entry logic: Buy if price drops below threshold
    if (data.price < data.movingAvg) {
      const size = riskManager.calculatePositionSize(accountBalance, riskPerTrade);
      position = OrderTypes.createMarketOrder(data.symbol, size);
      entryPrice = data.price;
      console.log('Entered position:', position, 'at', entryPrice);
    }
  } else {
    // Check for stop-loss or take-profit
    if (riskManager.shouldStopLoss(entryPrice, data.price)) {
      console.log('Stop-loss triggered at', data.price);
      position = null;
      entryPrice = null;
    } else if (riskManager.shouldTakeProfit(entryPrice, data.price)) {
      console.log('Take-profit triggered at', data.price);
      position = null;
      entryPrice = null;
    }
  }
};

marketData.subscribe(dataHandler);

// Simulate market data
dataFeed = [
  { symbol: 'BTCUSD', price: 100, movingAvg: 105 },
  { symbol: 'BTCUSD', price: 98, movingAvg: 104 },
  { symbol: 'BTCUSD', price: 99, movingAvg: 103 },
  { symbol: 'BTCUSD', price: 102, movingAvg: 102 },
  { symbol: 'BTCUSD', price: 104, movingAvg: 101 },
  { symbol: 'BTCUSD', price: 106, movingAvg: 100 },
];
dataFeed.forEach(tick => marketData.simulateTick(tick));
