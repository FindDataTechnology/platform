// ── Repo annotation source (add-mcp-annotation-overlay D7) ──────────────────
//
// The registry row's metadata.annotations is the first curated annotation
// source, but it is size-capped (64KB) and editing it through the production
// API gives no diff and no review. The committed root file
// `market-annotations.json` is the second source of truth: GitOps-able and
// big enough for five-language annotations of 161-tool surfaces. Keys are
// registry entry names (the registry-bridge pathToName result — no leading
// slash); values run through the SAME validateAnnotation as every annotation
// source, so there is no second shape rule.
//
// Zero-dependency leaf module (same discipline as lib/pack-locale.js): both
// the gateway process and the facet process import it through
// registry-bridge.js, so it must not pull a module graph. The file path is
// passed IN by the caller (the bridge resolves it via bundledJson) — this
// module resolves no paths of its own.
//
// Degradation, never a throw (readJsonOr discipline, mcp-annotation-source-
// requirements §B): a missing or corrupt file yields an empty table — entries
// render unannotated (raw upstream text), exactly like before the file
// existed. An invalid entry is dropped with a warn naming it; its siblings
// survive.

import fs from "node:fs";

import { validateAnnotation } from "./supply-annotations.js";

// Process cache keyed by (file, stat): re-parse only when the resolved file's
// mtime changes (or its existence flips). The bridge hits this once per
// refresh tick; mapServer reads the cached map per entry.
let cache = null; // { file, statKey, map, skillsMap }

function statKeyOf(file) {
  try {
    const st = fs.statSync(file);
    return st.isFile() ? `mtime:${st.mtimeMs}` : "not-a-file";
  } catch {
    return "missing";
  }
}

function entriesOf(doc) {
  return doc && typeof doc === "object" && !Array.isArray(doc) ? doc.entries : null;
}

// Read → validate → index-by-name. Returns a Map<name, annotation>; invalid
// entries are dropped with a warn. Missing file: empty map, silent (the normal
// "no curation shipped" state). Unreadable/unparsable: empty map + warn.
export function loadRepoAnnotations(file) {
  if (!file || typeof file !== "string") return new Map();
  const key = statKeyOf(file);
  if (cache && cache.file === file && cache.statKey === key) return cache.map;

  let doc = null;
  try {
    doc = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.warn(`[market-annotations] ${file} unparsable, rendering unannotated: ${err.message}`);
    }
    cache = { file, statKey: key, map: new Map(), skillsMap: new Map() };
    return cache.map;
  }

  const map = new Map();
  const skillsMap = new Map();
  const entries = entriesOf(doc);
  if (!entries || typeof entries !== "object" || Array.isArray(entries)) {
    console.warn(`[market-annotations] ${file} has no object 'entries', rendering unannotated`);
  } else {
    if (doc.version !== undefined && doc.version !== 1) {
      console.warn(`[market-annotations] ${file} unknown version ${JSON.stringify(doc.version)}, reading anyway`);
    }
    for (const [name, entry] of Object.entries(entries)) {
      const annotation = entry && typeof entry === "object" ? entry.annotation : undefined;
      const result = validateAnnotation(annotation, `market-annotations entries['${name}']`);
      if (!result.ok) {
        console.warn(`[market-annotations] ${file}: dropping '${name}': ${result.error}`);
        continue;
      }
      map.set(name, annotation);
    }
  }
  // Skill domain (add-skill-display-annotations): the `skills` key indexes
  // skill display annotations by skill name, each value carrying its `origin`
  // ("registry" | "yizuo-file") beside the same-shape annotation. Same
  // validateAnnotation gate as every other source; invalid entries drop with
  // a warn and their siblings survive.
  const rawSkills = doc && typeof doc === "object" && !Array.isArray(doc) ? doc.skills : null;
  // `!= null` on purpose: an ABSENT skills key is the normal pre-skill state
  // and must stay silent — only a present-but-non-object key warns.
  if (rawSkills != null && (typeof rawSkills !== "object" || Array.isArray(rawSkills))) {
    console.warn(`[market-annotations] ${file} has a non-object 'skills', skipping skill annotations`);
  } else if (rawSkills) {
    for (const [name, val] of Object.entries(rawSkills)) {
      const origin = val && typeof val === "object" ? val.origin : undefined;
      if (origin !== "registry" && origin !== "yizuo-file") {
        console.warn(`[market-annotations] ${file}: dropping skills['${name}']: origin must be "registry" or "yizuo-file"`);
        continue;
      }
      const result = validateAnnotation(val.annotation, `market-annotations skills['${name}']`);
      if (!result.ok) {
        console.warn(`[market-annotations] ${file}: dropping skills['${name}']: ${result.error}`);
        continue;
      }
      skillsMap.set(name, { origin, annotation: val.annotation });
    }
    // Cross-key guard (double insurance promised by the reconciliation doc):
    // a name in both `entries` (servers) and `skills` cannot route — the
    // server entry wins and the skill annotation is dropped with a warn.
    for (const name of skillsMap.keys()) {
      if (map.has(name)) {
        console.warn(`[market-annotations] ${file}: skills['${name}'] collides with entries['${name}'], dropping the skill side`);
        skillsMap.delete(name);
      }
    }
  }
  cache = { file, statKey: key, map, skillsMap };
  return map;
}

// Look up one curated annotation by registry entry name. Safe before any load
// (returns undefined → the merge point treats it as absent).
export function getRepoAnnotation(name) {
  if (!cache || !name) return undefined;
  return cache.map.get(name);
}

// Look up one curated skill annotation by skill name. Returns
// { origin, annotation } or undefined (absent = render raw, never invent).
export function getRepoSkillAnnotation(name) {
  if (!cache || !name) return undefined;
  return cache.skillsMap.get(name);
}

// The whole skills table (both domains in one namespace — consumers look up
// by name, never by origin; add-skill-display-annotations 3.1). Callers MUST
// treat this as read-only. Empty map before any load / without the file.
export function listRepoSkillAnnotations() {
  return cache?.skillsMap ?? new Map();
}

// Test seam: drop the process cache so the next load re-reads.
export function resetRepoAnnotationsCache() {
  cache = null;
}
