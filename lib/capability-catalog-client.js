// capability-catalog-client.js — the read contract to fd-capability-catalog
// (change: wire-capability-catalog-into-pack-assembly, design D3, 2026-11-23).
//
// The catalog is a SERVICE consumed over MCP, like every other capability in the
// system (fd-open-data-mcp, text-core …). A pack-install checker does not read
// the catalog's SQLite file or spawn its CLI; it calls the catalog's MCP tools
// through the same StreamableHTTP client paas already uses for other MCP servers.
//
//   CAPABILITY_CATALOG_MCP_URL   e.g. http://capability-catalog:8320/mcp
//                                (default: {REGISTRY_URL}/capability-catalog/mcp)
//   CAPABILITY_CATALOG_BEARER    optional bearer for the catalog endpoint
//
// The loader it returns feeds checkCapabilityRefs: { serving, effective }.
//   serving   = capability -> [[server, tool], ...]  (from the `serving_edges` tool)
//   effective = governor's capability ids, or null  (from the `resolve_for` tool)
//
// Honest degrade: any connect/call failure throws; checkCapabilityRefs turns a
// throw into fail-closed (enforce) or a visible degrade (warn) — never a silent
// empty catalog.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const URL_ENV = () => {
  const explicit = (process.env.CAPABILITY_CATALOG_MCP_URL || "").trim();
  if (explicit) return explicit;
  const base = (process.env.REGISTRY_URL || process.env.FACET_BASE_URL || "").replace(/\/+$/, "");
  return base ? `${base}/capability-catalog/mcp` : "";
};
const BEARER = () => (process.env.CAPABILITY_CATALOG_BEARER || "").trim();

function _transport(endpoint, bearer) {
  const opts = {};
  if (bearer) opts.requestInit = { headers: { Authorization: `Bearer ${bearer}` } };
  return new StreamableHTTPClientTransport(new URL(endpoint), opts);
}

// The SDK returns tool results as { content: [{ type, text }, ...] }.
function _toolJson(result) {
  if (result && result.structuredContent && typeof result.structuredContent === "object") {
    return result.structuredContent;
  }
  const text = (result?.content || [])
    .filter((c) => c && c.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("");
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Build the loader checkCapabilityRefs expects.
 *
 * @param {object} opts
 * @param {string} [opts.governorServerAccess] JSON string of the governor's
 *        server_access array; omit for admin/full view.
 * @param {number} [opts.timeoutMs]
 * @returns {function} async () => {serving, effective}
 */
export function makeCatalogLoader(opts = {}) {
  const endpoint = opts.url || URL_ENV();
  const bearer = opts.bearer ?? BEARER();
  const timeoutMs = opts.timeoutMs ?? 8000;
  const governor = opts.governorServerAccess || null;

  return async () => {
    if (!endpoint) throw new Error("CAPABILITY_CATALOG_MCP_URL not configured");
    const client = new Client({ name: "paas-capability-check", version: "0.1.0" });
    try {
      await client.connect(_transport(endpoint, bearer));

      const edgesRes = await client.callTool(
        { name: "serving_edges", arguments: {} },
        undefined,
        { timeout: timeoutMs },
      );
      const serving = _toolJson(edgesRes) || {};

      let effective = null;
      if (governor) {
        const resRes = await client.callTool(
          { name: "resolve_for", arguments: { server_access: governor } },
          undefined,
          { timeout: timeoutMs },
        );
        const parsed = _toolJson(resRes);
        effective = Array.isArray(parsed?.effective) ? parsed.effective : [];
      }
      return { serving, effective };
    } finally {
      try { await client.close(); } catch { /* best-effort */ }
    }
  };
}