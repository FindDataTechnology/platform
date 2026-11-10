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
//
// Update (chat-interaction-round2) adds two more, both keyed by the INSTALLED
// skill's name (its origin_meta supplies the upstream source/slug):
//   previewUpdate(...)   fetch + diff the current package against the snapshot
//   performUpdate(...)   the replace write, with the local name pinned

import { createHash } from "node:crypto";

const BODY_EXCERPT_CHARS = 1500;
const MAX_SKILL_NAME = 64;

// ── Update (chat-interaction-round2) ────────────────────────────────────────
// Explicit in-place update of an installed external skill. The skill's LOCAL
// NAME is pinned (an upstream rename never spawns a second skill); everything
// is fetched and parsed before the first write, so failures leave the installed
// snapshot untouched (stale-on-failure).

function hashText(text) {
  return createHash("sha256").update(String(text ?? ""), "utf8").digest("hex");
}

function dbUnavailableError() {
  return Object.assign(new Error("Extensions management is disabled (database unavailable)"), { code: "db-unavailable", status: 503 });
}

// Resolve an installed row to its external origin, refusing anything that was
// not installed from an external source (user/pack skills have no origin to
// fetch back).
function requireExternalOrigin(row, name) {
  const meta = row?.originMeta;
  if (meta?.kind !== "external" || !meta?.source || !meta?.slug) {
    throw Object.assign(new Error(`Skill "${name}" was not installed from an external source`), { code: "not-external", status: 400 });
  }
  return meta;
}

// Three-bucket diff of the installed snapshot vs the fetched package: body,
// frontmatter, and the aux-file map. Unchanged entries ride along so the UI can
// show the whole picture; `changed` is the one-glance verdict.
function diffSnapshot(row, pack) {
  const storedFiles = row.files && typeof row.files === "object" ? row.files : {};
  const files = [];
  const counts = { added: 0, removed: 0, changed: 0, unchanged: 0 };
  for (const p of new Set([...Object.keys(storedFiles), ...Object.keys(pack.files)])) {
    const was = storedFiles[p];
    const now = pack.files[p];
    let status;
    if (was === undefined) status = "added";
    else if (now === undefined) status = "removed";
    else status = hashText(was) === hashText(now) ? "unchanged" : "changed";
    counts[status] += 1;
    files.push({ path: p, status, bytes: Buffer.byteLength(String(now ?? was ?? ""), "utf8") });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  const bodyStatus = hashText(row.content) === hashText(pack.body) ? "unchanged" : "changed";
  const frontmatterStatus =
    JSON.stringify(row.frontmatter ?? null) === JSON.stringify(sanitizeFrontmatter(pack.frontmatter)) ? "unchanged" : "changed";
  return {
    changed: bodyStatus === "changed" || frontmatterStatus === "changed" || counts.added + counts.removed + counts.changed > 0,
    bodyStatus,
    frontmatterStatus,
    counts,
    files,
  };
}

// Update preview: fetch + diff, read-only by construction (no store write, no
// materializer).
export async function previewUpdate({ name, registry, store, dbReady }) {
  if (!dbReady()) throw dbUnavailableError();
  const row = store.getCustomSkill(String(name));
  if (!row) {
    throw Object.assign(new Error(`No installed skill named "${name}"`), { code: "unknown-skill", status: 404 });
  }
  const meta = requireExternalOrigin(row, row.name);
  const pack = await registry.fetchPackage(meta.source, meta.slug); // throws: upstream errors carry .code; disabled source → null below
  if (!pack) {
    throw Object.assign(new Error(`Unknown or disabled source: ${meta.source}`), { code: "unknown-source", status: 404 });
  }
  const entry = await registry.getEntry(meta.source, meta.slug).then((r) => r?.entry ?? null).catch(() => null);
  return {
    name: row.name,
    source: meta.source,
    slug: meta.slug,
    originUrl: entry?.originUrl ?? meta.originUrl ?? null,
    upstreamName: entry?.name ?? meta.upstreamName ?? meta.slug,
    currentVersion: meta.upstreamVersion ?? null,
    upstreamVersion: entry?.version ?? null,
    licenseState: entry?.licenseState ?? "unknown",
    bodyExcerpt: excerpt(pack.body),
    hasScripts: pack.inventory.some((f) => f.script && f.action === "stored"),
    diff: diffSnapshot(row, pack),
  };
}

// The update itself, ordered like performInstall: everything is fetched and
// parsed BEFORE the first write, so any failure leaves the installed snapshot
// untouched. Same-row replace (no name-conflict path exists here — the row IS
// the target), same materialization path, hot-reload via the watched dir.
export async function performUpdate({ name, registry, store, materialize, dbReady }) {
  if (!dbReady()) throw dbUnavailableError();
  const row = store.getCustomSkill(String(name));
  if (!row) {
    throw Object.assign(new Error(`No installed skill named "${name}"`), { code: "unknown-skill", status: 404 });
  }
  const meta = requireExternalOrigin(row, row.name);
  const pack = await registry.fetchPackage(meta.source, meta.slug);
  if (!pack) {
    throw Object.assign(new Error(`Unknown or disabled source: ${meta.source}`), { code: "unknown-source", status: 404 });
  }
  const entry = await registry.getEntry(meta.source, meta.slug).then((r) => r?.entry ?? null).catch(() => null);

  const originMeta = {
    kind: "external",
    source: meta.source,
    slug: meta.slug,
    originUrl: entry?.originUrl ?? meta.originUrl ?? null,
    upstreamName: entry?.name ?? meta.upstreamName ?? meta.slug,
    upstreamVersion: entry?.version ?? null,
  };
  const payload = {
    description: entry?.description || pack.frontmatter?.description || "",
    content: pack.body,
    files: Object.keys(pack.files).length > 0 ? pack.files : null,
    frontmatter: sanitizeFrontmatter(pack.frontmatter),
    originMeta,
  };
  const updated = store.updateCustomSkill(row.name, payload);
  materialize.writeSkill(updated); // materializer sweeps aux files the new set dropped
  return { skill: updated };
}

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
