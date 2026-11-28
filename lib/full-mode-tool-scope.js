// ── Full-mode tool scope (full-mode-tool-scope B1/B2) ────────────────────────
//
// The tool face full mode composes from the installed packs. Pure: the caller
// hands in the durable `installed_packs` snapshots at every composition, so a
// pack install/upgrade/uninstall re-derives automatically and nothing is
// persisted as a materialized allowlist.
//
// Safety valve (B2): an UNDECLARED reference (legacy pack), an empty
// declaration, or an explicit `fullSurface` marker contributes the server's
// WHOLE surface — the server is absent from the returned map, which is exactly
// "no filter for it". A server no pack references is absent too. The result is
// null when nothing is narrowed, which keeps the pre-change composition
// byte-identical.

import { operatorToolFace } from "./operator-tool-face.js";

const FULL = Symbol("full-surface");

// Operator ceiling (add-crm-desk-bridge D5): apply the operator-declared
// per-server tool faces to a DERIVED filter map over the servers actually
// present in the composition. Runs as the LAST step before materialization, so
// it caps every mode from above: full mode's pack union, custom-preset
// narrowing, pack-persona allowlists, and the user's full-surface override
// (whose "remove the key" marker the cap simply overrides back in — bounded).
//
// Semantics per server with an operator face:
//   - no existing filter (full surface by any route) → the face IS the filter;
//   - an existing allowlist (pack/role declaration) → the INTERSECTION;
//   - an empty intersection is emitted as [] deliberately: for an
//     operator-capped server "nothing visible" is the honest reading, unlike
//     the pack-union map where an empty entry means "no filter".
//
// Pure: `mcpTools` is never mutated; a fresh object (or null when no
// operator-face server is present) comes back. `faceFor` is the test seam.
export function capByOperatorFace(mcpTools, presentServers, { faceFor = operatorToolFace } = {}) {
  const hadMap = mcpTools && typeof mcpTools === "object" && !Array.isArray(mcpTools);
  const out = hadMap ? { ...mcpTools } : {};
  let touched = false;
  for (const server of Array.isArray(presentServers) ? presentServers : []) {
    if (typeof server !== "string" || !server) continue;
    const face = faceFor(server);
    if (!face) continue;
    const existing = Array.isArray(out[server]) ? [...new Set(out[server])] : null;
    out[server] = existing ? existing.filter((t) => face.includes(t)) : [...face];
    touched = true;
  }
  // Untouched ⇒ pass the input through unchanged: null stays null (no filter
  // at all) and a non-null map (a pack/preset-derived filter over servers with
  // no operator face) stays itself — the cap must never DISCARD an existing
  // filter, only bound it.
  if (!touched) return hadMap ? mcpTools : null;
  return out;
}

export function deriveFullModeToolScope(installedPacks, fullSurfaceServers = []) {
  const byServer = new Map();
  for (const pack of Array.isArray(installedPacks) ? installedPacks : []) {
    for (const ref of pack?.manifest?.mcpServers ?? []) {
      const server = ref?.registryName;
      if (typeof server !== "string" || !server) continue;
      const declared = Array.isArray(ref.allowTools)
        ? ref.allowTools.filter((t) => typeof t === "string" && t)
        : [];
      if (ref.fullSurface === true || declared.length === 0) {
        byServer.set(server, FULL);
        continue;
      }
      if (byServer.get(server) === FULL) continue;
      const set = byServer.get(server) ?? new Set();
      for (const tool of declared) set.add(tool);
      byServer.set(server, set);
    }
  }
  for (const server of Array.isArray(fullSurfaceServers) ? fullSurfaceServers : []) {
    if (typeof server === "string" && server) byServer.set(server, FULL);
  }
  const out = {};
  for (const [server, value] of byServer) {
    // FULL and an (unreachable) empty set both mean "no filter": never emit
    // `{server: []}`, which would hide the server's entire tool surface.
    if (value === FULL || value.size === 0) continue;
    out[server] = [...value];
  }
  return Object.keys(out).length > 0 ? out : null;
}

// A custom preset's focused face (B4/D4): a declared per-server list narrows
// to exactly those names; an absent one inherits the full-mode union for that
// server; a server nobody narrows stays absent (= full surface). The user's
// override removes the server regardless — the marker outranks every mode.
export function customPresetToolScope(mcpServers, declaredTools, fullModeUnion, fullSurfaceServers = []) {
  const overridden = new Set(Array.isArray(fullSurfaceServers) ? fullSurfaceServers : []);
  const out = {};
  for (const server of Array.isArray(mcpServers) ? mcpServers : []) {
    if (typeof server !== "string" || !server || overridden.has(server)) continue;
    const declared = Array.isArray(declaredTools?.[server])
      ? [...new Set(declaredTools[server].filter((t) => typeof t === "string" && t))]
      : [];
    if (declared.length > 0) {
      out[server] = declared;
    } else if (Array.isArray(fullModeUnion?.[server]) && fullModeUnion[server].length > 0) {
      out[server] = [...fullModeUnion[server]];
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}
