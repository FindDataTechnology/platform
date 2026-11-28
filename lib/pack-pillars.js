// ── Three pillars: memory / toolkit / dashboard (openspec: pillar-surfaces) ──
//
// ONE derivation, many surfaces. Every restrict that presents a pack (market
// grid card, pack detail page, the wanxing agent detail page, the wanxing
// console, the team console, the machine face) consumes THIS result. A surface
// that derives its own answer from the manifest is the drift this module
// exists to prevent — three projections of the same manifest already disagreed
// once (skills+mcpServers in the plaza export, skills only on the wanxing
// detail page, three buckets in the market sheet).
//
// Three rules that are not ordinary shape checks:
//
//   · `toolkit.roles[].effective` reuses `effectiveMcpTools()` — the SAME
//     narrowing the deploy descriptor and the runner apply. A second
//     implementation would let the displayed tool face and the executed one
//     drift, which is the exact failure the pillar assertions were built for.
//   · `memory.rows` reuses `memoryRows()` — the SAME inheritance resolution
//     the memory service honours, so "declared" and "effective" can be shown
//     side by side without a second opinion.
//   · A pillar whose declaration does not validate comes back as
//     `state: "invalid"` with the named paths. It NEVER throws and NEVER
//     quietly renders a normal-looking default: a page that dies because one
//     optional section is malformed is worse than a page that says which
//     section is malformed.
//
// Zero state of its own: no DB, no env, no caches. Callers may pass
// `toolTotals` (registry tool counts) as an enrichment; without it the field is
// simply absent (unknown ≠ zero).

import { effectiveMcpTools } from "./pack-manifest.js";
import { memoryRows, validateMemoryBlock, AGENT_MEMORY_EXTRA_KEYS, checkReadSpellingAgreement } from "./pack-memory.js";
import { validateConsoleSection, surfacesOf } from "./console-blocks-spec.js";
import { validateBench } from "./pack-bench.js";

export const PILLAR_STATE = Object.freeze({
  PRESENT: "present",
  UNDECLARED: "undeclared",
  /** The declaration itself is malformed — `errors` names every path. */
  INVALID: "invalid",
});

const isObj = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const invalid = (errors) => ({ state: PILLAR_STATE.INVALID, errors });

// ── memory ─────────────────────────────────────────────────────────────────

function deriveMemory(manifest, agent, scoped) {
  const packBlock = isObj(manifest?.memory) ? manifest.memory : null;
  const agentBlock = isObj(agent?.memory) ? agent.memory : null;
  const agentHasDeclarations = (manifest?.agents ?? []).some((a) => isObj(a?.memory));
  if (!packBlock && !agentBlock && !agentHasDeclarations) return { state: PILLAR_STATE.UNDECLARED };

  const errors = [];
  // The same validator the publish gate runs, so a declaration that reaches a
  // surface unvalidated (an old version, a hand-built manifest in a test) is
  // still read the same way it would be rejected.
  for (const e of validateMemoryBlock(packBlock, "memory")) errors.push(e);
  // Unscoped = every role's declaration is in view, so every one is checked.
  const agentBlocks = scoped
    ? (agentBlock ? [[agent?.id ?? null, agentBlock]] : [])
    : (manifest?.agents ?? []).filter((a) => isObj(a?.memory)).map((a) => [a.id ?? null, a.memory]);
  for (const [id, block] of agentBlocks) {
    for (const e of validateMemoryBlock(block, `agents[${id ?? "?"}].memory`, { extraKeys: AGENT_MEMORY_EXTRA_KEYS })) {
      errors.push(e);
    }
  }
  for (const e of checkReadSpellingAgreement(manifest?.knowledge?.memory, packBlock?.read)) errors.push(e);
  if (errors.length > 0) return invalid(errors);

  // Most-specific first, exactly like every other consumer of the chain.
  const levels = agentBlock ? [["agent", agentBlock], ["pack", packBlock ?? {}]] : [["pack", packBlock ?? {}]];
  const rows = memoryRows(levels);

  // Guidance is agent-only by construction (AGENT_MEMORY_EXTRA_KEYS). Pack-level
  // guidance has no consumer, so accepting one here would turn a declaration
  // into decoration.
  const guidance = [];
  for (const a of manifest?.agents ?? []) {
    const text = typeof a?.memory?.guidance === "string" ? a.memory.guidance.trim() : "";
    if (text) guidance.push({ agentId: a.id ?? null, text });
  }
  const scopedGuidance = scoped ? guidance.filter((g) => g.agentId === (agent?.id ?? null)) : guidance;

  return {
    state: PILLAR_STATE.PRESENT,
    // The four declared axes, verbatim (machine-face shape: enumerated values
    // only, never the prose).
    axes: {
      ...(isObj(packBlock?.store) ? { store: packBlock.store } : {}),
      ...(isObj(packBlock?.read) ? { read: packBlock.read } : {}),
      ...(isObj(packBlock?.write) ? { write: packBlock.write } : {}),
      ...(isObj(packBlock?.process) ? { process: packBlock.process } : {}),
    },
    // Declared vs effective, one row per sub-key — the reconciliation face.
    rows,
    // Per-role chains, so an unscoped sheet can show "this role resolves
    // differently from the pack" without the caller re-implementing the
    // inheritance order. Absent for roles with no declaration of their own:
    // absence means "this role adds nothing", never "unknown".
    ...(scoped || agentBlocks.length === 0
      ? {}
      : {
          roles: agentBlocks.map(([id, block]) => ({
            agentId: id,
            rows: memoryRows([["agent", block], ["pack", packBlock ?? {}]]),
          })),
        }),
    guidance: scopedGuidance,
    // Pack vs agent: which level carried the block, so a surface can say
    // "this role narrows what the pack declares" instead of implying both.
    declaredAt: { pack: Boolean(packBlock), agent: Boolean(agentBlock) },
  };
}

// ── toolkit ────────────────────────────────────────────────────────────────

function deriveToolkit(manifest, agent, toolTotals, scoped) {
  const servers = (manifest?.mcpServers ?? []).filter((m) => isObj(m) && typeof m.registryName === "string");
  if (servers.length === 0) return { state: PILLAR_STATE.UNDECLARED };

  const errors = [];
  const declaredNames = new Set(servers.map((s) => s.registryName));

  const roles = [];
  for (const a of manifest?.agents ?? []) {
    const role = a?.resources?.mcpTools;
    if (role !== undefined && !isObj(role)) {
      errors.push({
        error: `agents[${a?.id ?? "?"}].resources.mcpTools must be an object mapping MCP references to tool leaf arrays`,
        path: `agents[${a?.id ?? "?"}].resources.mcpTools`,
        code: "mcp_tools_not_object",
      });
      continue;
    }
    // A role may only narrow servers the pack itself declares — the publish
    // gate enforces the same rule; repeating it here keeps a hand-built
    // manifest from rendering a tool face that nothing can execute.
    for (const name of Object.keys(role ?? {})) {
      if (!declaredNames.has(name)) {
        errors.push({
          error: `agent '${a?.id ?? "?"}' narrows '${name}' in resources.mcpTools, which the pack itself does not declare`,
          path: `agents[${a?.id ?? "?"}].resources.mcpTools['${name}']`,
          code: "mcp_tools_undeclared_server",
        });
      }
    }
    // The role's server subset — `resources.mcpServers` narrows which servers a
    // role mounts at all (absent = all of them).
    const keep = Array.isArray(a?.resources?.mcpServers) ? new Set(a.resources.mcpServers) : null;
    const effective = effectiveMcpTools(manifest, a);
    const effectiveServers = keep ? [...keep].filter((n) => declaredNames.has(n)) : [...declaredNames];
    const narrowed = effectiveServers.length < declaredNames.size
      || servers.some((s) => {
        const packList = Array.isArray(s.allowTools) ? s.allowTools : null;
        const eff = effective[s.registryName];
        if (packList === null) return eff !== undefined; // role narrowed a full-surface server
        if (eff === undefined) return true; // role dropped this server entirely
        return eff.length < packList.length;
      });
    roles.push({
      agentId: a?.id ?? null,
      declared: isObj(role) ? role : null,
      effective,
      effectiveServers,
      narrowed,
    });
  }
  if (errors.length > 0) return invalid(errors);

  const scopedRoles = scoped ? roles.filter((r) => r.agentId === (agent?.id ?? null)) : roles;

  return {
    state: PILLAR_STATE.PRESENT,
    servers: servers.map((s) => ({
      registryName: s.registryName,
      allowTools: Array.isArray(s.allowTools) ? s.allowTools : null,
      fullSurface: s.fullSurface === true,
      ...(s.fullSurfaceReason ? { fullSurfaceReason: s.fullSurfaceReason } : {}),
      // Registry tool count is a read-face enrichment, never invented here.
      ...(toolTotals && Number.isFinite(toolTotals[s.registryName])
        ? { totalTools: toolTotals[s.registryName] }
        : {}),
    })),
    roles: scopedRoles,
  };
}

// ── dashboard ──────────────────────────────────────────────────────────────

function deriveDashboard(manifest) {
  const section = manifest?.console;
  if (section === undefined || section === null) return { state: PILLAR_STATE.UNDECLARED };
  const errors = validateConsoleSection(section);
  if (errors.length > 0) {
    return invalid(errors.map((e) => ({ error: e.error, path: e.entry ?? "console", ...(e.code ? { code: e.code } : {}) })));
  }
  return {
    state: PILLAR_STATE.PRESENT,
    headline: typeof section.headline === "string" ? section.headline : null,
    blocks: (section.blocks ?? []).map((b) => ({
      block: b.block,
      ...(isObj(b.params) ? { params: b.params } : {}),
      surfaces: surfacesOf(b),
    })),
  };
}

// ── bench ──────────────────────────────────────────────────────────────────

/**
 * Declared / effective / executed for the 知验台 ability.
 *
 * `executed` is measured from what this version's install path actually does,
 * not inferred from the declaration: store.home (resolved), source (probed),
 * mode (routed). `share` has no execution path yet, so it stays false — a
 * declared-but-unexecuted key must read as such (memory's EXECUTED_MEMORY_SUBKEYS
 * discipline).
 */
function deriveBench(manifest) {
  const block = manifest?.bench;
  if (block === undefined || block === null) return { state: PILLAR_STATE.UNDECLARED };
  const errors = validateBench(block, "bench");
  if (errors.length > 0) return invalid(errors);

  const declared = (value) => ({ declared: value ?? null, effective: value ?? null, executed: true });
  const rows = {
    mode: declared(block.mode),
    "store.home": declared(block.store.home),
    source: declared(block.source),
    "fork.diff": {
      declared: block.fork?.diff ?? null,
      effective: block.fork?.diff ?? null,
      executed: block.mode === "fork",
    },
    "share.asset_classes": {
      declared: block.share?.asset_classes ?? null,
      effective: block.share?.asset_classes ?? null,
      executed: false,
    },
  };
  return {
    state: PILLAR_STATE.PRESENT,
    mode: block.mode,
    assets: [...block.assets],
    store: block.store.home,
    source: { ...block.source },
    rows,
  };
}

// ── entry ──────────────────────────────────────────────────────────────────

/**
 * Derive the three pillars from one immutable pack manifest.
 *
 * @param {object} manifest  a published manifest (already validated, or not —
 *                           a malformed section comes back as `invalid`)
 * @param {object} [options]
 * @param {string|null} [options.agentId]  scope every pillar to one role; the
 *   result is a deterministic projection of the unscoped one
 * @param {Record<string, number>|null} [options.toolTotals]  registry tool
 *   counts per server name (optional enrichment)
 * @returns {{memory: object, toolkit: object, dashboard: object}}
 */
export function derivePillars(manifest, { agentId = null, toolTotals = null } = {}) {
  const m = isObj(manifest) ? manifest : {};
  // `agentId == null` means UNSCOPED (every role). A scope that names a role
  // this pack does not carry is a real answer — the role dimension is empty —
  // not a silent fallback to "all roles", which would show a caller a tool
  // face belonging to somebody else.
  const scoped = agentId != null;
  const agent = scoped ? (m.agents ?? []).find((a) => a?.id === agentId) ?? null : null;
  return {
    memory: deriveMemory(m, agent, scoped),
    toolkit: deriveToolkit(m, agent, toolTotals, scoped),
    dashboard: deriveDashboard(m),
    bench: deriveBench(m),
  };
}

/** Every pillar id, in the fixed render order. Surfaces iterate THIS. */
export const PILLAR_ORDER = Object.freeze(["memory", "toolkit", "dashboard", "bench"]);
