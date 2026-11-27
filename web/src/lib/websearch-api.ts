// Thin client for the Network-search settings endpoints
// (add-websearch-settings; per-user BYOK added by add-search-byok). Mirrors
// the overlay-api style: one function per endpoint, `json`-shaped errors
// surfaced as Error(message). Key/token VALUES never come back — only
// presence + a 4-char hint.

export interface WebsearchConfig {
  url: string;
  hasToken: boolean;
  tokenHint: string | null;
  source: { url: "stored" | "env" | null; token: "stored" | "env" | null };
}

export interface WebsearchUserKey {
  hasKey: boolean;
  keyHint: string | null;
}

export interface WebsearchPoolStatus {
  configured: boolean;
  reachable?: boolean;
  detail?: string;
  day?: string;
  dailyCap?: number;
  // Upstream: the platform gateway websearch lane ("ciyuan") is the only
  // supply — the direct cold-standby path was retired (retire-search-relay-
  // direct), so mode is constant and per-key cooldown views no longer exist.
  upstream?: {
    mode: "ciyuan";
    laneConfigured: boolean;
    reachable: boolean | null;
    breakerOpen: boolean;
    laneCalls: number;
    laneFailures: number;
  } | null;
  overrides?: { used: number; failed: number; fallback: number } | null;
  errors?: { client: number; upstream: number } | null;
  uptimeSec?: number | null;
}

export type WebsearchTestState = "ok" | "auth-rejected" | "upstream-degraded" | "unreachable" | "invalid-url";

export interface WebsearchTestResult {
  state: WebsearchTestState;
  detail?: string;
  // Which credential served the probe: user / pool / pool-after-user-failure.
  source?: "user" | "pool" | "pool-after-user-failure";
}

async function jsonOrThrow(res: Response) {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
  return body;
}

export function fetchWebsearchConfig(): Promise<WebsearchConfig> {
  return fetch("/api/config/websearch", { credentials: "same-origin" }).then(jsonOrThrow);
}

// Body semantics: absent field = untouched, "" = clear (fall back to env),
// non-empty = store. The token VALUE never comes back — only hint + presence.
export function saveWebsearchConfig(body: { url?: string; token?: string }): Promise<WebsearchConfig & { ok: true }> {
  return fetch("/api/config/websearch", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify(body),
  }).then(jsonOrThrow);
}

// The caller's OWN search key (BYOK). Same three-state semantics; identity
// comes from the session, so this can only ever touch the caller's own row.
export function fetchUserKey(): Promise<WebsearchUserKey> {
  return fetch("/api/config/websearch/userkey", { credentials: "same-origin" }).then(jsonOrThrow);
}

export function saveUserKey(body: { key?: string }): Promise<WebsearchUserKey & { ok: true }> {
  return fetch("/api/config/websearch/userkey", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify(body),
  }).then(jsonOrThrow);
}

// Admin-only shared-pool health (proxied relay stats, secret-free).
export function fetchPoolStatus(): Promise<WebsearchPoolStatus> {
  return fetch("/api/config/websearch/pool", { credentials: "same-origin" }).then(jsonOrThrow);
}

// Dry-run connectivity probe; form values (when given) are used for THIS
// request only and never persisted. `userKey` exercises the BYOK path.
export function testWebsearchRelay(input: { url?: string; token?: string; userKey?: string }): Promise<WebsearchTestResult> {
  return fetch("/api/config/websearch/test", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify(input),
  }).then(jsonOrThrow);
}
