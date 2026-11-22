// capability-catalog-client.js — the read contract to fd-capability-catalog
// (change: wire-capability-catalog-into-pack-assembly, design D3).
//
// The catalog is a SERVICE consumed over MCP, like every other capability in the
// system (fd-open-data-mcp, text-core …). This module is the ONE place that
// knows how to reach it:
//
//   CAPABILITY_CATALOG_MCP_URL   e.g. http://capability-catalog:8320/mcp
//                                (default: {REGISTRY_URL}/capability-catalog/mcp)
//   CAPABILITY_CATALOG_BEARER    optional bearer for the catalog endpoint
//
// Honest degrade: any connect/call failure throws; checkCapabilityRefs turns a
// throw into fail-closed (enforce) or a visible degrade (warn) — never a silent
// empty catalog.
//
// NOTE (2026-11-23): the reference check's authority is the registry server
// index (see check-capability-refs.js). This client remains for the capability
// RANGE (§3 of the change: `resolve_for`), which is the catalog's own question.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const URL_ENV = () => {
  const explicit = (process.env.CAPABILITY_CATALOG_MCP_URL || "").trim();
  if (explicit) return explicit;
  const base = (process.env.REGISTRY_URL || process.env.FACET_BASE_URL || "").replace(/\/+$/, "");
  return base ? `${base}/capability-catalog/mcp` : "";
};
const BEARER = () => (process.env.CAPABILITY_CATALOG_BEARER || "").trim();

// One short-lived MCP connection per call: pack install is not a hot path, and a
// pooled session would need reconnect handling the install path has no room for.
async function _call(toolName, args = {}) {
  const url = URL_ENV();
  if (!url) throw new Error("CAPABILITY_CATALOG_MCP_URL not configured");
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: BEARER() ? { headers: { Authorization: `Bearer ${BEARER()}` } } : {},
  });
  const client = new Client({ name: "paas-pack-install", version: "1" }, { capabilities: {} });
  try {
    await client.connect(transport);
    const res = await client.callTool({ name: toolName, arguments: args }, undefined, { timeout: 30_000 });
    const text = res?.content?.find((c) => c.type === "text")?.text ?? "null";
    return JSON.parse(text);
  } finally {
    await client.close().catch(() => {});
  }
}

/**
 * The governor's effective capability set (catalog model C).
 *
 * @param {object} opts
 * @param {string} [opts.governorServerAccess] JSON of the governor's
 *        server_access list; omit for admin/full view (null).
 * @returns {Promise<string[]|null>} capability ids, or null for no restriction.
 */
export async function loadEffectiveCapabilities(opts = {}) {
  const gov = opts.governorServerAccess;
  if (!gov) return null; // admin / no governor -> no restriction
  const res = await _call("resolve_for", { server_access: gov });
  return Array.isArray(res?.effective) ? res.effective : [];
}

/** capability id -> [[server, tool], ...] serving edges (catalog's view). */
export async function loadServingEdges() {
  return _call("serving_edges", {});
}
