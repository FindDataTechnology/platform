import { http, type HttpResponse } from "./http";

// extensions-api.ts
// API client for extensions management (MCP servers + custom skills)

const BASE_URL = "/api/extensions";

export interface McpServer {
  id: string;
  name: string;
  type: string;
  config: {
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    // Names of environment variables the host forwards explicitly to a stdio
    // child (credential-shaped names are scrubbed from the ambient env). The
    // VALUES never live here — the host resolves them at patch-write time.
    // The edit form does not model this field; saving must preserve it.
    envRefs?: string[];
    url?: string;
    headers?: Record<string, string>;
    // Registry-origin servers reference the user's stored market credential
    // instead of embedding a secret; the string is always "registry".
    credentialRef?: string;
  };
  enabled: boolean;
  source: "user" | "startup";
  // "bundled" marks servers seeded from platform.bundle.json (websearch et al);
  // their deployment wiring is managed outside this form.
  origin?: "user" | "bundled" | "file" | "registry";
  createdAt: string;
  updatedAt: string;
}

export interface CustomSkill {
  id: string;
  name: string;
  description: string | null;
  content: string;
  enabled: boolean;
  // Auxiliary file PATHS for package-form skills (add-packaged-skills;
  // contents stay server-side). Null/absent for every single-document skill.
  files?: string[] | null;
  originMeta?: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface Skill {
  name: string;
  description: string;
  source: "file" | "database";
  enabled: boolean;
  // add-external-skill-install (刀二): a multi-file / externally-installed
  // skill's auxiliary file paths and provenance, so clients can tell it apart
  // from a locally authored single-file skill. Absent for legacy rows.
  files?: string[];
  originMeta?: Record<string, unknown> | null;
}

export interface MarketMcpServer {
  name: string;
  displayName: string;
  description: string;
  category: string;
  icon: string;
  configTemplate: McpServer["config"];
  installInstructions: string;
  requiresConfig?: boolean;
  origin?: "bundled" | "registry";
  // Tool surface snapshot (add-mcp-tool-scoping): the registry entry's stored
  // tool_list, served so the pack editor's tool picker offers real names;
  // null when the entry predates a snapshot refresh.
  toolList?: string[] | null;
}

export interface MarketSkill {
  name: string;
  displayName: string;
  description: string;
  category: string;
  icon: string;
  // Bundled skills carry inline template content; registry skills have no
  // content up front — installing one fetches it server-side.
  skillTemplate?: {
    description: string;
    content: string;
  };
  origin?: "bundled" | "registry";
}

export interface MarketCatalog {
  mcpServers: MarketMcpServer[];
  skills: MarketSkill[];
}

// ── Registry connection (market credential) ──────────────────────────────────
//
// The token is write-only: every response here carries connection state and
// expiry only, never the credential itself.

export interface RegistryConnection {
  connected: boolean;
  expiresAt: string | null;
  expired: boolean;
  stale: boolean;
  source: string | null;
  updatedAt: string | null;
  // Where the connect popup opens and which mint endpoints it calls ("" URL =
  // the registry source is disabled and only the paste fallback applies).
  registryUrl: string;
  loginPath: string;
  mint: { csrfPath: string; tokensPath: string; csrfHeader: string; defaultTtlHours: number };
}

export async function fetchRegistryConnection(): Promise<RegistryConnection> {
  const res = await http("/api/registry/connection");
  if (!res.ok) throw new Error(`Failed to fetch registry connection: ${res.statusText}`);
  return res.json();
}

// `source` is "sso" for the popup handoff and "paste" for the manual fallback;
// both write the same row server-side.
export async function saveRegistryCredential(
  token: string,
  source: "sso" | "paste" = "sso"
): Promise<RegistryConnection> {
  const res = await http("/api/registry/credential", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, source }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Failed to save the credential: ${res.statusText}`);
  }
  return res.json();
}

export async function disconnectRegistry(): Promise<RegistryConnection> {
  const res = await http("/api/registry/connection", { method: "DELETE" });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Failed to disconnect: ${res.statusText}`);
  }
  return res.json();
}

// ── Connector connection (萬星 connector PAT) ────────────────────────────────
//
// Same write-only contract: the PAT never appears in any response. The paste
// endpoint validates shape (oct_ prefix) and probes the connector once — a 401
// is rejected server-side, so a stored credential here is live or best-effort.

export interface ConnectorConnection {
  connected: boolean;
  stale: boolean;
  active?: boolean;
  slot?: string;
  updatedAt: string | null;
  // Where the "get a PAT" hint sends the user (deployment config, not a
  // secret; null when this deployment's baseline has no connector row).
  connectorUrl: string | null;
  mePath: string;
}

// One connector account row (add-connector-account-picker): token-free and
// patId-free — the browser never sees either.
export interface ConnectorAccount {
  slot: string;
  connected: boolean;
  stale: boolean;
  active: boolean;
  updatedAt: string | null;
}

export async function fetchConnectorConnection(): Promise<ConnectorConnection> {
  const res = await http("/api/connector/connection");
  if (!res.ok) throw new Error(`Failed to fetch connector connection: ${res.statusText}`);
  return res.json();
}

export async function fetchConnectorAccounts(): Promise<{ accounts: ConnectorAccount[]; connectorUrl: string | null; mePath: string }> {
  const res = await http("/api/connector/connections");
  if (!res.ok) throw new Error(`Failed to fetch connector accounts: ${res.statusText}`);
  return res.json();
}

export async function saveConnectorCredential(
  token: string,
  opts: { slot?: string; patId?: string } = {},
): Promise<ConnectorConnection> {
  const res = await http("/api/connector/credential", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, slot: opts.slot, patId: opts.patId }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Failed to save the credential: ${res.statusText}`);
  }
  return res.json();
}

export async function setConnectorActive(slot: string): Promise<ConnectorConnection> {
  const res = await http("/api/connector/connection/active", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ slot }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Failed to switch the active account: ${res.statusText}`);
  }
  return res.json();
}

export async function disconnectConnector(slot?: string): Promise<ConnectorConnection> {
  const res = await http(`/api/connector/connection${slot ? `?slot=${encodeURIComponent(slot)}` : ""}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Failed to disconnect: ${res.statusText}`);
  }
  return res.json();
}

// ── Facet market device credential (facet-market-credentials, C1.1-B) ───────
//
// No terminal token exists to paste: the market's app tokens live 12h. The
// browser only ever submits a 6-digit bind code minted on the facet market's
// settings page; the server owns the Ed25519 device key and mints tokens
// silently. Projections carry state only.

export interface FacetMarketConnection {
  connected: boolean;
  stale: boolean;
  facetAccount: string | null;
  pairedAt: string | null;
  tokenExpiresAt: number | null;
  // Deployment config, not a secret: where the "get a bind code" hint sends
  // the user (the facet market's paired-devices settings page).
  facetUrl: string;
  bindPath: string;
}

export async function fetchFacetMarketConnection(): Promise<FacetMarketConnection> {
  const res = await http("/api/facet-market/connection");
  if (!res.ok) throw new Error(`Failed to fetch facet market connection: ${res.statusText}`);
  return res.json();
}

export async function pairFacetMarket(code: string): Promise<FacetMarketConnection> {
  const res = await http("/api/facet-market/pair", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Failed to pair: ${res.statusText}`);
  }
  return res.json();
}

export async function disconnectFacetMarket(): Promise<FacetMarketConnection> {
  const res = await http("/api/facet-market/connection", { method: "DELETE" });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Failed to disconnect: ${res.statusText}`);
  }
  return res.json();
}

// ── Line operation-MCP credentials (line-credentials) ───────────────────────
// wire-customer / lex: short-lived ID tokens minted silently in the browser;
// wanxing-caller: a pasted long-lived sk- key. Projections carry state only.

export type LineName = "wire-customer" | "lex" | "wanxing-caller";

export interface LineConnection {
  line: LineName;
  connected: boolean;
  stale: boolean;
  expiresAt: number | null;
}

export async function fetchLineConnection(line: LineName): Promise<LineConnection> {
  const res = await http(`/api/lines/${line}/connection`);
  if (!res.ok) throw new Error(`Failed to fetch line connection: ${res.statusText}`);
  return res.json();
}

export async function saveLineCredential(line: LineName, token: string): Promise<LineConnection> {
  const res = await http(`/api/lines/${line}/credential`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Failed to save the credential: ${res.statusText}`);
  }
  return res.json();
}

export async function disconnectLine(line: LineName): Promise<LineConnection> {
  const res = await http(`/api/lines/${line}/connection`, { method: "DELETE" });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Failed to disconnect: ${res.statusText}`);
  }
  return res.json();
}

// ── Paper-trading token (add-paper-trading-credentials) ─────────────────────
//
// A pasted `fdt_` long-lived token minted on the service web — no expiry, no
// pairing protocol, no multi-account dimension. One token per identity; the
// browser submits it once and thereafter only ever reads state (the token
// never returns). Re-pasting replaces the token and recovers a 401-stale row.

export interface PaperTradingConnection {
  connected: boolean;
  stale: boolean;
  updatedAt: string | null;
  // Deployment config, not a secret: where the "get a token" hint sends the
  // user (the service's own web UI).
  serviceUrl: string | null;
}

export async function fetchPaperTradingConnection(): Promise<PaperTradingConnection> {
  const res = await http("/api/paper-trading/connection");
  if (!res.ok) throw new Error(`Failed to fetch paper-trading connection: ${res.statusText}`);
  return res.json();
}

export async function savePaperTradingCredential(token: string): Promise<PaperTradingConnection> {
  const res = await http("/api/paper-trading/connection", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Failed to save paper-trading token: ${res.statusText}`);
  }
  return res.json();
}

export async function disconnectPaperTrading(): Promise<PaperTradingConnection> {
  const res = await http("/api/paper-trading/connection", { method: "DELETE" });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Failed to disconnect: ${res.statusText}`);
  }
  return res.json();
}

// ── MCP Servers ──────────────────────────────────────────────────────────────

export async function fetchMcpServers(): Promise<McpServer[]> {
  const res = await http(`${BASE_URL}/mcp`);
  if (!res.ok) throw new Error(`Failed to fetch MCP servers: ${res.statusText}`);
  const data = await res.json();
  return data.servers || [];
}

export async function addMcpServer(
  name: string,
  config: McpServer["config"],
  enabled = true
): Promise<McpServer> {
  const res = await http(`${BASE_URL}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, config, enabled }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const error = new Error(err.error || `Failed to add MCP server: ${res.statusText}`);
    // Machine-readable reason: the market's registry installs answer
    // "credential-required" when the user has no live market credential, which
    // the Store maps to the connect prompt rather than a raw error.
    if (err.code) (error as Error & { code?: string }).code = err.code;
    throw error;
  }
  return res.json();
}

export async function updateMcpServer(
  name: string,
  config?: McpServer["config"],
  enabled?: boolean
): Promise<McpServer> {
  const res = await http(`${BASE_URL}/mcp/${encodeURIComponent(name)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ config, enabled }),
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error || `Failed to update MCP server: ${res.statusText}`);
  }
  return res.json();
}

export async function removeMcpServer(name: string): Promise<void> {
  const res = await http(`${BASE_URL}/mcp/${encodeURIComponent(name)}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error || `Failed to remove MCP server: ${res.statusText}`);
  }
}

export async function toggleMcpServer(name: string, enabled: boolean): Promise<McpServer> {
  const res = await http(`${BASE_URL}/mcp/${encodeURIComponent(name)}/enable`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled }),
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error || `Failed to toggle MCP server: ${res.statusText}`);
  }
  return res.json();
}

// ── Skills ───────────────────────────────────────────────────────────────────

export async function fetchSkills(): Promise<Skill[]> {
  const res = await http(`${BASE_URL}/skills`);
  if (!res.ok) throw new Error(`Failed to fetch skills: ${res.statusText}`);
  const data = await res.json();
  return data.skills || [];
}

export async function addCustomSkill(
  name: string,
  description: string,
  content: string,
  enabled = true
): Promise<CustomSkill> {
  const res = await http(`${BASE_URL}/skills`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, description, content, enabled }),
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error || `Failed to add skill: ${res.statusText}`);
  }
  return res.json();
}

export async function updateCustomSkill(
  name: string,
  description?: string,
  content?: string,
  enabled?: boolean
): Promise<CustomSkill> {
  const res = await http(`${BASE_URL}/skills/${encodeURIComponent(name)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ description, content, enabled }),
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error || `Failed to update skill: ${res.statusText}`);
  }
  return res.json();
}

export async function removeCustomSkill(name: string): Promise<void> {
  const res = await http(`${BASE_URL}/skills/${encodeURIComponent(name)}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error || `Failed to remove skill: ${res.statusText}`);
  }
}

export async function toggleCustomSkill(name: string, enabled: boolean): Promise<CustomSkill> {
  const res = await http(`${BASE_URL}/skills/${encodeURIComponent(name)}/enable`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled }),
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error || `Failed to toggle skill: ${res.statusText}`);
  }
  return res.json();
}

// ── Skill package upload (add-packaged-skills D7) ───────────────────────────
// A zip package travels through the same multipart channel both ways: preview
// describes what WOULD install (nothing stored), install writes it. The
// script-consent checkbox is enforced server-side (confirm field).

export interface SkillPackageFile {
  path: string;
  bytes: number;
  script: boolean;
  action: "stored" | "omitted-binary" | "omitted-large";
}

export interface SkillPackagePreview {
  name: string;
  upstreamName: string;
  description: string;
  bodyExcerpt: string;
  hasScripts: boolean;
  storedFileCount: number;
  files: SkillPackageFile[];
}

export interface SkillPackageInstallResult {
  skill: { name: string; description: string | null; fileCount: number; originMeta: Record<string, unknown> | null };
  replaced: boolean;
}

async function postSkillPackage(
  file: File,
  mode: "preview" | "install" | "seed",
  fields: Record<string, string> = {},
): Promise<HttpResponse> {
  const fd = new FormData();
  fd.append("file", file);
  fd.append("mode", mode);
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return http(`${BASE_URL}/skills`, { method: "POST", body: fd });
}

async function packageError(res: HttpResponse, fallback: string): Promise<Error> {
  const err = await res.json().catch(() => ({}));
  return Object.assign(new Error(err.error || `${fallback}: ${res.statusText}`), {
    code: err.code ?? null,
    details: err.details ?? null,
  });
}

export async function previewSkillPackage(
  file: File,
  fields: { name?: string; description?: string } = {},
): Promise<SkillPackagePreview> {
  const res = await postSkillPackage(file, "preview", {
    name: fields.name ?? "",
    description: fields.description ?? "",
  });
  if (!res.ok) throw await packageError(res, "Upload preview failed");
  const doc = (await res.json()) as { preview: SkillPackagePreview };
  return doc.preview;
}

export async function installSkillPackage(
  file: File,
  fields: { name?: string; description?: string; confirm?: boolean } = {},
): Promise<SkillPackageInstallResult> {
  const res = await postSkillPackage(file, "install", {
    name: fields.name ?? "",
    description: fields.description ?? "",
    ...(fields.confirm ? { confirm: "true" } : {}),
  });
  if (!res.ok) throw await packageError(res, "Package upload failed");
  return (await res.json()) as SkillPackageInstallResult;
}

export interface SkillPackageSeed {
  name: string;
  upstreamName: string;
  description: string;
  content: string;
  files: Record<string, string> | null;
  frontmatter: Record<string, unknown> | null;
}

// The pack editor's direct-upload path (add-packaged-skills 4.4): returns the
// FULL parsed package — a draft skill entry carries the whole tree into the
// published manifest. The caller uploaded the zip themselves.
export async function seedSkillPackage(file: File): Promise<SkillPackageSeed> {
  const res = await postSkillPackage(file, "seed");
  if (!res.ok) throw await packageError(res, "Package upload failed");
  const doc = (await res.json()) as { seed: SkillPackageSeed };
  return doc.seed;
}

// ── Market Catalog ───────────────────────────────────────────────────────────

export async function fetchMarketCatalog(): Promise<MarketCatalog> {
  const res = await http(`${BASE_URL}/market`);
  if (!res.ok) throw new Error(`Failed to fetch market catalog: ${res.statusText}`);
  return res.json();
}

// Registry-sourced skills install server-side: the backend fetches the
// skill's SKILL.md with the service token and creates the custom skill.
export async function installRegistrySkill(name: string): Promise<void> {
  const res = await http(`${BASE_URL}/market/skills/${encodeURIComponent(name)}/install`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Failed to install skill: ${res.statusText}`);
  }
}

// ── External skill sources (add-external-skill-sources 刀一, read-only) ──────

export interface ExternalSourceInfo {
  id: string;
  displayName: string;
}

export type ExternalLicenseState = "declared" | "not-declared" | "unknown";

export interface ExternalSkillEntry {
  source: string;
  id: string;
  name: string;
  displayName: string;
  description: string;
  originUrl: string | null;
  licenseState: ExternalLicenseState;
  licenseText: string | null;
  version: string | null;
  versionLayer: string | null;
  downloads: number | null;
  stars: number | null;
  tags: string[];
  extras: Record<string, unknown> | null;
}

export interface ExternalSourceGroup {
  source: string;
  sourceDisplayName: string;
  entries: ExternalSkillEntry[];
  stale: boolean;
  snapshotAt: number | null;
  error: string | null;
  failed: string | null;
}

export async function fetchExternalSources(): Promise<ExternalSourceInfo[]> {
  const res = await http(`${BASE_URL}/external/sources`);
  if (!res.ok) throw new Error(`Failed to list external sources: ${res.statusText}`);
  const doc = (await res.json()) as { sources: ExternalSourceInfo[] };
  return doc.sources ?? [];
}

export async function searchExternalSkills(
  query: string,
): Promise<{ query: string; groups: ExternalSourceGroup[] }> {
  const res = await http(`${BASE_URL}/external/search?q=${encodeURIComponent(query)}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `External search failed: ${res.statusText}`);
  }
  return (await res.json()) as { query: string; groups: ExternalSourceGroup[] };
}

export async function fetchExternalEntry(
  source: string,
  slug: string,
): Promise<{ entry: ExternalSkillEntry; stale: boolean; snapshotAt: number | null }> {
  const res = await http(
    `${BASE_URL}/external/entry/${encodeURIComponent(source)}/${encodeURIComponent(slug)}`,
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `External entry fetch failed: ${res.statusText}`);
  }
  return (await res.json()) as { entry: ExternalSkillEntry; stale: boolean; snapshotAt: number | null };
}

// ── External install (add-external-skill-install 刀二) ──────────────────────
// The preview is the consent panel's data source; the install call always
// carries confirm:true — the SERVER refuses anything else, this flag is just
// the client stating what the user did.

export interface ExternalInstallFile {
  path: string;
  bytes: number;
  script: boolean;
  action: "stored" | "omitted-binary" | "omitted-large";
}

export interface ExternalInstallPreview {
  source: string;
  slug: string;
  normalizedName: string | null;
  upstreamName: string;
  displayName: string;
  originUrl: string | null;
  version: string | null;
  licenseState: "declared" | "not-declared" | "unknown";
  licenseText: string | null;
  bodyExcerpt: string;
  hasScripts: boolean;
  files: ExternalInstallFile[];
}

export async function previewExternalInstall(
  source: string,
  slug: string,
): Promise<ExternalInstallPreview> {
  const res = await http(
    `${BASE_URL}/external/install-preview/${encodeURIComponent(source)}/${encodeURIComponent(slug)}`,
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Install preview failed: ${res.statusText}`);
  }
  const doc = (await res.json()) as { preview: ExternalInstallPreview };
  return doc.preview;
}

export async function installExternalSkill(
  source: string,
  slug: string,
): Promise<{ skill: { name: string; description: string; originMeta: Record<string, unknown> | null }; replaced: boolean }> {
  const res = await http(`${BASE_URL}/external/install`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ source, slug, confirm: true }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Install failed: ${res.statusText}`);
  }
  return (await res.json()) as { skill: { name: string; description: string; originMeta: Record<string, unknown> | null }; replaced: boolean };
}
