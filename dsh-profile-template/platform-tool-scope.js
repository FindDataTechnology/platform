// platform-tool-scope.js — per-role MCP tool allowlist enforcement
// (add-mcp-tool-scoping, design D2).
//
// Config arrives as tool-filter.json beside this file, materialized by the
// host (dsh-profile.js writeToolFilterPatch) from the selected preset's
// derived scope: { "mcpTools": { "<serverName>": ["leaf", ...] } }. An absent
// file, unparsable content, or an empty mapping means no filtering — full
// mode and legacy packs compose exactly as before.
//
// Three layers, deliberately asymmetric:
//   - GUARD (hard, drift-proof): a plain-context guard applies to EVERY agent
//     in this child process — the session agent and every delegated child —
//     and denies any mcp__<server>__<leaf> call whose leaf is not allowlisted
//     for that server. It only ever string-matches the called name, so it
//     never throws and never depends on registry state: server drift (new
//     tools, removed tools) cannot widen callability.
//   - SHADOW (registration-time, add-tool-scope-register-shadow): an
//     instance-level wrapper on the shared tool registry drops an
//     out-of-allowlist MCP registration before it enters the registry, for
//     every generation (initial mount + resyncs). Never-registered beats
//     masked: the schema never reaches the model and introspection cannot
//     surface it. Any seam surprise degrades silently to the layers below.
//   - RESTRICT (best-effort, context economy): applied per agent scope at
//     session composition (the preset bridge's setup hook) so out-of-allowlist
//     tools leave the model-facing roster entirely. tools.restrict() throws
//     on names unknown to the scope, so the deny set is computed from the
//     tools actually registered at composition time and any failure is
//     swallowed — the guard still enforces; only the context saving degrades.
//
// The deny form (never allow) is load-bearing: an allow-list deny-complement
// stale in either direction would throw, while deny computed against live
// registrations stays valid, and tools that appear later are covered by the
// guard until the next composition narrows them too.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// tool-filter.json lives beside this module by default (the profile dir once
// copied). TOOL_FILTER_PATH re-anchors it — the same seam dsh-profile's
// MCP_CONFIG_PATH provides, used by tests to point at a tmp fixture instead
// of writing into the repo's template dir.
const FILTER_FILE = process.env.TOOL_FILTER_PATH
  || join(dirname(fileURLToPath(import.meta.url)), "tool-filter.json");

// mcp__<serverName>__<rawName> — the dsh-mcp-client public naming convention.
const MCP_NAME_PREFIX = "mcp__";

function mcpNameParts(name) {
  if (typeof name !== "string" || !name.startsWith(MCP_NAME_PREFIX)) return null;
  const rest = name.slice(MCP_NAME_PREFIX.length);
  const sep = rest.indexOf("__");
  if (sep <= 0) return null;
  const server = rest.slice(0, sep);
  const leaf = rest.slice(sep + 2);
  if (!server || !leaf) return null;
  return { server, leaf };
}

// Read the materialized filter (per invocation — a tool call is LLM-paced, a
// tiny JSON read is noise, and per-read keeps an HMR'd patch file from serving
// a stale allowlist to the guard). Shape-tolerant: anything unexpected reads
// as "no filtering" rather than breaking composition.
// add-dsh-pod-adapter: the doc may carry an optional `byPreset` section —
// { mcpTools: <union>, byPreset: { <presetId>: { mcpTools: {…} } } }. The
// top-level map stays the process-wide face the guard and register-shadow
// read (the pod union — never narrower than any member's own allowlist, so
// the hard layers never block a tool some member needs); per-preset sections
// are the per-member exact faces composition-time restrict resolves through
// readMcpToolFilterFor. Docs without byPreset keep the legacy single-filter
// semantics byte-for-byte.
function normalizeMcpTools(mcpTools) {
  if (!mcpTools || typeof mcpTools !== "object" || Array.isArray(mcpTools)) return null;
  const normalized = {};
  for (const [server, tools] of Object.entries(mcpTools)) {
    if (!Array.isArray(tools)) continue;
    normalized[server] = new Set(tools.filter((t) => typeof t === "string"));
  }
  return Object.keys(normalized).length ? normalized : null;
}

// The denied BUILT-IN tool names (fix-external-team-chat-lane B3): a
// public-facing persona may not use the workspace file tools (glob / grep /
// read / bash) nor the roster-discovery tools (tool_search / list_agents /
// list_mcp_resources) — the last group is how the model ENUMERATED the
// internal tool names in the first place (the walkthrough caught "wire-ops"
// that way). Absent section ⇒ nothing denied (every pre-change composition
// behaves byte-for-byte).
export function readDeniedToolNames() {
  try {
    const doc = JSON.parse(readFileSync(FILTER_FILE, "utf8"));
    const names = doc?.denyTools;
    if (!Array.isArray(names)) return [];
    return names.filter((n) => typeof n === "string" && n.trim()).map((n) => n.trim());
  } catch {
    return [];
  }
}

export function readMcpToolFilter() {
  try {
    return normalizeMcpTools(JSON.parse(readFileSync(FILTER_FILE, "utf8"))?.mcpTools);
  } catch {
    return null;
  }
}

// The exact filter face for one preset's sessions (pod members): the
// per-preset section when the doc carries one for this id, else the whole-home
// map (legacy docs and un-sectioned presets alike — the guard's union is
// merely the upper bound, so a member narrowing to it loses nothing the hard
// layers would have caught).
export function readMcpToolFilterFor(presetId) {
  let doc;
  try {
    doc = JSON.parse(readFileSync(FILTER_FILE, "utf8"));
  } catch {
    return null;
  }
  const section = presetId ? doc?.byPreset?.[presetId] : null;
  return normalizeMcpTools(section?.mcpTools) ?? normalizeMcpTools(doc?.mcpTools);
}

// The guard body: undefined leaves the call unchanged; a string denies it.
// Names outside every mapped server are never denied — only servers WITH an
// allowlist are narrowed. The denial names the escape hatch (full-mode-tool-scope
// B3): the per-server "Full tool surface" toggle in Settings → MCP restores the
// whole surface in every mode. That pointer is the ONLY bridge change this
// change makes — the guard/restrict execution logic stays untouched.
// add-crm-desk-bridge D5: a leaf outside the doc's operatorFaces section for
// that server is PLATFORM governance, not role narrowing — the full-surface
// escape hatch does not apply (it restores up to the operator face), so the
// denial says so instead of pointing at a toggle that cannot help.
export function mcpToolGuardReason(name) {
  // Denied built-ins first (public-facing personas): the workspace file tools
  // and the roster-discovery tools are not MCP servers, so the allowlist path
  // below never sees them — this is the only gate that reaches them.
  if (name && readDeniedToolNames().includes(name)) {
    return "this tool is not available to an external-facing role";
  }
  const raw = readFilterDoc();
  const filter = raw && normalizeMcpTools(raw.mcpTools);
  if (!filter) return undefined;
  const parts = mcpNameParts(name);
  if (!parts) return undefined;
  const allow = filter[parts.server];
  if (allow === undefined || allow.has(parts.leaf)) return undefined;
  const operatorFace = operatorFaceHas(raw, parts.server, parts.leaf);
  if (operatorFace === false) {
    return (
      `tool '${parts.leaf}' is outside the platform tool face for MCP server '${parts.server}' — ` +
      `this bound is set by the deployment and cannot be widened from settings`
    );
  }
  return (
    `tool '${parts.leaf}' is outside this role's tool allowlist for MCP server '${parts.server}' — ` +
    `use an allowlisted tool, switch to a full mode, or enable "Full tool surface" for this server in Settings → MCP`
  );
}

// Read the raw filter doc (mcpTools + optional operatorFaces). Null on any
// read/parse failure — the guard then denies nothing, same as before.
function readFilterDoc() {
  try {
    const parsed = JSON.parse(readFileSync(FILTER_FILE, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

// true  — the server has an operator face AND the leaf is inside it (a role
//         narrowing denial; the escape-hatch copy applies);
// false — the server has an operator face AND the leaf is outside it (platform
//         bound; no escape hatch);
// null  — no operator face declared for this server (legacy semantics).
function operatorFaceHas(raw, server, leaf) {
  const face = raw?.operatorFaces?.[server];
  if (!Array.isArray(face)) return null;
  return face.includes(leaf);
}

// Install the global guard on a plain (non-agent) context. Registered through
// ctx.effect so the guard's own disposer lifts it on plugin disposal/HMR.
export function installMcpToolGuard(ctx) {
  ctx.effect(() => ctx.tools.guard((execution) => mcpToolGuardReason(execution?.name)), "platform.tool-scope.guard");
}

// Registration-time dropping (add-tool-scope-register-shadow): shadow the
// shared ToolRuntime's `register` with an own property, so out-of-allowlist
// MCP tools never enter the registry — every generation (initial mount and
// every resync), not just at composition. The seam is the cordis service
// proxy: registrations from any view dispatch to the raw instance's method,
// with the CALLING view as receiver, so `protoRegister.call(this, …)` below
// preserves scoped-vs-global attribution (verified on dsh-tools 0.1.1-rc.2 +
// cordis 4.0.4 — scripts/test-tool-scope-register-seam.mjs keeps watch).
// Anything unexpected — missing `cordis.original`, a non-function prototype
// method, an error inside the wrapper — leaves the original behavior exactly
// in place; the guard and composition-time restrict keep covering that case.
export function installMcpToolRegisterShadow(ctx) {
  let inst;
  try {
    inst = Reflect.get(ctx.get("tools"), Symbol.for("cordis.original"));
  } catch {
    return;
  }
  if (!inst || typeof inst.register !== "function" || Object.hasOwn(inst, "register")) return;
  const protoRegister = Object.getPrototypeOf(inst).register;
  if (typeof protoRegister !== "function") return;
  const shadow = function register(definition, ...rest) {
    let drop = false;
    try {
      const name = definition?.name;
      const filter = readMcpToolFilter();
      if (filter) {
        const parts = mcpNameParts(name);
        const allow = parts ? filter[parts.server] : undefined;
        drop = allow !== undefined && !allow.has(parts.leaf);
      }
    } catch {
      drop = false; // the wrapper must never cost a healthy registration
    }
    if (drop) return () => {};
    return protoRegister.call(this, definition, ...rest);
  };
  ctx.effect(() => {
    inst.register = shadow;
    return () => {
      if (inst.register === shadow) delete inst.register;
    };
  }, "platform.tool-scope.register-shadow");
}

// Best-effort roster narrowing on one agent scope, called from the preset
// bridge's setup hook AFTER presets.mount. Deny is computed from the tools the
// scope can actually see at composition time; unknown-name throws (MCP not
// synced yet, drifted list) degrade silently to guard-only enforcement.
// `presetId` (add-dsh-pod-adapter) resolves the exact per-preset face from the
// filter doc's byPreset section — a pod member narrows to its OWN allowlist,
// not the pack union (the guard keeps enforcing the union as the upper bound).
export function applyMcpToolRestrict(agentCtx, presetId = null) {
  let filter;
  try {
    filter = presetId ? readMcpToolFilterFor(presetId) : readMcpToolFilter();
  } catch {
    filter = null;
  }
  // Denied built-ins are independent of the allowlist map: the filter file may
  // carry a denyTools section while declaring no per-server faces at all
  // (readMcpToolFilter() answers null for an empty mcpTools map). Returning
  // early on a null filter would leave those built-ins VISIBLE in the roster —
  // the guard blocks their calls, but B3 exists to keep internal tool names
  // off the model's sight entirely. So the deny set is always computed; a null
  // filter only skips the MCP allowlist stage below.
  const deniedBuiltins = new Set(readDeniedToolNames());
  let visible;
  try {
    visible = agentCtx.tools.schemas().map((s) => s?.name).filter((n) => typeof n === "string");
  } catch {
    return; // roster unreadable at composition time — guard still enforces
  }
  const deny = [];
  for (const name of visible) {
    // Denied built-ins (public-facing personas): removed from the roster so
    // the model never sees them; the guard still enforces the call path.
    if (deniedBuiltins.has(name)) {
      deny.push(name);
      continue;
    }
    if (!filter) continue;
    const parts = mcpNameParts(name);
    if (!parts) continue;
    const allow = filter[parts.server];
    if (allow !== undefined && !allow.has(parts.leaf)) deny.push(name);
  }
  if (deny.length === 0) return;
  try {
    agentCtx.tools.restrict({ deny });
  } catch (err) {
    // Unknown-name (list drifted between schemas() and restrict()) or a
    // reserved-name collision — context narrowing degrades, interception does
    // not (the global guard denies every out-of-allowlist call regardless).
    agentCtx.logger?.warn?.(`platform.tool-scope: roster narrowing degraded to guard-only (${err?.message || err})`);
  }
}

// ── Session-gated MCP servers (live-runtime-control, tools/set) ──────────────
// A per-session on/off gate for whole MCP servers, defaulting CLOSED for the
// servers the host names at initialize (the platform default: websearch off).
// Enforcement is a per-agent guard (the same hard layer as the role allowlist
// guard above), so a live flip is instant and never needs a child restart or a
// roster recomposition. The gate only ever DENIES closed servers for agents of
// sessions that did not enable them — it cannot re-enable a server the
// operator disabled through the extensions surface, nor widen a role allowlist.
const sessionGates = new Map(); // sessionId -> Map<server, boolean>

export function setSessionToolGate(sessionId, server, enabled) {
  let byServer = sessionGates.get(sessionId);
  if (!byServer) {
    byServer = new Map();
    sessionGates.set(sessionId, byServer);
  }
  byServer.set(server, enabled === true);
}

export function sessionGateEnabled(sessionId, server) {
  return sessionGates.get(sessionId)?.get(server) === true;
}

// The guard body for gated servers: undefined leaves the call unchanged; a
// string denies it. Only servers the host declared session-gated are ever
// denied here — an unnamed server keeps today's behavior whatever the map says.
export function sessionGateReason(sessionId, gatedServers, name) {
  const parts = mcpNameParts(name);
  if (!parts) return undefined;
  if (!gatedServers.includes(parts.server)) return undefined;
  if (sessionGateEnabled(sessionId, parts.server)) return undefined;
  return (
    `web search tools for MCP server '${parts.server}' are disabled for this session ` +
    "(platform default) — ask the user to enable the session's web-search toggle before using them"
  );
}

// Install the per-agent session gate guard on one agent scope. Reads the live
// gate map on every call, so a tools/set flip applies to the next tool call
// with no recomposition. Registered through agentCtx.effect so the guard lifts
// with the agent scope.
export function installSessionToolGate(agentCtx, sessionId, gatedServers) {
  const reason = (execution) => sessionGateReason(sessionId, gatedServers, execution?.name);
  agentCtx.effect(() => agentCtx.tools.guard(reason, "platform.session-tool-gate"), "platform.session-tool-gate");
}

export { FILTER_FILE };
