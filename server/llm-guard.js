// Default-lane guard (add-editable-llm-route, design D5).
//
// A dark default model plus the boot-time re-anchor (writeLlmProfile resolves
// the active model from the default pointer) leaves every new session failing
// its first turn — the 2026-10-01 outage class. The guard verifies the default
// actually serves before the platform relies on it: one minimal chat
// completion, classified with the sync taxonomy. A definitive dark answer
// (the gateway's model_not_found / not-supported-in-group class) switches the
// default to the first known-serving model (last sync classification,
// ctx.dshModels order) and broadcasts `model_fallback`. Network errors and
// timeouts never move the default — a flapping gateway must not silently
// rewire the deployment.

export const GUARD_TIMEOUT_MS = 10_000;

// Resolve { baseUrl, apiKey } for a provider route, or null when the route has
// no usable key (nothing to probe with).
async function resolveRouteCredentials(providerId) {
  const llmProviders = await import("../llm-providers.js");
  if (providerId === "volces") {
    const apiKey = process.env.LLM_API_KEY?.trim();
    if (!apiKey) return null;
    const dshProfile = await import("../dsh-profile.js");
    const { baseURL } = await dshProfile.effectiveVolcesRoute();
    return { baseUrl: baseURL, apiKey };
  }
  const record = llmProviders.getProviderRecord(providerId);
  if (!record?.apiKey) return null;
  return { baseUrl: record.baseUrl, apiKey: record.apiKey };
}

// Last-sync classification for a model id, from wherever its provider persists
// the discovery map (the reserved route: the override doc; user routes: the
// provider record). null when no sync has ever classified it.
async function discoveryStatusFor(model) {
  const llmProviders = await import("../llm-providers.js");
  if (model.provider === "volces") {
    return llmProviders.getVolcesOverride()?.discovery?.[model.id]?.status || null;
  }
  return llmProviders.getProviderRecord(model.provider)?.discovery?.[model.id]?.status || null;
}

async function probeOnce(baseUrl, apiKey, modelId, { fetchImpl = global.fetch, timeoutMs = GUARD_TIMEOUT_MS }) {
  const url = String(baseUrl).replace(/\/+$/, "") + "/chat/completions";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: "user", content: "只回复ok" }],
        max_tokens: 1,
        stream: false,
      }),
      signal: controller.signal,
    });
    let body = "";
    try { body = await res.text(); } catch { /* ignore */ }
    const { classifyResponse } = await import("../llm-providers.js");
    return classifyResponse(res.status, body, apiKey);
  } catch (err) {
    const msg = err?.name === "AbortError" ? `probe timed out after ${timeoutMs / 1000}s` : err?.message || "request failed";
    return { status: "network_error", error: msg };
  } finally {
    clearTimeout(timer);
  }
}

// The only probe result class that may move the default: a definitive
// "this lane does not serve" answer (`unauthorized` covers the gateway's
// model_not_found / not-supported-by-any-account body).
function isDefinitivelyDark(result) {
  return result?.status === "unauthorized";
}

// First model known to be serving per the most recent sync classification, in
// ctx.dshModels (family-rank) order. Returns null when no sync has ever run —
// the guard then keeps the configured default (surfaced, never silently
// re-pointed at an unverified model).
async function firstServingModel(ctx, skipId) {
  for (const m of ctx.dshModels || []) {
    if (m.id === skipId) continue;
    if ((await discoveryStatusFor(m)) === "serving") return m;
  }
  return null;
}

// Probe the current default; on a definitive dark answer switch to the first
// known-serving model. Returns the outcome for callers that log or surface it.
// Never throws — a guard failure is information, not an error path.
export async function guardDefaultLane(ctx, { reason, fetchImpl = global.fetch } = {}) {
  const target = ctx.defaultModel || (ctx.dshModels || [])[0];
  if (!target) return { action: "noop", reason: "no default model" };
  const creds = await resolveRouteCredentials(target.provider);
  if (!creds) return { action: "noop", reason: "no route credentials" };

  const result = await probeOnce(creds.baseUrl, creds.apiKey, target.id, { fetchImpl });
  if (!isDefinitivelyDark(result)) {
    if (result?.status !== "serving") {
      console.warn(
        `[llm-guard] default probe inconclusive (${result.status}): ${result.error || "no detail"} — keeping ${target.id}`
      );
    }
    return { action: "kept", probe: result.status };
  }

  const fallback = await firstServingModel(ctx, target.id);
  if (!fallback) {
    console.warn(
      `[llm-guard] default ${target.id} is dark and no serving fallback is known — keeping it surfaced`
    );
    return { action: "kept", probe: result.status, noFallback: true };
  }

  try {
    const llmProviders = await import("../llm-providers.js");
    llmProviders.setDefault({ providerId: fallback.provider, modelId: fallback.id });
  } catch (err) {
    console.error(`[llm-guard] could not persist fallback default: ${err.message}`);
    return { action: "kept", probe: result.status, persistFailed: true };
  }
  const previous = target.id;
  ctx.defaultModel = { id: fallback.id, provider: fallback.provider, name: fallback.name || fallback.id };
  ctx.broadcast?.({ type: "model_fallback", from: previous, to: fallback.id, reason: reason || "probe" });
  console.warn(`[llm-guard] default lane ${previous} is dark (${result.status}) — fell back to ${fallback.id}`);
  return { action: "fell_back", from: previous, to: fallback.id, probe: result.status };
}
