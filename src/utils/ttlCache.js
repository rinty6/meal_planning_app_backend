// Small TTL cache for in-process response memoization.
// Entries expire after `ttlMs` and the store is bounded by `maxEntries` so a
// runaway key space cannot grow the heap unchecked. Oldest-first eviction is
// crude but adequate for short-lived response caches keyed by (user, params).

export const createTtlCache = ({ ttlMs, maxEntries = 1000 } = {}) => {
  if (!ttlMs || ttlMs <= 0) {
    throw new Error("createTtlCache requires a positive ttlMs.");
  }

  const store = new Map();

  const evictExpired = () => {
    const now = Date.now();
    for (const [key, entry] of store) {
      if (now - entry.cachedAt > ttlMs) {
        store.delete(key);
      }
    }
  };

  const enforceCapacity = () => {
    while (store.size > maxEntries) {
      const oldestKey = store.keys().next().value;
      if (oldestKey === undefined) break;
      store.delete(oldestKey);
    }
  };

  return {
    get(key) {
      const entry = store.get(key);
      if (!entry) return null;
      if (Date.now() - entry.cachedAt > ttlMs) {
        store.delete(key);
        return null;
      }
      return entry.value;
    },
    set(key, value) {
      // Re-inserting moves the key to the newest position in Map iteration order.
      store.delete(key);
      store.set(key, { value, cachedAt: Date.now() });
      evictExpired();
      enforceCapacity();
    },
    delete(key) {
      return store.delete(key);
    },
    clear() {
      store.clear();
    },
    size() {
      return store.size;
    },
  };
};
