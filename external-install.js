// external-install.js — install an external-market skill into this platform
// (add-external-skill-install 刀二, design D4/D5/D6).
//
// Two operations, both server-side:
//   previewInstall(...)  fetch the package and describe what WOULD install
//   performInstall(...)  the actual write: DB row + materialized directory
//
// Consent is enforced at the ROUTE (the caller must have passed confirm), but
// this module is written so that performInstall is the ONLY writer: nothing
// here runs on a preview, and every failure path leaves the platform untouched
// (the package is fully parsed and validated BEFORE the first DB write).
//
// Name normalization (design D5) exists because the runtime's skill-name
// grammar is `^[a-z0-9]+(-[a-z0-9]+)*$` and a non-matching skill file is
// silently ignored — an external name with capitals would install an invisible
// skill. The original upstream name survives in origin_meta for display.

const BODY_EXCERPT_CHARS = 1500;
const MAX_SKILL_NAME = 64;

// Runtime grammar: lowercase alnum runs joined by single hyphens.
export function normalizeSkillName(raw) {
  const folded = String(raw ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  if (!folded) return null;
  return folded.slice(0, MAX_SKILL_NAME).replace(/-+$/, "");
}

// Fold the package's parsed frontmatter into what the DB should store: the
// upstream map minus the keys the runtime parser THROWS on (a legacy camelCase
// invocation key anywhere in the file makes dsh drop the whole skill), and
// minus name/description which the row always owns.
const REJECTED_FRONTMATTER_KEYS = new Set(["disableModelInvocation", "modelInvocable", "userInvocable", "name", "description"]);

export function sanitizeFrontmatter(frontmatter) {
  if (!frontmatter || typeof frontmatter !== "object") return null;
  const out = {};
  for (const [k, v] of Object.entries(frontmatter)) {
    if (REJECTED_FRONTMATTER_KEYS.has(k)) continue;
    out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : null;
}

function excerpt(body) {
  const text = String(body ?? "").trim();
  if (text.length <= BODY_EXCERPT_CHARS) return text;
  return `${text.slice(0, BODY_EXCERPT_CHARS)}…`;
}

// Build the preview document from a fetched package + the entry metadata.
export function buildPreview({ source, slug, entry, pack }) {
  const normalizedName = normalizeSkillName(slug);
  return {
    source,
    slug,
    normalizedName,
    upstreamName: entry?.name ?? slug,
    displayName: entry?.displayName ?? slug,
    originUrl: entry?.originUrl ?? null,
    version: entry?.version ?? null,
    licenseState: entry?.licenseState ?? "unknown",
    licenseText: entry?.licenseText ?? null,
    bodyExcerpt: excerpt(pack.body),
    hasScripts: pack.inventory.some((f) => f.script && f.action === "stored"),
    files: pack.inventory.map((f) => ({ path: f.path, bytes: f.bytes, script: f.script, action: f.action })),
  };
}

// Preview: fetch + parse + describe. Read-only by construction — no store and
// no materializer are involved.
export async function previewInstall({ source, slug, registry }) {
  const pack = await registry.fetchPackage(source, slug);
  if (!pack) {
    throw Object.assign(new Error(`Unknown or disabled source: ${source}`), { code: "unknown-source", status: 404 });
  }
  const entry = await registry.getEntry(source, slug).then((r) => r?.entry ?? null).catch(() => null);
  return buildPreview({ source, slug, entry, pack });
}

// The install itself. Steps are ordered so nothing observable happens until
// the package is fully validated: fetch → validate → resolve target row →
// write DB → materialize. `deps` is injected for tests.
export async function performInstall({ source, slug, registry, store, materialize, dbReady }) {
  if (!dbReady()) {
    throw Object.assign(new Error("Extensions management is disabled (database unavailable)"), { code: "db-unavailable", status: 503 });
  }
  const pack = await registry.fetchPackage(source, slug); // throws: disabled source → null handled by route; upstream errors carry .code
  if (!pack) {
    throw Object.assign(new Error(`Unknown or disabled source: ${source}`), { code: "unknown-source", status: 404 });
  }
  const name = normalizeSkillName(slug);
  if (!name) {
    throw Object.assign(new Error(`Entry name "${slug}" contains no usable characters after normalization`), { code: "invalid-name", status: 422 });
  }
  const entry = await registry.getEntry(source, slug).then((r) => r?.entry ?? null).catch(() => null);

  const existing = store.getCustomSkill(name);
  let replaced = false;
  if (existing) {
    const meta = existing.originMeta;
    const ownedByThisEntry = meta?.kind === "external" && meta?.source === source && meta?.slug === slug;
    if (!ownedByThisEntry) {
      throw Object.assign(
        new Error(`A skill named "${name}" already exists (origin: ${existing.originPackId ? `pack ${existing.originPackId}` : meta?.kind === "external" ? `external ${meta.source}/${meta.slug}` : "user"})`),
        { code: "name-conflict", status: 409 },
      );
    }
    replaced = true;
  }

  const description = entry?.description || pack.frontmatter?.description || "";
  const originMeta = {
    kind: "external",
    source,
    slug,
    originUrl: entry?.originUrl ?? null,
    upstreamName: entry?.name ?? slug,
    upstreamVersion: entry?.version ?? null,
  };
  const payload = {
    description,
    content: pack.body,
    files: Object.keys(pack.files).length > 0 ? pack.files : null,
    frontmatter: sanitizeFrontmatter(pack.frontmatter),
    originMeta,
  };
  const row = replaced
    ? store.updateCustomSkill(name, payload)
    : store.addCustomSkill({ name, enabled: true, ...payload });
  // Materialize last: a materialization failure leaves a valid DB row that the
  // next boot's rebuildFromDb re-attempts (the DB is the durable store).
  materialize.writeSkill(row);
  return { skill: row, replaced };
}
