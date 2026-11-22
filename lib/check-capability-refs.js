// check-capability-refs.js — assembly-time capability check (change:
// wire-capability-catalog-into-pack-assembly).
//
// A pack manifest declares `mcpServers[].registryName` (+ optional `allowTools`).
// That is a CLAIM. This module checks the claim against the capability catalog:
// every referenced (server, tool) must hit a real serving edge, and — when a
// governor is supplied — must fall inside the governor's own capability range.
//
// It is deliberately split from `validatePackManifest` (pure structure, no I/O):
// this module does the catalog I/O, behind an injectable `loadCatalog` so the
// check is unit-testable without a live catalog and the caller decides how to
// reach it (subprocess CLI or db — see design D3). Fail-closed is the default:
// a catalog that cannot be loaded is a refusal, not a pass (design D4).

//: A `(server, tool)` pair reaching the catalog looks like this in the CLI's
//: `list`/`resolve` output. `serving` is capability -> [[server, tool], ...].
const DEFAULT_CATALOG = { serving: {}, effective: null };

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

// Does the catalog know this (server, tool)? A `*` reference is satisfied when the
// server serves ANY capability; a concrete tool when some serving edge names it.
function _catalogHas(serving, server, tool) {
  for (const edges of Object.values(serving || {})) {
    for (const [s, t] of edges || []) {
      if (s !== server) continue;
      if (tool === "*") return true;
      if (t === tool) return true;
    }
  }
  return false;
}

// Is this capability id inside the governor's effective set? `effective === null`
// means "no governor restriction supplied" (admin tooling).
function _governed(effective, capabilityIds) {
  if (effective === null) return true;
  const set = effective instanceof Set ? effective : new Set(effective);
  return capabilityIds.some((id) => set.has(id));
}

// Which capability ids are served by exactly this (server, tool)?
function _capsServedBy(serving, server, tool) {
  const caps = [];
  for (const [cap, edges] of Object.entries(serving || {})) {
    for (const [s, t] of edges || []) {
      if (s !== server) continue;
      if (tool === "*" || t === tool) { caps.push(cap); break; }
    }
  }
  return caps;
}

/**
 * Check a manifest's MCP references against the capability catalog.
 *
 * @param {object} manifest   pack manifest (mcpServers[]).
 * @param {object} opts
 * @param {string} [opts.pack]         pack name for error messages.
 * @param {boolean} [opts.failClosed]  default true: catalog unavailable -> refuse.
 * @param {function} [opts.loadCatalog] async () => {serving, effective}. Its throw
 *        means "catalog unavailable". Default returns empty (always-unavailable).
 * @returns {Promise<{ok, missing, ungoverned, catalogUnavailable}>}
 */
export async function checkCapabilityRefs(manifest, opts = {}) {
  const pack = opts.pack || manifest?.name || "(unnamed)";
  const failClosed = opts.failClosed !== false;
  const loadCatalog = opts.loadCatalog || (async () => DEFAULT_CATALOG);

  let catalog;
  try {
    catalog = await loadCatalog();
  } catch (err) {
    // Catalog unreachable: fail-closed (refuse) is the default; the caller may
    // opt into degrade, but this function must report it plainly either way.
    return {
      ok: !failClosed ? true : false,
      missing: [],
      ungoverned: [],
      catalogUnavailable: true,
      reason: `capability catalog unavailable: ${err?.message || err}`,
      degraded: !failClosed,
    };
  }

  const serving = catalog?.serving || {};
  const effective = catalog?.effective ?? null;
  const refs = manifestToolRefs(manifest);

  const missing = [];
  const ungoverned = [];
  // For a GOVERNED caller (effective range supplied), do not distinguish "exists
  // but outside my range" from "does not exist at all" — that distinction leaks
  // the existence of a capability the caller may not perceive
  // (capability-resolution "unperceivable"). Both collapse into `unavailable`.
  // An admin (effective === null) sees the precise reason, which is safe.
  const governed = effective !== null;
  const unavailable = [];
  for (const [server, tool] of refs) {
    const exists = _catalogHas(serving, server, tool);
    const allowed = exists && _governed(effective, _capsServedBy(serving, server, tool));
    if (allowed) continue;
    if (!governed) {
      // admin: precise reason
      if (!exists) missing.push({ server, tool, pack });
      else ungoverned.push({ server, tool, pack });
    } else {
      // governed: one opaque bucket — no existence leak
      unavailable.push({ server, tool, pack });
    }
  }

  return {
    ok: missing.length === 0 && ungoverned.length === 0 && unavailable.length === 0,
    missing,
    ungoverned,
    unavailable,
    catalogUnavailable: false,
  };
}

// One-line human summary for logs / error bodies.
export function describeRefFailures(result) {
  if (result.catalogUnavailable) return result.reason || "capability catalog unavailable";
  const parts = [];
  for (const m of result.missing) parts.push(`${m.server}.${m.tool} not found in catalog`);
  for (const u of result.ungoverned) parts.push(`${u.server}.${u.tool} outside governor's range`);
  for (const x of result.unavailable || []) parts.push(`${x.server}.${x.tool} unavailable to this assembler`);
  return parts.join("; ");
}

// The install-time mode gate. "off" (default) means the check must not run at
// all — this is the byte-for-byte-prior-behavior guarantee. Returns the active
// mode or null when the check should be skipped entirely.
export function activeCheckMode(rawMode) {
  const m = String(rawMode || "off").toLowerCase();
  return m === "warn" || m === "enforce" ? m : null;
}