// skill-materialize.js — DB custom skills → SKILL.md files in a watched dir.
//
// dsh-skill-filesystem Chokidar-watches every dir in its customSkillDirs and
// hot-reloads SKILL.md add/change/unlink live (no process restart). The DB is
// the durable store; this module mirrors each custom_skills row into a
// <name>/SKILL.md file so the agent sees DB skills exactly like file skills —
// at startup AND on runtime CRUD.
//
// add-pack-agent-scoping: pack-owned rows (originPackId) materialize under a
// per-pack root (custom-skills/packs/<safePackId>/…), because the skills
// patch scopes by listing roots and discovery does not recurse — a pack's
// skills must live in a root of their own to be focusable. User rows keep the
// flat root. The DB stays the durable store: an installed pack re-materializes
// into the pack root on the first boot after upgrade, no user action.
//
// Atomic writes (temp+rename) match documents.js / writeMcpPatch. The dir is a
// runtime artifact under PLATFORM_DATA_DIR (gitignored), rebuilt idempotently
// from the DB on startup.
import { mkdirSync, readlinkSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { basename, join } from "node:path";
import { atomicWriteTextSync } from "./lib/persistence.js";
import { storeDir } from "./paths.js";

const MATERIALIZE_DIR = storeDir("custom-skills");
// The reserved per-pack subtree. safeDir() can produce this segment for a
// skill literally named "packs" — see rebuildFromDb for how the two coexist.
const PACKS_SEGMENT = "packs";
const PACKS_DIR = join(MATERIALIZE_DIR, PACKS_SEGMENT);
// The reserved per-persona subtree INSIDE a pack root (add-persona-resource-
// sets D3). Same coexistence caveat: a pack skill literally named "personas"
// would collide — accepted quirk, mirrored from PACKS_SEGMENT.
export const PERSONAS_SEGMENT = "personas";
// The reserved custom-preset subtree (add-custom-presets D3): one compose
// root per preset under custom-skills/presets/<presetId>/ — symlinks to the
// materialized dirs wherever they live (user root or pack roots). Same
// coexistence caveat as PACKS_SEGMENT, same reconciliation rules.
export const PRESETS_SEGMENT = "presets";
const PRESETS_DIR = join(MATERIALIZE_DIR, PRESETS_SEGMENT);

// Sanitize a skill name into a safe filesystem segment. dsh-skill-filesystem
// keys skills off the frontmatter `name`, not the dir, so the dir name only
// needs to be filesystem-safe and stable across writes.
function safeDir(name) {
  return String(name).replace(/[^A-Za-z0-9._-]/g, "_");
}

// The root holding one pack's materialized skills.
export function packSkillsRoot(packId) {
  return join(PACKS_DIR, safeDir(packId));
}

// Every pack root that exists on disk — the full-mode skills patch lists them
// all (a focused preset lists only its own; see dsh-profile.deriveScope).
export function listPackSkillsRoots() {
  try {
    return readdirSync(PACKS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => join(PACKS_DIR, d.name));
  } catch {
    return []; // no packs subtree yet — nothing installed
  }
}

// The per-persona compose root (add-persona-resource-sets D3):
// packs/<packId>/personas/<agentId>/<skillName> → relative symlink into the
// pack root. Disposable runtime artifact like every root here — rebuilt from
// the durable store on every skills-patch write, never edited in place.
export function personaSkillsRoot(packId, agentId) {
  return join(packSkillsRoot(packId), PERSONAS_SEGMENT, safeDir(agentId));
}

// The per-preset compose root for a custom preset (add-custom-presets D3):
// presets/<presetId>/<skillName> → relative symlink into the user root or
// whichever pack root owns the skill. Same disposable-artifact contract.
export function customPresetSkillsRoot(presetId) {
  return join(PRESETS_DIR, safeDir(presetId));
}

// A row's root: pack-owned rows live under the pack root, user rows flat.
function rootFor(skill) {
  return skill?.originPackId ? packSkillsRoot(skill.originPackId) : MATERIALIZE_DIR;
}

function skillFilePath(skill) {
  return join(rootFor(skill), safeDir(skill.name), "SKILL.md");
}

// Render a custom_skills row into a SKILL.md the filesystem plugin can load.
// The body is the user's `content`; the frontmatter carries name+description.
function renderSkillMd({ name, description, content }) {
  const desc = (description || "").replace(/\n/g, " ");
  return `---\nname: ${name}\ndescription: ${desc}\n---\n\n${content || ""}\n`;
}

// Write one skill's SKILL.md atomically (temp+rename). Returns true on success.
export function writeSkill(skill) {
  if (!skill || !skill.name) return false;
  if (skill.enabled === false) {
    removeSkill(skill);
    return true;
  }
  const file = skillFilePath(skill);
  atomicWriteTextSync(file, renderSkillMd(skill));
  return true;
}

// Remove one skill's materialized dir (Chokidar fires unlink → hot-remove).
// Accepts the row (or a row-shaped { name, originPackId }) so pack-owned
// skills remove from the pack root; a bare string keeps the legacy flat-root
// meaning (user skills).
export function removeSkill(skillOrName) {
  const skill = typeof skillOrName === "string" ? { name: skillOrName } : skillOrName;
  if (!skill?.name) return;
  const dir = join(rootFor(skill), safeDir(skill.name));
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* already gone */ }
}

// Remove a whole pack's root (uninstall). Skills skipped at install never
// materialized here — foreign same-named skills live in other roots and are
// untouched by design. The personas/ subtree lives inside the pack root, so
// it goes with it (add-persona-resource-sets D3).
export function removePackSkills(packId) {
  try { rmSync(packSkillsRoot(packId), { recursive: true, force: true }); } catch { /* already gone */ }
}

// Build (or rebuild) one persona's compose root: a dir of relative symlinks
// `packs/<packId>/personas/<agentId>/<skill>` → the skill's materialized dir.
// Idempotent from the caller-supplied owned rows: only names that are BOTH
// declared and owned-by-this-pack get a link (a declaration naming a skill
// skipped at install — a foreign collision — never materialized, so it
// silently narrows; the install report is the truth, D5). An absent/empty
// declaration yields no root at all (a stale root is removed). Returns the
// root path, or null when nothing should exist.
//
// add-focus-overlay: `declaredSkills` may be null with an `overlay` present —
// the whole-pack owned set is then the base the diff applies over (the forced
// compose-root path for an adjusted undeclared persona). The overlay's
// removeSkills drops members; its addSkills draws from `addableRows` — the
// locally-materialized universe the caller passes (every enabled custom-skill
// row, any pack or the user root) — so a skill owned by ANOTHER pack composes
// into the role through a cross-root link and stops when its pack leaves.
// Adds that resolve to nothing (renamed away, pack uninstalled) are dangling:
// ignored silently with one warn, like the MCP layer.
export function buildPersonaSkillsRoot(packId, agentId, declaredSkills, ownedRows, overlay = null, addableRows = null) {
  const root = personaSkillsRoot(packId, agentId);
  const owned = new Set((ownedRows ?? []).map((r) => r?.name).filter(Boolean));
  const addable = new Map((addableRows ?? []).map((r) => [r?.name, r]).filter(([n]) => n));
  // Declared set when declared; whole-pack ONLY when an overlay adjusts an
  // undeclared persona (the forced compose-root path) — with no overlay the
  // absent-declaration contract stands: no root at all.
  const base = Array.isArray(declaredSkills)
    ? declaredSkills
    : overlay ? [...owned] : [];
  let wanted = [...new Set(base)].filter((n) => owned.has(n));
  let danglingAdds = [];
  if (overlay) {
    const removed = new Set(overlay.removeSkills ?? []);
    wanted = wanted.filter((n) => !removed.has(n));
    for (const name of overlay.addSkills ?? []) {
      if (wanted.includes(name)) continue;
      if (addable.has(name)) wanted.push(name);
      else danglingAdds.push(name);
    }
  }
  // One skill name → its symlink target, relative to the persona root:
  // this pack's own root (`../../<skill>`), another pack's root
  // (`../../../<pack>/<skill>`), or the flat user root (`../../../<skill>`).
  const targetFor = (name) => {
    if (owned.has(name)) return join("..", "..", safeDir(name));
    const row = addable.get(name);
    if (row?.originPackId && row.originPackId !== packId) {
      return join("..", "..", "..", safeDir(row.originPackId), safeDir(name));
    }
    return join("..", "..", "..", safeDir(name));
  };
  if (wanted.length === 0) {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* already gone */ }
    return null;
  }
  if (danglingAdds.length) {
    console.warn(`[skill-materialize] overlay dangling skill adds ignored: [${danglingAdds.join(", ")}]`);
  }
  mkdirSync(root, { recursive: true });
  const wantedDirs = new Set(wanted.map((n) => safeDir(n)));
  // Wipe stale entries (a name dropped from the declaration, or junk).
  let entries = [];
  try { entries = readdirSync(root); } catch { /* root absent */ }
  for (const entry of entries) {
    if (!wantedDirs.has(entry)) {
      try { rmSync(join(root, entry), { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  }
  for (const name of wanted) {
    const link = join(root, safeDir(name));
    const target = targetFor(name);
    let current = null;
    try { current = readlinkSync(link); } catch { /* absent or not a link */ }
    if (current === target) continue; // idempotent — already the right link
    try { rmSync(link, { recursive: true, force: true }); } catch { /* best-effort */ }
    symlinkSync(target, link, "dir");
  }
  return root;
}

// Build (or rebuild) one custom preset's compose root
// (presets/<presetId>/<skill> → relative symlink). The declared set IS the
// row's reference list, and it draws from the WHOLE enabled-materialized
// universe (`enabledRows`, any pack's root or the user root) — the DB rows
// behind those dirs are the availability truth, so a reference whose pack
// uninstalled simply drops out here and returns on reinstall
// (composition-time truth, add-custom-presets D3). The overlay applies the
// same add/remove rules as pack roles; dangling adds warn once and are inert.
// Returns the root path, or null when nothing composes (empty declaration —
// the preset focuses to the baseline alone; a stale root is removed).
export function buildCustomPresetSkillsRoot(presetId, declaredSkills, enabledRows, overlay = null) {
  const root = customPresetSkillsRoot(presetId);
  const addable = new Map((enabledRows ?? []).map((r) => [r?.name, r]).filter(([n]) => n));
  const available = new Set(addable.keys());
  let wanted = [...new Set(declaredSkills ?? [])].filter((n) => available.has(n));
  let danglingAdds = [];
  if (overlay) {
    const removed = new Set(overlay.removeSkills ?? []);
    wanted = wanted.filter((n) => !removed.has(n));
    for (const name of overlay.addSkills ?? []) {
      if (wanted.includes(name)) continue;
      if (addable.has(name)) wanted.push(name);
      else danglingAdds.push(name);
    }
  }
  if (wanted.length === 0) {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* already gone */ }
    return null;
  }
  if (danglingAdds.length) {
    console.warn(`[skill-materialize] overlay dangling skill adds ignored: [${danglingAdds.join(", ")}]`);
  }
  mkdirSync(root, { recursive: true });
  const wantedDirs = new Set(wanted.map((n) => safeDir(n)));
  let entries = [];
  try { entries = readdirSync(root); } catch { /* root absent */ }
  for (const entry of entries) {
    if (!wantedDirs.has(entry)) {
      try { rmSync(join(root, entry), { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  }
  for (const name of wanted) {
    const link = join(root, safeDir(name));
    // presets/<id>/<skill> sits two levels above MATERIALIZE_DIR, so both
    // targets are two `..` hops: the flat user root (`../../<skill>`) or
    // another pack's root (`../../packs/<pack>/<skill>`) — unlike the pack
    // persona root's three-hop layout.
    const row = addable.get(name);
    const target = row?.originPackId
      ? join("..", "..", PACKS_SEGMENT, safeDir(row.originPackId), safeDir(name))
      : join("..", "..", safeDir(name));
    let current = null;
    try { current = readlinkSync(link); } catch { /* absent or not a link */ }
    if (current === target) continue; // idempotent — already the right link
    try { rmSync(link, { recursive: true, force: true }); } catch { /* best-effort */ }
    symlinkSync(target, link, "dir");
  }
  return root;
}

// Remove one custom preset's compose root (preset deletion). Cross-pack
// materialized dirs it linked into are other owners' content — untouched.
export function removeCustomPresetSkills(presetId) {
  try { rmSync(customPresetSkillsRoot(presetId), { recursive: true, force: true }); } catch { /* already gone */ }
}

// Rebuild both materialization roots from the DB: wipe stale entries, write
// every enabled row. Idempotent — safe to call on every startup. Returns the
// list of skills that failed to write (caller may retry).
export function rebuildFromDb(listCustomSkills) {
  let failures = [];
  mkdirSync(MATERIALIZE_DIR, { recursive: true });
  const rows = listCustomSkills() || [];
  const userRows = rows.filter((s) => !s.originPackId);
  const packRows = rows.filter((s) => s.originPackId);

  // Flat root: wipe stale dirs not backed by a current USER row. This is also
  // the no-action migration — pack rows no longer belong here, so their
  // pre-scoping flat dirs are stale by definition and are rewritten into the
  // pack root below. The reserved `packs` and `presets` subtrees are skipped
  // here and reconciled next (packs) / at patch-write time (presets); the one
  // collision (a user skill literally named "packs") materializes as
  // packs/SKILL.md and survives like any user dir.
  const liveFlat = new Set(userRows.map((s) => safeDir(s.name)));
  let entries = [];
  try { entries = readdirSync(MATERIALIZE_DIR); } catch { /* dir absent */ }
  for (const entry of entries) {
    if (entry === PACKS_SEGMENT || entry === PRESETS_SEGMENT) continue;
    if (!liveFlat.has(entry)) {
      try { rmSync(join(MATERIALIZE_DIR, entry), { recursive: true, force: true }); }
      catch { /* best-effort */ }
    }
  }

  // Pack roots: a root with no current rows is stale (uninstalled pack, or
  // junk); inside a live root, skill dirs the pack no longer owns go too
  // (an upgrade that dropped a skill). The reserved personas/ subtree is
  // reconciled by buildPersonaSkillsRoot at patch-write time — skip it here.
  const byPack = new Map();
  for (const s of packRows) {
    const key = safeDir(s.originPackId);
    if (!byPack.has(key)) byPack.set(key, []);
    byPack.get(key).push(s);
  }
  for (const packRoot of listPackSkillsRoots()) {
    const packKey = basename(packRoot);
    if (!byPack.has(packKey)) {
      try { rmSync(packRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
      continue;
    }
    const livePack = new Set(byPack.get(packKey).map((s) => safeDir(s.name)));
    let skillDirs = [];
    try { skillDirs = readdirSync(packRoot); } catch { /* root absent */ }
    for (const d of skillDirs) {
      if (d === PERSONAS_SEGMENT) continue;
      if (!livePack.has(d)) {
        try { rmSync(join(packRoot, d), { recursive: true, force: true }); } catch { /* best-effort */ }
      }
    }
  }

  for (const skill of rows) {
    try {
      if (!writeSkill(skill)) failures.push(skill.name);
    } catch (e) {
      console.warn(`[skill-materialize] write failed for "${skill.name}": ${e.message}`);
      failures.push(skill.name);
    }
  }
  return { dir: MATERIALIZE_DIR, failures };
}

export { MATERIALIZE_DIR };
