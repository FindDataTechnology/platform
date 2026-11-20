// React binding for the list cache (openspec: polish-web-surfaces, capability
// web-list-surfaces). Seeds from the cache so a revisited surface paints
// instantly, revalidates in the background, and re-fetches when its key is
// invalidated or the window regains focus. The pure core (lib/listCache.ts)
// owns storage and subscriptions; this hook owns the React lifecycle.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  listCacheGet,
  listCacheSet,
  listCacheSubscribe,
  type CacheStatus,
} from "../lib/listCache";

export interface ListCacheResult<T> {
  /** Last-known-good payload (from cache or the latest fetch); null before any. */
  data: T | null;
  /** "loading" only until the FIRST payload for this key; "loaded" once cached. */
  status: CacheStatus;
  /** Message from the most recent failed fetch (the surface may ignore it). */
  error: string | null;
  /** Force a re-fetch now. */
  refresh: () => Promise<void>;
}

export interface ListCacheOptions {
  /**
   * Extra automatic attempts when the FIRST fetch for this key fails with no
   * cached payload (cold load), spaced by a short backoff. The surface keeps
   * showing its loading skeleton during the retry; "error" is reserved for
   * the attempt AFTER the budget is spent (openspec: app-center-load-recovery
   * D2). Default 0 — every existing caller keeps the exact current behavior.
   */
  coldRetry?: number;
}

const COLD_RETRY_DELAY_MS = 1200;

export function useListCache<T>(
  key: string,
  fetcher: () => Promise<T>,
  options: ListCacheOptions = {},
): ListCacheResult<T> {
  // Keep the latest fetcher without re-triggering effects on every render.
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const [data, setData] = useState<T | null>(() => listCacheGet<T>(key) ?? null);
  const [status, setStatus] = useState<CacheStatus>(() =>
    listCacheGet(key) !== undefined ? "loaded" : "loading",
  );
  const [error, setError] = useState<string | null>(null);

  // One fetch in flight per key: a focus revalidation landing on a pending
  // cold-retry (or vice versa) must not double-fetch (app-center-load-recovery
  // D2 risk row).
  const inFlight = useRef<Promise<void> | null>(null);
  const coldUsed = useRef(0);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async (): Promise<void> => {
    if (inFlight.current) return inFlight.current;
    const run = (async () => {
      try {
        const next = await fetcherRef.current();
        listCacheSet(key, next);
        setData(next);
        setStatus("loaded");
        setError(null);
        coldUsed.current = 0;
      } catch (e) {
        const budget = optionsRef.current.coldRetry ?? 0;
        if (listCacheGet(key) === undefined && coldUsed.current < budget) {
          // Cold failure with budget left: keep the loading frame and retry
          // after the backoff. The error state must not flash mid-retry —
          // the spec reserves it for the exhausted attempt.
          coldUsed.current += 1;
          setError((e as Error).message);
          retryTimer.current = setTimeout(() => {
            retryTimer.current = null;
            void load();
          }, COLD_RETRY_DELAY_MS);
          return;
        }
        // A background revalidation failure must not blank a surface that already
        // has cached content — keep "loaded" and surface the message only.
        setStatus(listCacheGet(key) !== undefined ? "loaded" : "error");
        setError((e as Error).message);
      } finally {
        inFlight.current = null;
      }
    })();
    inFlight.current = run;
    return run;
  }, [key]);

  // Seed from cache and fetch on mount / key change.
  useEffect(() => {
    const cached = listCacheGet<T>(key);
    setData(cached ?? null);
    setStatus(cached !== undefined ? "loaded" : "loading");
    setError(null);
    coldUsed.current = 0;
    void load();
    return () => {
      if (retryTimer.current !== null) clearTimeout(retryTimer.current);
      retryTimer.current = null;
    };
  }, [key, load]);

  // Revalidate when the window regains focus.
  useEffect(() => {
    const onFocus = () => {
      void load();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [load]);

  // Revalidate when this key is invalidated anywhere in the app.
  useEffect(
    () =>
      listCacheSubscribe(key, () => {
        void load();
      }),
    [key, load],
  );

  return { data, status, error, refresh: load };
}
