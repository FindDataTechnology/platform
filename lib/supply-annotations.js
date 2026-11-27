// ── Supply annotation overlay (add-mcp-annotation-overlay) ──────────────────
//
// One annotation per supply object (MCP server / MCP tool / skill): a `human`
// track set (zh MAIN track required; en/ja/es/fr secondary optional) plus an
// optional `canonical` brief for the agent-facing side (consumed at runtime by
// add-tool-description-enrichment) and a provenance mark. Zero-dependency leaf
// (same discipline as lib/pack-locale.js) — imported by the gateway process
// and the cell's extension read faces, so it must not pull a module graph.
//
// Projection rules (shared with pack-locale): the requested locale's track
// wins, missing fields fall back to the zh track, zh is the only fallback
// endpoint. An unannotated object projects to null — callers render the raw
// upstream text unchanged (byte-identical default path).

import { normalizeLocale } from "./pack-locale.js";

export const ANNOTATION_KINDS = ["mcp-server", "mcp-tool", "skill"];
export const ANNOTATION_LOCALES = ["zh", "en", "ja", "es", "fr"];

const NAME_CHARS = 60;
const SUMMARY_CHARS = 200;
const WHEN_CHARS = 160;
const BRIEF_CHARS = 300; // mirrors the pack description cap discipline

function plainObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function nonEmptyString(v, cap) {
  return typeof v === "string" && v.trim().length > 0 && v.length <= cap;
}

// One locale track: { name, summary, whenToUse? } — name/summary required,
// whenToUse optional (何时用 is part of the template, filled when meaningful).
function validateTrack(track, errors, entry) {
  if (!plainObject(track)) {
    errors.push(`${entry} must be an object of { name, summary, whenToUse? }`);
    return false;
  }
  let ok = true;
  for (const key of Object.keys(track)) {
    if (key !== "name" && key !== "summary" && key !== "whenToUse") {
      errors.push(`${entry} has unknown key '${key}' (only name, summary, whenToUse)`);
      ok = false;
    }
  }
  if (!nonEmptyString(track.name, NAME_CHARS)) {
    errors.push(`${entry}.name must be a non-empty string of at most ${NAME_CHARS} characters`);
    ok = false;
  }
  if (!nonEmptyString(track.summary, SUMMARY_CHARS)) {
    errors.push(`${entry}.summary must be a non-empty string of at most ${SUMMARY_CHARS} characters`);
    ok = false;
  }
  if (track.whenToUse !== undefined && !nonEmptyString(track.whenToUse, WHEN_CHARS)) {
    errors.push(`${entry}.whenToUse must be a non-empty string of at most ${WHEN_CHARS} characters`);
    ok = false;
  }
  return ok;
}

// Validate one annotation shape. The zh MAIN track is mandatory (an
// annotation without it is rejected wholesale — it would strand zh readers).
// `canonical` is optional; `provenance` records { source, updatedAt }.
export function validateAnnotation(raw, entry = "annotation") {
  const errors = [];
  if (!plainObject(raw)) return { ok: false, error: `${entry} must be an object` };

  const known = new Set(["human", "canonical", "provenance", "tools"]);
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) errors.push(`${entry} has unknown key '${key}' (only human, canonical, provenance, tools)`);
  }
  if (!plainObject(raw.human)) {
    return { ok: false, error: `${entry}.human must be an object mapping locale tags to tracks` };
  }
  const human = raw.human;
  if (!plainObject(human.zh)) {
    return { ok: false, error: `${entry}.human.zh (the zh MAIN track) is required` };
  }
  for (const locale of Object.keys(human)) {
    if (!ANNOTATION_LOCALES.includes(locale)) {
      errors.push(`${entry}.human has unknown locale '${locale}' (only ${ANNOTATION_LOCALES.join(", ")})`);
      continue;
    }
    validateTrack(human[locale], errors, `${entry}.human.${locale}`);
  }
  if (raw.canonical !== undefined) {
    if (!plainObject(raw.canonical) || Object.keys(raw.canonical).some((k) => k !== "brief")) {
      errors.push(`${entry}.canonical must be an object of { brief }`);
    } else if (!nonEmptyString(raw.canonical.brief, BRIEF_CHARS)) {
      errors.push(`${entry}.canonical.brief must be a non-empty string of at most ${BRIEF_CHARS} characters`);
    }
  }
  if (raw.provenance !== undefined) {
    if (!plainObject(raw.provenance) || !nonEmptyString(raw.provenance.source, 40)) {
      errors.push(`${entry}.provenance must carry a non-empty source (at most 40 characters)`);
    }
  }
  if (raw.tools !== undefined) {
    if (!plainObject(raw.tools)) {
      errors.push(`${entry}.tools must be an object mapping tool leaf names to annotations`);
    } else {
      for (const [leaf, toolAnnotation] of Object.entries(raw.tools)) {
        const result = validateAnnotation(toolAnnotation, `${entry}.tools['${leaf}']`);
        if (!result.ok) errors.push(result.error);
      }
    }
  }
  if (errors.length) return { ok: false, error: errors.join("; ") };
  return { ok: true, annotation: raw };
}

// Field-wise merge across the two curated sources: the registry's annotation
// (higher precedence — it is the shared truth both planes read) wins over the
// repo catalog on every present field; provenance follows the winner. Tool
// sub-annotations merge per leaf the same way. Either side may be absent;
// both absent → null (the caller renders raw upstream text).
export function mergeAnnotations({ registry, catalog } = {}) {
  const hasRegistry = plainObject(registry);
  const hasCatalog = plainObject(catalog);
  if (!hasRegistry && !hasCatalog) return null;
  if (!hasRegistry) return withSource(catalog, "catalog");
  if (!hasCatalog) return withSource(registry, "registry");

  const merged = {
    human: { ...catalog.human },
    ...(catalog.canonical !== undefined ? { canonical: catalog.canonical } : {}),
    ...(catalog.provenance !== undefined ? { provenance: catalog.provenance } : {}),
  };
  for (const locale of Object.keys(registry.human || {})) {
    merged.human[locale] = { ...(merged.human[locale] || {}), ...registry.human[locale] };
  }
  if (registry.canonical !== undefined) merged.canonical = registry.canonical;
  // Provenance follows the winner: the registry contributed (it outranks the
  // catalog), so its own mark wins and otherwise the merged mark is registry.
  merged.provenance = { ...(registry.provenance || {}) };
  if (!merged.provenance.source) merged.provenance.source = "registry";
  if (registry.tools !== undefined || catalog.tools !== undefined) {
    const tools = { ...(catalog.tools || {}) };
    for (const [leaf, toolAnnotation] of Object.entries(registry.tools || {})) {
      tools[leaf] = mergeAnnotations({ registry: toolAnnotation, catalog: tools[leaf] }) ?? toolAnnotation;
    }
    merged.tools = tools;
  }
  return withSource(merged, "registry");
}

function withSource(annotation, fallbackSource) {
  if (!plainObject(annotation)) return null;
  return {
    ...annotation,
    provenance: { ...(annotation.provenance || {}), source: annotation.provenance?.source || fallbackSource },
  };
}

// Resolve one annotation for display in `locale`: the locale's track wins per
// field, every missing field falls back to the zh track (zh 唯一回落), and an
// unannotated object projects to null. Never mutates the source.
export function projectAnnotation(annotation, locale) {
  if (!plainObject(annotation) || !plainObject(annotation.human) || !plainObject(annotation.human.zh)) return null;
  const tag = normalizeLocale(locale) || "zh";
  const zh = annotation.human.zh;
  const track = tag === "zh" ? zh : plainObject(annotation.human[tag]) ? annotation.human[tag] : null;
  const pick = (field) => (track && track[field]) || zh[field] || null;
  return {
    name: pick("name"),
    summary: pick("summary"),
    whenToUse: pick("whenToUse"),
    source: annotation.provenance?.source ?? null,
  };
}
