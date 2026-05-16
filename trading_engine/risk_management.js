// Risk Management Module
// Handles stop-loss, take-profit, and position sizing

class RiskManager {
  constructor(config) {
    this.stopLoss = config.stopLoss || 0.01; // 1% default
    this.takeProfit = config.takeProfit || 0.02; // 2% default
    this.maxPositionSize = config.maxPositionSize || 1000;
  }

  calculatePositionSize(accountBalance, riskPerTrade) {
    // Simple fixed-fractional position sizing
    return Math.min(accountBalance * riskPerTrade, this.maxPositionSize);
  }

  shouldStopLoss(entryPrice, currentPrice) {
    return (currentPrice <= entryPrice * (1 - this.stopLoss));
  }

  shouldTakeProfit(entryPrice, currentPrice) {
    return (currentPrice >= entryPrice * (1 + this.takeProfit));
  }
}

module.exports = RiskManager;
