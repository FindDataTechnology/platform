// web/src/lib/chunk-failure.ts — framework-free core behind the shell's
// stale-chunk self-heal (openspec: harden-spa-shell-resilience,
// web-shell-resilience「chunk 加载失败自动重载一次」).
//
// Two jobs, both testable under plain node:
//  - classify an error as a lazy-import (chunk) failure — the signal that
//    the loaded shell is older than the server's current dist;
//  - claim the one automatic reload PER failed module URL for this browser
//    session, so a broken deploy cannot loop (reload → same chunk fails at
//    boot → reload → …). URL keying (not a global boolean) is what lets a
//    later, genuinely different rollout still self-heal in the same tab.

const KEY = "shell-reload-chunks";
// A long-lived tab hitting more than this many distinct stale chunks means
// something beyond a rollout race; stop tracking and just show the error card.
const MAX_TRACKED = 10;

/** True when `error` reads like a dynamic-import failure across the four
 *  engine wordings (Chrome / Firefox / Safari / webpack-style ChunkLoadError). */
export function isChunkLoadError(error: unknown): boolean {
  const e = error as { message?: unknown; name?: unknown } | null;
  // webpack/rollup-style failures signal through `name` ("ChunkLoadError")
  // with a plain message; the engines' fetch rejections signal through the
  // message text. Classify the union of both channels.
  const haystack = `${String(e?.name ?? "")} ${String(e?.message ?? error ?? "")}`;
  return (
    /Failed to fetch dynamically imported module/i.test(haystack) ||
    /error loading dynamically imported module/i.test(haystack) ||
    /Importing a module script failed/i.test(haystack) ||
    /ChunkLoadError/i.test(haystack) ||
    /Loading(?: CSS)? chunk\b/i.test(haystack)
  );
}

/** The stable identity of a failure: the message carries the module URL on
 *  every engine wording above; message-less errors key on their name. */
export function chunkFailureKey(error: unknown): string {
  const msg = String((error as { message?: unknown } | null)?.message ?? error ?? "unknown");
  return msg.slice(0, 500);
}

interface KvStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

// sessionStorage can throw in private-mode/quota corners; an in-memory Set
// still prevents the same-document reload loop, which is the safety-critical
// half of the guarantee.
const memoryFallback = new Map<string, string>();
const memoryStore: KvStore = {
  getItem: (k) => memoryFallback.get(k) ?? null,
  setItem: (k, v) => void memoryFallback.set(k, v),
};

function defaultStore(): KvStore {
  try {
    const probe = "__shell_probe__";
    window.sessionStorage.setItem(probe, "1");
    window.sessionStorage.removeItem(probe);
    return window.sessionStorage;
  } catch {
    return memoryStore;
  }
}

/**
 * Claim the one automatic reload for `url`. Returns true the FIRST time this
 * URL fails in the session (the caller reloads), false on every repeat (the
 * caller renders the error card). `store` is injectable for tests.
 */
export function claimReloadOnce(url: string, store?: KvStore): boolean {
  const kv = store ?? defaultStore();
  let urls: string[] = [];
  try {
    urls = JSON.parse(kv.getItem(KEY) ?? "[]");
    if (!Array.isArray(urls)) urls = [];
  } catch {
    urls = [];
  }
  if (urls.includes(url)) return false;
  if (urls.length >= MAX_TRACKED) return false;
  urls.push(url);
  try {
    kv.setItem(KEY, JSON.stringify(urls));
  } catch {
    /* store went away mid-flight; in-memory dedupe already covers this tab */
  }
  return true;
}
