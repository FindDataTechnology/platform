import { http, type HttpResponse } from "./http";

// Client for the /api/llm/* endpoints (Models page). Types mirror the
// server records in llm-providers.js. The API key never appears here — the
// server exposes only `hasKey: boolean`.

export interface LastTest {
  ok: boolean;
  latencyMs: number;
  error?: string;
  at?: string;
}

// Per-id status from the last model sync (add-llm-model-discovery).
export type DiscoveryStatusKind =
  | "serving"
  | "unauthorized"
  | "upstream_down"
  | "rate_limited"
  | "not_chat"
  | "error";

export interface DiscoveryStatus {
  status: DiscoveryStatusKind;
  // Sanitized probe message (no key material, bounded length).
  error?: string;
  probedAt?: string;
}

export interface LlmProvider {
  id: string;
  name: string;
  baseUrl: string;
  type: string;
  hasKey: boolean;
  reserved?: boolean;
  models: string[];
  // Thinking levels this provider's models accept (identity wire values).
  reasoningEfforts?: string[];
  lastTest: LastTest | null;
  // Last sync's per-id status map; null before any sync.
  discovery?: Record<string, DiscoveryStatus> | null;
  // Reserved env route only (add-editable-llm-route): the persisted operator
  // override state. `active` false = the env/baked projection is in effect.
  override?: {
    active: boolean;
    baseUrl?: string;
    rosterSize: number;
  };
}

// Result of POST /api/llm/providers/:id/sync (add-editable-llm-route: the
// reserved env route persists into its override, so one shape covers all
// providers). `added` lists the ids merged this run.
export interface SyncResult {
  statuses: Record<string, DiscoveryStatus>;
  added?: string[];
  rosterSize: number;
}

// A roster entry in a PUT /api/llm/providers/:id models array. Absent fields
// fall back to the server's family table, then conservative defaults.
export interface ModelEntryInput {
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
}

// Client-side mirror of the server family table (llm-providers.js) for editor
// prefill only — the server is authoritative on save.
const CLIENT_MODEL_FAMILIES: Array<{
  prefix: string;
  rank: number;
  maxTokens?: number;
  reasoningEfforts?: string[];
}> = [
  { prefix: "deepseek-v4", rank: 0, maxTokens: 32768, reasoningEfforts: ["low", "medium", "high"] },
  { prefix: "deepseek", rank: 0, maxTokens: 32768 },
  { prefix: "glm-5.3-flash", rank: 1, maxTokens: 32768 },
  { prefix: "glm", rank: 1 },
  { prefix: "mimo", rank: 2 },
];

export const CLIENT_MODEL_FAMILY_DEFAULTS = Object.freeze({
  contextWindow: 128000,
  maxTokens: 8192,
});

export function clientModelFamilyMeta(id: string) {
  const bare = id.split("/").pop() ?? id;
  const family = CLIENT_MODEL_FAMILIES.find((f) => bare.startsWith(f.prefix));
  return {
    contextWindow: CLIENT_MODEL_FAMILY_DEFAULTS.contextWindow,
    maxTokens: family?.maxTokens ?? CLIENT_MODEL_FAMILY_DEFAULTS.maxTokens,
    reasoningEfforts: family?.reasoningEfforts ?? [],
  };
}

export interface LlmDefault {
  providerId: string | null;
  modelId: string | null;
  activeModelId: string | null;
}

async function jsonOrThrow(res: HttpResponse) {
  if (!res.ok) {
    let message = res.statusText;
    try {
      const body = await res.json();
      if (body?.error) message = body.error;
    } catch { /* ignore */ }
    const err = new Error(message) as Error & { status?: number; code?: string };
    err.status = res.status;
    throw err;
  }
  return res.json();
}

export async function listProviders(): Promise<LlmProvider[]> {
  const r = await http("/api/llm/providers");
  const body = await jsonOrThrow(r);
  return body.providers ?? [];
}

export async function createProvider(input: {
  name: string;
  baseUrl: string;
  apiKey: string;
  reasoningEfforts?: string;
}): Promise<LlmProvider> {
  const r = await http("/api/llm/providers", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = await jsonOrThrow(r);
  return body.provider;
}

// On the reserved env route the server accepts only `baseUrl`/`models` (the
// key is env-owned); other fields are rejected server-side.
export async function updateProvider(
  id: string,
  input: {
    name?: string;
    baseUrl?: string;
    apiKey?: string;
    reasoningEfforts?: string;
    models?: ModelEntryInput[];
  },
): Promise<LlmProvider> {
  const r = await http(`/api/llm/providers/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = await jsonOrThrow(r);
  return body.provider;
}

// Reconcile a provider's roster against its gateway (admin). One long-lived
// request (~25–60s for a 33-id gateway); the reserved env route persists into
// its override (add-editable-llm-route).
export async function syncProvider(id: string): Promise<SyncResult> {
  const r = await http(`/api/llm/providers/${encodeURIComponent(id)}/sync`, {
    method: "POST",
  });
  return jsonOrThrow(r);
}

// Clear the reserved route's override — the rollback to the env/baked
// projection (add-editable-llm-route).
export async function clearOverride(id: string): Promise<void> {
  const r = await http(`/api/llm/providers/${encodeURIComponent(id)}/clear-override`, {
    method: "POST",
  });
  await jsonOrThrow(r);
}

export async function deleteProvider(id: string): Promise<void> {
  const r = await http(`/api/llm/providers/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  await jsonOrThrow(r);
}

export async function testProvider(id: string): Promise<LastTest & { ok: boolean }> {
  const r = await http(`/api/llm/providers/${encodeURIComponent(id)}/test`, {
    method: "POST",
  });
  return jsonOrThrow(r);
}

export async function getDefault(): Promise<LlmDefault> {
  const r = await http("/api/llm/default");
  return jsonOrThrow(r);
}

export async function setDefault(modelId: string, providerId: string): Promise<LlmDefault> {
  const r = await http("/api/llm/default", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ modelId, providerId }),
  });
  return jsonOrThrow(r);
}
