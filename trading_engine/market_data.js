// Real-Time Market Data Handler (stub)
// Replace with actual exchange API integration

class MarketData {
  constructor() {
    this.subscribers = [];
  }
  subscribe(callback) {
    this.subscribers.push(callback);
  }
  onData(data) {
    this.subscribers.forEach(cb => cb(data));
  }
  // Simulate receiving data
  simulateTick(data) {
    this.onData(data);
  }
}

module.exports = MarketData;
