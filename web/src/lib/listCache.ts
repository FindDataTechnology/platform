// Client-side list cache (openspec: polish-web-surfaces, capability
// web-list-surfaces). A process-level Map of last-known-good list payloads and
// a tiny subscription mechanism, so a list surface renders from cache on
// re-entry instead of flashing its empty state and refetching from scratch.
//
// Deliberately framework-free and dependency-free: the React binding lives in
// hooks/useListCache.ts, and this core runs under plain node so it can be
// unit-tested (scripts/test-list-cache.mjs) without a browser runner.

export type CacheStatus = "idle" | "loading" | "loaded" | "error";

export interface CacheEntry<T> {
  data: T;
  at: number;
}

// Bounded so a long-lived tab cannot grow it without limit.
const MAX_ENTRIES = 50;

const store = new Map<string, CacheEntry<unknown>>();
const subscribers = new Set<{ key: string; fn: () => void }>();

// A subscription watches one key; invalidation matches the key itself or a
// parent prefix (`catalog` invalidates `catalog` and `catalog:agents`).
function matches(candidate: string, key: string): boolean {
  return candidate === key || key.startsWith(`${candidate}:`);
}

export function listCacheGet<T>(key: string): T | undefined {
  return store.get(key)?.data as T | undefined;
}

export function listCacheSet<T>(key: string, data: T): void {
  // Re-insert to refresh insertion order (Map preserves it) so eviction drops
  // the least-recently-written entry.
  store.delete(key);
  store.set(key, { data, at: Date.now() });
  while (store.size > MAX_ENTRIES) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
}

export function listCacheHas(key: string): boolean {
  return store.has(key);
}

// Drop cached entries under `key` (exact or `key:` prefix) and tell every
// matching subscriber to revalidate. Returns the number of entries dropped.
export function listCacheInvalidate(key: string): number {
  let dropped = 0;
  for (const k of [...store.keys()]) {
    if (matches(key, k)) {
      store.delete(k);
      dropped += 1;
    }
  }
  for (const sub of [...subscribers]) {
    if (matches(key, sub.key)) sub.fn();
  }
  return dropped;
}

// Drop everything (identity or role change, sign-out) and revalidate all
// subscribers.
export function listCacheClear(): void {
  store.clear();
  for (const sub of [...subscribers]) sub.fn();
}

// Subscribe to invalidations matching `key`. Returns an unsubscribe function.
export function listCacheSubscribe(key: string, fn: () => void): () => void {
  const entry = { key, fn };
  subscribers.add(entry);
  return () => {
    subscribers.delete(entry);
  };
}

// Test-only visibility into the subscriber count (leak checks).
export function __listCacheSubscriberCount(): number {
  return subscribers.size;
}
