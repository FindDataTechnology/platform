// ── Runtime fingerprint (harden-agent-runtime-spine, runtime-fingerprint) ────
//
// "Which configuration produced this run" as a machine-comparable fact.
//
// Why it must exist: today a turn carries model/provider/effort/preset, but
// nothing identifies the WHOLE composed runtime (persona text + skill bodies +
// MCP servers + tool allowlist + matrix). Replace one skill and two runs in the
// store look identical, so "is version B better?" can only be answered by date —
// and every version comparison, rollback basis and cost-per-version claim rests
// on this column.
//
// TWO RULES, and they point in opposite directions on purpose:
//
//   1. STABILITY — anything that changes the BYTES but not the BEHAVIOUR must
//      leave the fingerprint alone: comments, key order, whitespace, YAML style,
//      paths, timestamps, iteration order. A fingerprint that moves on a comment
//      edit reports "config changed" every time somebody tidies a file, and the
//      version comparison becomes noise.
//   2. SENSITIVITY — anything that changes BEHAVIOUR must move it: a skill body,
//      the tool allowlist, an MCP endpoint, persona text, model/provider/effort.
//
// The input is a WHITELIST (only the listed fields are read), never a blacklist
// ("ignore comments"). A blacklist misses a new field whenever the upstream
// format grows one, and the miss reads as a FALSE MERGE — two different runs
// judged the same version, which is the direction that silently invalidates a
// comparison. A whitelist's miss is a false SPLIT, which a diff shows at once.
//
// Two outputs: `bundle` (one hash — the version ID other artifacts reference)
// and `parts` (per-part hashes — answers "which grid changed"). Both ship: one
// is for grouping, the other for diagnosis, and neither substitutes for the other.

import { createHash } from "node:crypto";

/** Behaviour-relevant normalisation: line endings and trailing space only. */
function normText(s) {
  return String(s ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .trim();
}

function sha(s) {
  return createHash("sha256").update(s).digest("hex");
}

/** Sorted-key JSON, so key order can never change the digest. */
function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
}

/**
 * Compute the two-level fingerprint from what was ACTUALLY materialized.
 *
 * @param {object} p
 * @param {string} [p.persona]                 the persona text written into the preset
 * @param {Array<{name:string, body:string}>} [p.skills]
 * @param {Array<{name:string, url?:string, toolFace?:string}>} [p.mcpServers]
 * @param {object|null} [p.toolAllowlist]     server → leaf names (or {byPreset})
 * @param {string|null} [p.model]
 * @param {string|null} [p.provider]
 * @param {string|null} [p.effort]
 * @param {string|null} [p.matrixVersion]     the dsh matrix the child will boot on
 * @returns {{bundle: string, parts: object}}
 */
export function computeRuntimeFingerprint({
  persona = null,
  skills = [],
  mcpServers = [],
  toolAllowlist = null,
  model = null,
  provider = null,
  effort = null,
  matrixVersion = null,
} = {}) {
  // Skills: name + body digest. The BODY is what the model reads; the file path
  // is not behaviour and is deliberately absent.
  const skillParts = [...(skills ?? [])]
    .map((s) => ({ name: String(s?.name ?? ""), sha: sha(normText(s?.body)) }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  // MCP servers: name + endpoint + declared tool face. An endpoint change is a
  // different runtime even when the name is stable (one server, two clusters).
  const mcpParts = [...(mcpServers ?? [])]
    .map((m) => ({ name: String(m?.name ?? m?.id ?? ""), url: String(m?.url ?? ""), toolFace: String(m?.toolFace ?? "") }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  // The allowlist is behavioural: removing a leaf changes what the model can do.
  const allowlistPart = toolAllowlist ? sha(canonical(toolAllowlist)) : null;

  const modelPart = sha(canonical({ model, provider, effort }));
  const matrixPart = matrixVersion ? sha(normText(matrixVersion)) : null;
  const personaPart = sha(normText(persona));

  const parts = {
    persona: personaPart,
    skills: skillParts,
    mcp: mcpParts,
    toolAllowlist: allowlistPart,
    model: modelPart,
    matrix: matrixPart,
  };

  // The bundle digest is over the parts, canonically — so it moves iff a part
  // moves, and a field added later joins the digest by being added to `parts`.
  const bundle = sha(canonical(parts));
  return { bundle, parts };
}

/** Does `parts` contain any part the other does not? (diagnosis helper) */
export function diffFingerprintParts(a, b) {
  const changed = [];
  const keys = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})]);
  for (const k of keys) {
    if (canonical(a?.[k] ?? null) !== canonical(b?.[k] ?? null)) changed.push(k);
  }
  return changed.sort();
}
