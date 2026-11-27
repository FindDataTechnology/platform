// ── LLM lane breaker (fix-fleet-turn-attribution D2/D3; streak semantics
//    fix-llm-breaker-streak D1/D2) ───────────────────────────────────────────
//
// A "lane" is the provider endpoint + credential a turn actually runs on. The
// breaker is keyed by the lane's stable id — NOT by cell, NOT by fleet —
// because the failure domain is the lane: when the upstream 5xxes, every turn
// resolved onto that lane hits the same wall, and only those. Today every
// model in a cell resolves to the same provider, so one lane ≈ the cell; the
// moment per-agent keys/baseURLs land (buildUserProviderEntries already
// supports them), each lane gets its own breaker with zero semantic change.
//
// The id is a fingerprint: sha256 over `providerId|baseURL|apiKey`, truncated.
// Secret material only ever feeds the hash — logs, turn events and the UI see
// the prefix and the baseURL, never the key. Key rotation on the same endpoint
// deliberately does NOT reset the breaker: what is broken is the endpoint, and
// the window self-heals in minutes anyway.
//
// The count is a CONSECUTIVE-FAILURE STREAK (fix-llm-breaker-streak): every
// upstream-class failure on the lane increments, and any success resets to
// zero. There is deliberately NO wall-clock window — unattended fleet rounds
// fire at ≥15-minute-staggered cadences (typically hourly), so a fixed window
// can never both accumulate a threshold and catch the next round in its
// cool-off. The 10-28→11-04 upstream storm (94 model_upstream failures, 0
// skipped) is the proof: a 5-in-10-min sliding window structurally cannot fire
// against that pacing. `skipped` rounds never feed the streak (the seam
// records nothing for a skip) — the only exit from an open window is the
// first real round after the cool-off expires (the half-open probe).
//
// State is a plain in-process Map. A restart clears it — acceptable: the
// breaker is a protective transient, and a persisting outage refills the
// streak within threshold rounds of resuming (fix-llm-breaker-streak D5).

import { createHash } from "node:crypto";

export function laneKeyFor(provider) {
  const material = `${provider?.id ?? ""}|${provider?.baseURL ?? provider?.baseUrl ?? ""}|${provider?.apiKey ?? ""}`;
  return `lane-${createHash("sha256").update(material).digest("hex").slice(0, 16)}`;
}

const DEFAULT_THRESHOLD = 5;
const DEFAULT_OPEN_MS = 2 * 60 * 60 * 1000;

function num(name, fallback) {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

export function breakerConfig() {
  return {
    enabled: process.env.PLATFORM_LLM_BREAKER !== "0",
    threshold: num("PLATFORM_LLM_BREAKER_THRESHOLD", DEFAULT_THRESHOLD),
    openMs: num("PLATFORM_LLM_BREAKER_OPEN_MS", DEFAULT_OPEN_MS),
  };
}

const lanes = new Map(); // laneId -> { streak: number, openUntil: number|null }

function stateOf(laneId) {
  let s = lanes.get(laneId);
  if (!s) {
    s = { streak: 0, openUntil: null };
    lanes.set(laneId, s);
  }
  return s;
}

// One upstream-class failure against this lane. Returns the state after
// recording — the caller logs it; this module never logs by itself so tests
// and callers stay in charge of noise. A failure at/above the threshold opens
// the cool-off; while already open, a probe failure (the seam records nothing
// for skipped rounds) ROLLS openUntil forward rather than requoting the
// threshold — the streak never fell below it in between.
export function recordUpstreamFailure(laneId, now = Date.now()) {
  const cfg = breakerConfig();
  const s = stateOf(laneId);
  if (!cfg.enabled) return { open: false, streak: 0, openUntil: null, enabled: false };
  s.streak += 1;
  if (s.streak >= cfg.threshold) {
    s.openUntil = now + cfg.openMs;
  }
  return { open: Boolean(s.openUntil && s.openUntil > now), openUntil: s.openUntil, streak: s.streak, threshold: cfg.threshold };
}

// Any successful call against the lane proves it works again — close
// immediately and reset the streak (the half-open probe IS this success).
export function recordUpstreamSuccess(laneId) {
  const s = stateOf(laneId);
  s.streak = 0;
  s.openUntil = null;
  return { open: false, streak: 0, openUntil: null };
}

export function breakerState(laneId, now = Date.now()) {
  const cfg = breakerConfig();
  const s = stateOf(laneId);
  const open = cfg.enabled && Boolean(s.openUntil && s.openUntil > now);
  return { open, openUntil: open ? s.openUntil : null, streak: s.streak, threshold: cfg.threshold, enabled: cfg.enabled };
}

// Model → lane lookup, built once at boot from the llm profile (D2):
  // `models[].provider` names the route, `providers[id]` carries its baseURL.
  // The volces route's key rides pod env (LLM_API_KEY) and feeds the
  // fingerprint; user-route keys live in .credentials.yaml, not env — those
  // lanes fingerprint on providerId|baseURL alone (endpoint-level identity;
  // key rotation there does not need to reset the breaker). An unknown model
  // reads null → the seam records nothing (honest absence, never a guess).
  export function buildLaneLookup(providers, models) {
    const laneByProvider = new Map();
    const providerByModel = new Map();
    for (const [id, p] of Object.entries(providers ?? {})) {
      const apiKey = p?.apiKeyEnv === "LLM_API_KEY" ? process.env.LLM_API_KEY?.trim() || "" : "";
      laneByProvider.set(id, laneKeyFor({ id, baseURL: p?.baseURL, apiKey }));
    }
    for (const m of models ?? []) {
      if (m?.id && m?.provider) providerByModel.set(m.id, m.provider);
    }
    return (modelId) => {
      const provider = providerByModel.get(modelId);
      return provider ? laneByProvider.get(provider) ?? null : null;
    };
  }

// Test hook — clears all lanes between tests.
export function resetLanes() {
  lanes.clear();
}
