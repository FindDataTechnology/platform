// ── Cell-side runtime fingerprint (harden-agent-runtime-spine, runtime-fingerprint) ─
//
// The pure rules live in `lib/runtime-fingerprint.js`. This module is only the
// place that gathers — from the CELL's own composed artifacts — the inputs
// those rules hash. Same discipline as `work-lease.js` / `work-lease-store.js`:
// rules testable without a filesystem, gathering testable without re-deriving
// the rules.
//
// Why read the FILES and not the catalog entry: the cell's `mcp.patch.yml`, the
// member patch, the skills roots and the generated preset definitions are what
// the child actually composes from. A registry entry can drift from that (a
// failed roster refresh, a stale cache) and the drift is exactly the thing a
// fingerprint exists to expose.
//
// Every read degrades to "absent" rather than throwing: a fingerprint with a
// missing part is still a stable identity for that (incomplete) configuration,
// and the read face can say which part was absent. Throwing here would take a
// turn down for a diagnostic.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { computeRuntimeFingerprint } from "./runtime-fingerprint.js";

/** Read one file as text; absent is `null`, never an empty string. */
function readIfPresent(p) {
  try {
    if (!p || !existsSync(p)) return null;
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

/** `[[name, body]]` for every `SKILL.md` directly under a root. */
export function readSkillBodies(root) {
  const out = [];
  try {
    if (!root || !existsSync(root)) return out;
    for (const ent of readdirSync(root, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      const p = path.join(root, ent.name, "SKILL.md");
      try {
        if (existsSync(p) && statSync(p).isFile()) out.push({ name: ent.name, body: readFileSync(p, "utf8") });
      } catch { /* one unreadable skill must not void the fingerprint */ }
    }
  } catch { /* absent root ⇒ no skills, stated */ }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * Gather + compute. Inputs are the cell's own paths and the effective model
 * selection; anything unreadable is `null` and reaches the digest as absent.
 *
 * @param {object} p
 * @param {string|null} [p.mcpPatchPath]         the composed shared/member MCP patch
 * @param {string|null} [p.skillsPatchPath]      the skills patch (carries customSkillDirs)
 * @param {Array<string>} [p.skillRoots]         roots the child will scan
 * @param {Array<{id:string, persona?:string}>} [p.presetDefs]  generated preset definitions
 * @param {string|null} [p.presetId]             the preset this turn will run
 * @param {string|null} [p.model]
 * @param {string|null} [p.provider]
 * @param {string|null} [p.effort]
 * @param {string|null} [p.matrixVersion]
 */
export function fingerprintForCell({
  mcpPatchPath = null,
  skillsPatchPath = null,
  skillRoots = [],
  presetDefs = [],
  presetId = null,
  model = null,
  provider = null,
  effort = null,
  matrixVersion = null,
} = {}) {
  // Skill roots: the caller may pass them, or the skills patch may name them.
  // One source wins — the file, when present, because that is what the child
  // reads; a caller-supplied list is the fallback for a deployment that
  // composes skills another way.
  const roots = skillRoots.length ? skillRoots : readSkillRootsFromPatch(skillsPatchPath);
  const skills = roots.flatMap((r) => readSkillBodies(r));

  // MCP: the patch file is a fixed tiny shape, so the servers are pulled out
  // TEXTUALLY (no YAML dependency in this module). Hashing the raw text would
  // make a re-indented or re-commented patch look like a new version; pulling
  // `{name, url}` pairs is what keeps the digest about behaviour.
  const mcpText = readIfPresent(mcpPatchPath);
  const mcpServers = extractMcpServers(mcpText);

  // Persona: the preset this turn runs. Absent preset ⇒ persona absent (the
  // standard preset's text is the shipped one, not this deployment's choice).
  const def = presetId ? presetDefs.find((d) => d?.id === presetId) ?? null : null;
  const persona = def?.persona ?? null;

  return computeRuntimeFingerprint({
    persona,
    skills,
    mcpServers,
    // The allowlist is not on this side (the tool filter patch is), so it is
    // absent here and stated as such — a fingerprint must never invent one.
    toolAllowlist: null,
    model,
    provider,
    effort,
    matrixVersion,
  });
}

/**
 * Pull `{name, url}` pairs out of an MCP patch file without a YAML dependency
 * in this module (the patch is a tiny fixed shape: a list of `insert` rows with
 * `id`/`name`/`config.serverName`/`config.url`).
 *
 * Deliberately textual: a parse failure must yield `[]` (absent), not throw,
 * and a comment or blank line must never produce a phantom server.
 */
export function extractMcpServers(text) {
  if (!text) return [];
  const out = [];
  let cur = null;
  for (const raw of String(text).split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const server = /^serverName:\s*(.+)$/.exec(line);
    if (server) {
      if (cur) out.push(cur);
      cur = { name: unquote(server[1]), url: "" };
      continue;
    }
    const url = /^url:\s*(.+)$/.exec(line);
    if (url && cur) cur.url = unquote(url[1]);
  }
  if (cur) out.push(cur);
  // Server name is the identity; url rides along. A row with no name is not a
  // server (a malformed patch states that by having no name).
  return out.filter((s) => s.name).map((s) => ({ name: s.name, url: s.url, toolFace: "" }));
}

/** `[root, ...]` from a skills patch (`customSkillDirs`), absent ⇒ []. */
export function readSkillRootsFromPatch(skillsPatchPath) {
  const text = readIfPresent(skillsPatchPath);
  if (!text) return [];
  const out = [];
  let inList = false;
  for (const raw of String(text).split("\n")) {
    const line = raw.replace(/\t/g, "  ");
    if (/^\s*#/.test(line)) continue;
    if (/customSkillDirs:\s*$/.test(line)) {
      inList = true;
      continue;
    }
    if (!inList) continue;
    const m = /^\s*-\s*(.+)$/.exec(line);
    if (!m) {
      // A non-list line ends the block (the patch is `[{config:{...}}]`).
      if (line.trim() && !/^\s*$/.test(line) && !/^\s*(config|id|name|insert|-)\b/.test(line)) inList = false;
      continue;
    }
    out.push(unquote(m[1]));
  }
  return out.filter(Boolean);
}

function unquote(v) {
  const s = String(v ?? "").trim();
  if ((s.startsWith("'") && s.endsWith("'")) || (s.startsWith('"') && s.endsWith('"'))) return s.slice(1, -1);
  return s;
}
