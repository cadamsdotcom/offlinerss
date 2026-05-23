'use strict';

/**
 * A bounded cache keyed by id. Entries expire after `ttlMs` and the cache
 * never holds more than `maxEntries` live entries: when full, the
 * least-recently-used entry is evicted. This keeps memory usage bounded so
 * the process doesn't grow forever as new feed entries appear over time.
 *
 * A plain Map preserves insertion order, so the first key is the oldest /
 * least-recently-used. Re-inserting a key on access moves it to the end,
 * giving us LRU ordering for free.
 */
class BoundedCache {
  constructor({ maxEntries = 500, ttlMs = 24 * 60 * 60 * 1000 } = {}) {
    this.maxEntries = maxEntries;
    this.ttlMs = ttlMs;
    this.map = new Map();
  }

  _isExpired(entry, now) {
    return now - entry.storedAt > this.ttlMs;
  }

  get(key) {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (this._isExpired(entry, Date.now())) {
      this.map.delete(key);
      return undefined;
    }
    // Mark as recently used by moving to the end of the Map.
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  set(key, value) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { value, storedAt: Date.now() });
    this._prune();
  }

  has(key) {
    return this.get(key) !== undefined;
  }

  /** Drop expired entries, then evict oldest until within maxEntries. */
  _prune() {
    const now = Date.now();
    for (const [key, entry] of this.map) {
      if (this._isExpired(entry, now)) this.map.delete(key);
    }
    while (this.map.size > this.maxEntries) {
      const oldestKey = this.map.keys().next().value;
      this.map.delete(oldestKey);
    }
  }

  get size() {
    return this.map.size;
  }
}

module.exports = { BoundedCache };
