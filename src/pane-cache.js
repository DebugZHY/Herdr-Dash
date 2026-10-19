'use strict';
/*
 * src/pane-cache.js — TTL + single-flight cache for herdr pane reads (W1).
 *
 * The terminal view polls /api/pane on a ~150 ms cadence. Several requests for
 * the same key can overlap, and a burst of UI opens the session list several
 * times at once. This cache does two things:
 *
 *   - short TTL reuse: a resolved value is served for ttlMs;
 *   - single-flight: concurrent calls for one key share a single loader call.
 *
 * Only successful loads are cached. A rejected loader removes the in-flight
 * entry and is never stored, so the next caller retries upstream.
 *
 * The entry table is LRU-bounded (Map insertion order, refreshed on access).
 */

const DEFAULT_MAX_ENTRIES = 256;

/**
 * Create an independent cache.
 * @param {{maxEntries?: number}} [options]
 */
function createCache(options) {
  const maxEntries =
    options && Number.isInteger(options.maxEntries) && options.maxEntries > 0
      ? options.maxEntries
      : DEFAULT_MAX_ENTRIES;

  /** @type {Map<string, {value: *, expires: number}>} */
  const entries = new Map();
  /** @type {Map<string, {promise: Promise<*>}>} */
  const pending = new Map();
  const counters = {
    hits: 0,       // served from a resolved entry
    coalesced: 0,  // joined an in-flight load (a cache hit for the caller)
    misses: 0,     // started a new load
    loads: 0,      // loader invocations (upstream calls)
    errors: 0,
    expired: 0,
    evictions: 0,
  };

  function evictIfNeeded() {
    while (entries.size > maxEntries) {
      const oldest = entries.keys().next().value;
      entries.delete(oldest);
      counters.evictions += 1;
    }
  }

  function touch(key, entry) {
    // Re-insert to mark the entry as most recently used.
    entries.delete(key);
    entries.set(key, entry);
  }

  function store(key, value, ttlMs) {
    if (!(ttlMs > 0)) return;
    entries.set(key, { value, expires: Date.now() + ttlMs });
    evictIfNeeded();
  }

  /** Tag a promise with the cache outcome without changing its resolution. */
  function tagged(promise, hit) {
    promise.cacheHit = hit;
    return promise;
  }

  /**
   * Return the value for `key`, loading it with `loader` on a miss.
   * Concurrent calls for one key share the first loader call. The returned
   * promise always resolves to the value; its `.cacheHit` property (set
   * synchronously) says whether this caller was served without an upstream
   * call (fresh hit or joined in-flight load).
   *
   * @param {string} key
   * @param {number} ttlMs
   * @param {() => (Promise<*>|*)} loader
   * @returns {Promise<*>}
   */
  function memo(key, ttlMs, loader) {
    const k = String(key);
    const ttl = Number(ttlMs) > 0 ? Number(ttlMs) : 0;

    const entry = entries.get(k);
    if (entry && entry.expires > Date.now()) {
      counters.hits += 1;
      touch(k, entry);
      return tagged(Promise.resolve(entry.value), true);
    }
    if (entry) {
      entries.delete(k);
      counters.expired += 1;
    }

    const task = pending.get(k);
    if (task) {
      counters.coalesced += 1;
      // Derived promise: the leader's own promise must report `miss`.
      return tagged(task.promise.then((value) => value), true);
    }

    counters.misses += 1;
    counters.loads += 1;
    const next = {};
    next.promise = Promise.resolve()
      .then(() => loader())
      .then(
        (value) => {
          // If clear() invalidated this key while the loader ran, do not
          // repopulate the cache with a pre-clear result.
          if (pending.get(k) === next) {
            pending.delete(k);
            store(k, value, ttl);
          }
          return value;
        },
        (error) => {
          if (pending.get(k) === next) pending.delete(k);
          counters.errors += 1;
          throw error;
        },
      );
    pending.set(k, next);
    return tagged(next.promise, false);
  }

  /** Remove every entry (and invalidate in-flight loads) whose key starts with `prefix`. */
  function clear(prefix) {
    const p = prefix === undefined || prefix === null ? '' : String(prefix);
    let removed = 0;
    for (const key of Array.from(entries.keys())) {
      if (!p || key.startsWith(p)) {
        entries.delete(key);
        removed += 1;
      }
    }
    // Removing the in-flight task stops it from caching on resolve; callers
    // already waiting still receive its value.
    for (const key of Array.from(pending.keys())) {
      if (!p || key.startsWith(p)) pending.delete(key);
    }
    return removed;
  }

  /** Cumulative counters and current occupancy. */
  function stats() {
    return {
      entries: entries.size,
      inflight: pending.size,
      max_entries: maxEntries,
      hits: counters.hits,
      coalesced: counters.coalesced,
      misses: counters.misses,
      loads: counters.loads,
      errors: counters.errors,
      expired: counters.expired,
      evictions: counters.evictions,
    };
  }

  return { memo, clear, stats };
}

// Module-level default cache, exported for tests and simple callers.
const defaultCache = createCache();

module.exports = {
  createCache,
  memo: defaultCache.memo,
  stats: defaultCache.stats,
  clear: defaultCache.clear,
};
