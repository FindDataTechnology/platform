// check-capability-refs.js — assembly-time MCP-reference check (change:
// wire-capability-catalog-into-pack-assembly).
//
// A pack manifest declares `mcpServers[].registryName` (+ optional `allowTools`).
// That is a CLAIM. This module checks the claim before `installPack` writes
// anything: every declared tool must exist on the referenced server.
//
// ── Authority: the registry server index (corrected 2026-11-23) ──────────────
// A capability catalog serves SEMANTIC capabilities (concept / indicator /
// graph). A pack reference is a SERVICE reference: (server, tool) on an MCP
// server. Measured against all 104 live packs that declare mcpServers: the
// catalog knows none of them (chatwoot, wire-build-mcp, fd-daas-mcp … are
// servers, not capabilities) — a catalog-authority check refused 104/104, which
// is not a false-positive rate, it is a category error.
//
// The authority for "is this server/tool real" is the registry's server index,
// the same source `lib/publish-tool-gate.js` already validates publishes
// against. Refinement narrowed it further: a name that is NOT a registry entry
// (`chatwoot`, `fleet-architect`, `fd-memory` …) is a LOCAL-BINDING reference —
// exempt here, exactly as the publish gate treats it, because its surface is
// knowable only inside the cell. Validating only registry-hosted servers took
// the live false-positive count to zero real positives and surfaced 30 genuine
// ones (packs declaring `wire-build-mcp` tools the deployed image predates).
//
// The capability CATALOG keeps its role where it is the right authority: the
// governor's capability RANGE (which semantic capabilities a principal may
// use). That is `resolve_for`, wired through the catalog MCP — see design D3.

// Turn a manifest into the (server, tool|*) references it claims.
//   - `{registryName, allowTools: [t1,t2]}` -> [(rg, t1), (rg, t2)]
//   - `{registryName}` (no allowTools)      -> [(rg, "*")]  (the whole server)
export function manifestToolRefs(manifest) {
  const out = [];
  for (const m of manifest?.mcpServers ?? []) {
    if (!m || typeof m.registryName !== "string") continue;
    const tools = Array.isArray(m.allowTools) && m.allowTools.length > 0 ? m.allowTools : ["*"];
    for (const t of tools) out.push([m.registryName, String(t)]);
  }
  return out;
}

/**
 * Check a manifest's MCP references against the registry server index.
 *
 * @param {object} manifest         pack manifest (mcpServers[]).
 * @param {object} opts
 * @param {string} [opts.pack]      pack name for error messages.
 * @param {boolean} [opts.failClosed] default true: index unavailable -> refuse.
 * @param {function} [opts.loadIndex] async () => Map<server, {toolList}>. Its
 *        throw means "index unavailable". Default = empty (every ref exempt).
 * @returns {Promise<{ok, missing, catalogUnavailable}>}
 *   `missing`: [{server, tool, pack}] — a tool the registry knows the server for
 *   but that the server does not expose. Refs to servers absent from the index
 *   are local-binding references and never appear (never a false positive).
 */
export async function checkCapabilityRefs(manifest, opts = {}) {
  const pack = opts.pack || manifest?.name || "(unnamed)";
  const failClosed = opts.failClosed !== false;
  const loadIndex = opts.loadIndex || (async () => new Map());

  let index;
  try {
    index = await loadIndex();
  } catch (err) {
    // Index unreachable: fail-closed (refuse) is the default; the caller may
    // opt into degrade, but this function must report it plainly either way.
    return {
      ok: !failClosed ? true : false,
      missing: [],
      catalogUnavailable: true,
      reason: `registry server index unavailable: ${err?.message || err}`,
      degraded: !failClosed,
    };
  }

  const missing = [];
  for (const [server, tool] of manifestToolRefs(manifest)) {
    const info = index instanceof Map ? index.get(server) : index?.[server];
    if (!info) continue; // local-binding reference — exempt (publish-gate semantics)
    if (tool === "*") {
      // The whole surface is claimed. A server the index knows but whose
      // tool_list is empty is a snapshot gap, not an error — never refuse on it.
      continue;
    }
    const known = Array.isArray(info.toolList) ? info.toolList : [];
    if (!known.includes(tool)) missing.push({ server, tool, pack });
  }

  return {
    ok: missing.length === 0,
    missing,
    catalogUnavailable: false,
  };
}

// One-line human summary for logs / error bodies.
export function describeRefFailures(result) {
  if (result.catalogUnavailable) return result.reason || "registry server index unavailable";
  return result.missing
    .map((m) => `${m.server}.${m.tool} not exposed by that server`)
    .join("; ");
}

// The install-time mode gate. "off" (default) means the check must not run at
// all — this is the byte-for-byte-prior-behavior guarantee. Returns the active
// mode or null when the check should be skipped entirely.
export function activeCheckMode(rawMode) {
  const m = String(rawMode || "off").toLowerCase();
  return m === "warn" || m === "enforce" ? m : null;
}
