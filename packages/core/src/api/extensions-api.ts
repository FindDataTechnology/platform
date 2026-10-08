import { http } from "./http";

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
    url?: string;
    headers?: Record<string, string>;
    // Registry-origin servers reference the user's stored market credential
    // instead of embedding a secret; the string is always "registry".
    credentialRef?: string;
  };
  enabled: boolean;
  source: "user" | "startup";
  createdAt: string;
  updatedAt: string;
}

export interface CustomSkill {
  id: string;
  name: string;
  description: string | null;
  content: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Skill {
  name: string;
  description: string;
  source: "file" | "database";
  enabled: boolean;
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
