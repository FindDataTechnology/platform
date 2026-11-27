// ── Turn pricing (add-turn-pricing) ──────────────────────────────────────────
//
// The estimate face of the billing split (S3/S5): 词元 (sub2api) is the ONLY
// billing truth; this module turns its per-token model prices into per-turn
// ESTIMATES for the daily rollup, stamped with the price-table fetch time so
// an estimate is always traceable to the price version that produced it.
//
//   pricingFor(model)   — SYNCHRONOUS cache read (recordTurnEvent is a sync
//                         seam); null = no price known (honest absence, never
//                         a zero pretending to be an observation).
//   estimateTurnCost()  — four-component USD estimate from a TokenUsage shape.
//   refreshTurnPricing(ids) — async cache fill; miss-safe (fire-and-forget on
//                         the turn path), degraded() when the admin key is
//                         absent (pricing stays empty — every column NULL).
//
// v1 estimate口径 = model default price ×1.0 (no group multiplier / effort
// multiplier) — the reconciliation factor surfaces them instead of the
// platform re-deriving 词元's billing logic (design D3).

import { createSub2apiClient } from "../lib/sub2api-admin.js";

const REFRESH_MS = 10 * 60_000;

const client = createSub2apiClient();
// Cache: model id → { input, output, cacheWrite, cacheRead, pricingAt }.
// Single-flight per model: a burst of unseen models coalesces into one fetch.
const cache = new Map();
const inflight = new Map();
// Models the upstream pricing catalog does NOT carry (custom channels): cached
// as null with an attempt stamp — the turn-path miss-fill won't hammer 词元
// per turn, while the periodic refresh clears the stamp and retries (a model
// can gain a price later).
const unpricedAt = new Map();

export function degraded() {
  return clientRef.client.degraded();
}

// Test-only injection (house __test seam precedent, blueprint-judge
// __testApiKeyFor): swap the admin door so tests drive fetch without env.
export function setTurnPricingClientForTests(client) {
  clientRef.client = client;
}
const clientRef = { client };

// Synchronous cache read — the turn seam's only door. Never fetches, never
// throws: a cold cache reads null and the background fill prices the NEXT
// turn.
export function pricingFor(model) {
  if (!model) return null;
  return cache.get(String(model)) ?? null;
}

// Four-component USD estimate. `usage` is the normalized TokenUsage shape
// (input = UNCACHED input; billed input = input + cached + write). Any
// component without a price or without tokens contributes nothing — the
// caller distinguishes "unpriced" (rates null) from "priced but zero".
export function estimateTurnCost(usage, rates) {
  if (!rates || !usage) return null;
  const comp = (tokens, price) => (Number.isFinite(tokens) && Number.isFinite(price) ? tokens * price : 0);
  const input = Number.isFinite(usage.input) ? usage.input : 0;
  const output = Number.isFinite(usage.output) ? usage.output : 0;
  const cached = Number.isFinite(usage.cacheReadTokens) ? usage.cacheReadTokens : 0;
  const write = Number.isFinite(usage.cacheWriteTokens) ? usage.cacheWriteTokens : 0;
  return {
    inputUsd: comp(input, rates.input),
    outputUsd: comp(output, rates.output),
    cacheWriteUsd: comp(write, rates.cacheWrite),
    cacheReadUsd: comp(cached, rates.cacheRead),
    pricingAt: rates.pricingAt ?? null,
  };
}

async function fetchModel(model) {
  const pricing = await clientRef.client.readModelPricing(model);
  if (!pricing.found) {
    // Unpriced upstream (custom channel): cache the ABSENCE with a stamp so
    // the miss doesn't re-fetch every turn — the next refresh window retries.
    cache.set(String(model), null);
    unpricedAt.set(String(model), Date.now());
    return;
  }
  cache.set(String(model), {
    input: pricing.inputPrice,
    output: pricing.outputPrice,
    cacheWrite: pricing.cacheWritePrice,
    cacheRead: pricing.cacheReadPrice,
    pricingAt: Date.now(),
  });
}

// Fill prices for the given model ids. Never throws — a pricing outage must
// not break whatever called it (boot, timer, turn seam).
export async function refreshTurnPricing(models = [], { retryUnpriced = false } = {}) {
  if (clientRef.client.degraded()) return { ok: false, reason: "SUB2API_ADMIN_KEY not configured" };
  if (retryUnpriced) unpricedAt.clear(); // the periodic window retries absent prices
  let fetched = 0;
  for (const id of models) {
    const key = String(id ?? "").trim();
    if (!key || inflight.has(key)) continue;
    const cached = cache.get(key);
    if (cached) continue; // priced — done until the price itself changes (TTL refetch below)
    if (cached === null && unpricedAt.has(key)) continue; // recently probed unpriced — wait for the periodic retry
    const p = fetchModel(key).finally(() => inflight.delete(key));
    inflight.set(key, p);
  }
  const pending = [...inflight.values()];
  await Promise.allSettled(pending);
  fetched = pending.length;
  return { ok: true, cached: cache.size, fetched };
}

// Boot warm-up (server.js): pre-pull the deployment's model roster so the
// first turns already price. Returns the timer for unref by the caller.
export function attachTurnPricing({ modelsProvider = null, intervalMs = REFRESH_MS } = {}) {
  if (clientRef.client.degraded()) {
    return { timer: null, warmup: Promise.resolve({ ok: false, reason: "SUB2API_ADMIN_KEY not configured" }) };
  }
  const warmup = (async () => {
    const ids = typeof modelsProvider === "function" ? await modelsProvider() : [];
    return refreshTurnPricing(ids);
  })();
  const timer = setInterval(() => {
    (async () => {
      const ids = typeof modelsProvider === "function" ? await modelsProvider() : [];
      await refreshTurnPricing(ids, { retryUnpriced: true }); // the periodic window retries absent prices
    })().catch(() => {});
  }, intervalMs);
  timer.unref?.();
  return { timer, warmup };
}
