// packs-api.ts — typed client for the pack marketplace's two API planes
// (add-pack-marketplace):
//   - the GATEWAY's marketplace (/api/packs...): browse, detail, publish,
//     subscribe records — same-origin through the deployment's ingress;
//   - the CELL's local state (/api/mypacks..., /api/pack-drafts...): installed
//     packs, materialization, and creator drafts.
// The subscribe flow records on the market, then hands {packId, version} to
// the cell; the cell fetches the manifest server-side
// (pack-install-server-side-manifest — the browser never carries manifest
// bodies, which the edge WAF rejects).

export interface PackSummary {
  id: string;
  authorEmail: string;
  createdAt: number;
  version: number;
  name: string;
  description: string;
  tags: string[];
  publishedAt: number;
  subscriberCount?: number;
  visibility?: "public" | "private";
}

export interface PackManifestSkill {
  name: string;
  description: string;
  content: string;
}

export interface PackManifestMcp {
  registryName: string;
  requiredGroup?: string;
}

export interface PackManifestAgent {
  id: string;
  name: string;
  persona: string;
  // Optional serving contract (add-a2a-agent-serving): present ⇒ the role is
  // deployable as an Agent Service over A2A.
  serving?: { protocol: string; card?: Record<string, unknown>; rhythm?: { every?: string; daily?: string; do?: string }[] };
  tags?: string[];
  icon?: string;
  // Optional per-role resource declaration (add-persona-resource-sets): a
  // subset of the draft's OWN skills / MCP references. Absent dimension =
  // whole-pack set for it; present-but-empty = none.
  resources?: { skills?: string[]; mcpServers?: string[] };
}

export interface PackManifest {
  name: string;
  visibility?: "public" | "private";
  description?: string;
  tags?: string[];
  skills?: PackManifestSkill[];
  mcpServers?: PackManifestMcp[];
  agents?: PackManifestAgent[];
}

export interface PackDetail extends PackSummary {
  manifest: PackManifest;
}

export type PackPartStatus = "installed" | "reused" | "replaced" | "skipped" | "unavailable";

export interface PackReport {
  skills: { name: string; status: PackPartStatus; reason?: string }[];
  mcpServers: { name: string; status: PackPartStatus; reason?: string; code?: string }[];
  agents: { id: string; name: string; status: PackPartStatus; reason?: string }[];
}

export interface InstalledPack {
  packId: string;
  name: string;
  version: number;
  manifest: PackManifest;
  report: PackReport;
  installedAt: string;
  updatedAt: string;
}

export interface PackDraft {
  id: string;
  name: string;
  description: string;
  tags: string[];
  entries: {
    skills?: PackManifestSkill[];
    mcpServers?: PackManifestMcp[];
    agents?: PackManifestAgent[];
  };
  publishedPackId: string | null;
  createdAt: string;
  updatedAt: string;
}

async function json(res: Response) {
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const detail = body?.details?.[0]?.error || body?.error || `${res.status}`;
    const err = new Error(detail) as Error & { status?: number; body?: unknown };
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

// ── Gateway (marketplace) ────────────────────────────────────────────────────

export function listPacks(params: { search?: string; tag?: string; page?: number } = {}) {
  const q = new URLSearchParams();
  if (params.search) q.set("search", params.search);
  if (params.tag) q.set("tag", params.tag);
  if (params.page) q.set("page", String(params.page));
  return fetch(`/api/packs?${q}`).then(json) as Promise<{
    total: number;
    page: number;
    pageSize: number;
    packs: PackSummary[];
  }>;
}

export function getPack(id: string) {
  return fetch(`/api/packs/${encodeURIComponent(id)}`).then(json) as Promise<PackDetail>;
}

// Deploy the version's serving-contract roles as Agent Services
// (add-a2a-agent-serving 3.2): skills + one a2a agent entry land in the
// registry; the runner picks the bundle up by polling (≤ effectiveWithinSecs).
export interface DeployResult {
  deployed: { agentId: string; agentPath: string; skills: string[] }[];
  effectiveWithinSecs: number;
}

export interface PackDeployment {
  agentId: string;
  version: number;
  agentPath: string;
  skills: string[];
  deployedBy: string;
  deployedAt: number;
  paused?: boolean;
}

// Billing reads (add-agent-platform-ops D3; revised by
// revise-billing-key-acquisition): the deploy surface's three-state readout —
// accountState "none" = no sub2api account yet (SSO at panelUrl creates it),
// "ok" = resolved (balance meaningful), null = billing unlinked (degraded).
export interface MyBillingState {
  linked: boolean;
  balance: number | null;
  accountState: "none" | "ok" | null;
  panelUrl?: string;
}

export function myBillingState(): Promise<MyBillingState> {
  return fetch("/api/packs/billing/me").then(json) as Promise<MyBillingState>;
}

// Per-pack key binding state: serving agentId → whether a key is bound.
// Booleans only — key values never leave the platform.
export function getBillingBindings(id: string): Promise<Record<string, boolean>> {
  return fetch(`/api/packs/${encodeURIComponent(id)}/billing-bindings`).then(json) as Promise<Record<string, boolean>>;
}

// Deploy with optional per-agent rhythm overrides (add-agent-residency D7):
// rhythms maps agentId → entry list; the descriptor records the override as
// the effective rhythm, the manifest default otherwise. billingKeys maps
// serving agentId → a pasted panel key ("sk-…"); omitting the field keeps
// existing bindings (the platform never echoes key values back).
export function deployPack(
  id: string,
  version: number,
  rhythms?: Record<string, unknown>,
  billingKeys?: Record<string, string | null>,
) {
  const body: Record<string, unknown> = {};
  if (rhythms && Object.keys(rhythms).length > 0) body.rhythms = rhythms;
  if (billingKeys && Object.keys(billingKeys).length > 0) body.billingKeys = billingKeys;
  return fetch(`/api/packs/${encodeURIComponent(id)}/versions/${version}/deploy`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).then(json) as Promise<DeployResult>;
}

// Pause/resume a deployed agent (add-agent-residency D5): the registry flag
// the runner polls; effective within the same five-minute window as deploy.
export function pauseDeployment(packId: string, agentId: string, paused: boolean) {
  return fetch(
    `/api/packs/${encodeURIComponent(packId)}/deployments/${encodeURIComponent(agentId)}/${paused ? "pause" : "resume"}`,
    { method: "POST" },
  ).then(json) as Promise<{ agentPath: string; paused: boolean; effectiveWithinSecs: number }>;
}

export function getPackDeployments(id: string) {
  return fetch(`/api/packs/${encodeURIComponent(id)}/deployments`).then(json) as Promise<{
    deployments: PackDeployment[];
  }>;
}

export function publishPack(body: { packId?: string | null; manifest: PackManifest }) {
  return fetch("/api/packs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then(json) as Promise<{ id: string; version: number }>;
}

export function subscribePack(id: string) {
  return fetch(`/api/packs/${encodeURIComponent(id)}/subscribe`, { method: "POST" }).then(
    json,
  ) as Promise<{ packId: string; version: number; manifest: PackManifest }>;
}

export function unsubscribePackRecord(id: string) {
  return fetch(`/api/packs/${encodeURIComponent(id)}/subscribe`, { method: "DELETE" }).then(json);
}

// ── Cell (installed state + materialization) ─────────────────────────────────

export function listInstalledPacks() {
  return fetch("/api/mypacks").then(json) as Promise<{ packs: InstalledPack[] }>;
}

// Install = materialize the version into this cell. Only {packId, version}
// crosses the wire (pack-install-server-side-manifest): the server retrieves
// the manifest from the market under the caller's identity. Manifest bodies
// must not ride browser POSTs — pack skills legally embed code/SQL and the
// deployment edge WAF resets such requests.
export function installPack(packId: string, version: number) {
  return fetch("/api/mypacks/install", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ packId, version }),
  }).then(json) as Promise<{ report: PackReport; installed: InstalledPack }>;
}

export function uninstallPreview(packId: string) {
  return fetch(`/api/mypacks/${encodeURIComponent(packId)}/uninstall-preview`).then(json) as Promise<{
    packId: string;
    name: string;
    version: number;
    skills: string[];
    modifiedSkills: string[];
    agents: { id: string; name: string }[];
    mcpServersKept: string[];
  }>;
}

export function uninstallPack(packId: string, force: boolean) {
  return fetch(`/api/mypacks/${encodeURIComponent(packId)}?force=${force ? "1" : "0"}`, {
    method: "DELETE",
  }).then(json);
}

// ── Drafts (creator side, cell-local) ────────────────────────────────────────

export function listPackDrafts() {
  return fetch("/api/pack-drafts").then(json) as Promise<{ drafts: PackDraft[] }>;
}

export function createPackDraft(body: Partial<PackDraft>) {
  return fetch("/api/pack-drafts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then(json) as Promise<{ draft: PackDraft }>;
}

export function updatePackDraft(id: string, patch: Partial<PackDraft>) {
  return fetch(`/api/pack-drafts/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  }).then(json) as Promise<{ draft: PackDraft }>;
}

export function deletePackDraft(id: string) {
  return fetch(`/api/pack-drafts/${encodeURIComponent(id)}`, { method: "DELETE" }).then(json);
}

export function markDraftPublished(id: string, packId: string) {
  return fetch(`/api/pack-drafts/${encodeURIComponent(id)}/published`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ packId }),
  }).then(json) as Promise<{ draft: PackDraft }>;
}
