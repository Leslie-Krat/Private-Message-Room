/**
 * TokenBucketRateLimiter - generic token bucket. Used for message counts (cost 1)
 * and for byte budgets (cost = payload size).
 */
export class TokenBucketRateLimiter {
  constructor(capacity = 5, refillRatePerSec = 2) {
    this.capacity = capacity;
    this.tokens = capacity;
    this.refillRatePerSec = refillRatePerSec;
    this.lastRefill = Date.now();
  }

  /**
   * Consumes `cost` tokens.
   * @returns {boolean} true if allowed, false if rate limited.
   */
  allow(cost = 1) {
    const now = Date.now();
    const elapsedSec = (now - this.lastRefill) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsedSec * this.refillRatePerSec);
    this.lastRefill = now;

    if (cost <= this.tokens) {
      this.tokens -= cost;
      return true;
    }
    return false;
  }
}

/**
 * IPConnectionTracker - limits simultaneous WebSocket connections per IP key.
 */
export class IPConnectionTracker {
  constructor(maxPerIP = 30) {
    this.maxPerIP = maxPerIP;
    this.ipCounts = new Map();
  }

  canConnect(key) {
    return (this.ipCounts.get(key) || 0) < this.maxPerIP;
  }

  increment(key) {
    this.ipCounts.set(key, (this.ipCounts.get(key) || 0) + 1);
  }

  decrement(key) {
    const current = this.ipCounts.get(key) || 0;
    if (current <= 1) this.ipCounts.delete(key);
    else this.ipCounts.set(key, current - 1);
  }
}
