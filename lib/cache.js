// BitChord caches manifests/search for 10 min and streams for 5 min.
// This keeps us from hammering upstream when several devices share one addon.

export function createCache(ttlMs, maxEntries = 500) {
  const store = new Map();

  return {
    get(key) {
      const hit = store.get(key);
      if (!hit) return undefined;
      if (Date.now() > hit.expires) {
        store.delete(key);
        return undefined;
      }
      // refresh LRU position
      store.delete(key);
      store.set(key, hit);
      return hit.value;
    },
    set(key, value) {
      if (store.size >= maxEntries) {
        const oldest = store.keys().next().value;
        if (oldest !== undefined) store.delete(oldest);
      }
      store.set(key, { value, expires: Date.now() + ttlMs });
      return value;
    },
    wrap(key, fn) {
      const cached = this.get(key);
      if (cached !== undefined) return Promise.resolve(cached);
      return Promise.resolve(fn()).then((value) => this.set(key, value));
    },
    size: () => store.size,
  };
}

export const searchCache = createCache(10 * 60 * 1000);
export const streamCache = createCache(4 * 60 * 1000);
export const probeCache = createCache(4 * 60 * 1000);