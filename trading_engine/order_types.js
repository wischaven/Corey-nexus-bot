// Advanced Order Types Module
// Supports limit, market, post-only, iceberg, TWAP, VWAP (stubs)

class OrderTypes {
  static createLimitOrder(symbol, price, size) {
    return { type: 'limit', symbol, price, size };
  }
  static createMarketOrder(symbol, size) {
    return { type: 'market', symbol, size };
  }
  static createPostOnlyOrder(symbol, price, size) {
    return { type: 'post-only', symbol, price, size };
  }
  static createIcebergOrder(symbol, price, totalSize, visibleSize) {
    return { type: 'iceberg', symbol, price, totalSize, visibleSize };
  }
  static createTWAPOrder(symbol, totalSize, duration) {
    return { type: 'twap', symbol, totalSize, duration };
  }
  static createVWAPOrder(symbol, totalSize, duration) {
    return { type: 'vwap', symbol, totalSize, duration };
  }
}

module.exports = OrderTypes;
