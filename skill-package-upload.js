// skill-package-upload.js — install a user-uploaded skill package (zip) into
// this platform (add-packaged-skills D7, entry 1 of 4: 设置→技能).
//
// Two operations, both server-side, both on ONE parse (external-install.js's
// shape, a different source):
//   previewUpload(...)  unzip + parse + describe what WOULD install
//   performUpload(...)  the actual write: DB row + materialized directory
//
// The zip travels through the same unzipToMap → parsePackage pipeline the
// external line uses — identical guards (path escape, zip-bomb, per-file,
// count, aggregate, text whitelist), identical limits (PACKAGE_LIMITS). The
// consent gate for script-bearing packages is enforced at the ROUTE and here:
// performUpload refuses without `confirm` when the package carries scripts.
//
// Name policy (刀二 parity): the runtime's grammar is
// `^[a-z0-9]+(-[a-z0-9]+)*$` and a non-matching skill is silently ignored, so
// the final name is always normalized (form field > SKILL.md frontmatter >
// zip filename); the original name survives in origin_meta for display.
// Platform record wins name/description — they are the row's own fields; the
// stored frontmatter is sanitizeFrontmatter's output (runtime-hostile keys
// and name/description stripped; renderSkillMd re-injects from the row).

import { unzipToMap, parsePackage, PACKAGE_LIMITS } from "./external-sources.js";
import { normalizeSkillName, sanitizeFrontmatter } from "./external-install.js";

const BODY_EXCERPT_CHARS = 1500;

export const ORIGIN_KIND = "package-upload";

function excerpt(body) {
  const text = String(body ?? "").trim();
  if (text.length <= BODY_EXCERPT_CHARS) return text;
  return `${text.slice(0, BODY_EXCERPT_CHARS)}…`;
}

// Unzip + parse with the size guards ordered so nothing is read beyond the
// caps: compressed size first, then the unpacked-bytes walk inside unzipToMap,
// then parsePackage's per-file/count/aggregate limits.
async function parseBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw Object.assign(new Error("no package file received"), { code: "invalid-package", status: 400 });
  }
  if (buffer.length > PACKAGE_LIMITS.maxDownloadBytes) {
    throw Object.assign(
      new Error(`package exceeds ${PACKAGE_LIMITS.maxDownloadBytes} compressed bytes`),
      { code: "limit-exceeded", status: 413 },
    );
  }
  const rawFiles = await unzipToMap(buffer);
  return parsePackage(rawFiles);
}

// The normalized platform name this upload would take. Precedence: the form
// field, the SKILL.md frontmatter's name, the zip filename.
function resolveName({ fieldsName, frontmatter, fileName }) {
  const raw = String(fieldsName ?? "").trim()
    || (typeof frontmatter?.name === "string" ? frontmatter.name.trim() : "")
    || String(fileName ?? "").replace(/\.zip$/i, "");
  return normalizeSkillName(raw);
}

export async function previewUpload({ buffer, fileName, fields = {} }) {
  const pack = await parseBuffer(buffer);
  const name = resolveName({ fieldsName: fields.name, frontmatter: pack.frontmatter, fileName });
  if (!name) {
    throw Object.assign(new Error("the package yields no usable skill name (give one in the form)"), { code: "invalid-name", status: 422 });
  }
  return {
    name,
    upstreamName: pack.frontmatter?.name ?? String(fileName ?? ""),
    description: String(fields.description ?? "").trim() || pack.frontmatter?.description || "",
    bodyExcerpt: excerpt(pack.body),
    hasScripts: pack.inventory.some((f) => f.script && f.action === "stored"),
    storedFileCount: pack.inventory.filter((f) => f.action === "stored").length - 1, // SKILL.md itself
    files: pack.inventory.map((f) => ({ path: f.path, bytes: f.bytes, script: f.script, action: f.action })),
  };
}

// Seed mode (add-packaged-skills 4.4): the pack EDITOR's direct-upload button.
// Returns the full parsed package — body, files, frontmatter — because a draft
// skill entry must carry the whole tree into the published manifest. The
// caller uploaded this zip themselves, so handing the parsed contents back to
// the authoring surface is not a disclosure.
export async function seedUpload({ buffer, fileName, fields = {} }) {
  const pack = await parseBuffer(buffer);
  const name = resolveName({ fieldsName: fields.name, frontmatter: pack.frontmatter, fileName });
  if (!name) {
    throw Object.assign(new Error("the package yields no usable skill name (give one in the form)"), { code: "invalid-name", status: 422 });
  }
  return {
    name,
    upstreamName: pack.frontmatter?.name ?? String(fileName ?? ""),
    description: String(fields.description ?? "").trim() || pack.frontmatter?.description || "",
    content: pack.body,
    files: Object.keys(pack.files).length > 0 ? pack.files : null,
    frontmatter: sanitizeFrontmatter(pack.frontmatter),
  };
}

export async function performUpload({ buffer, fileName, fields = {}, store, materialize, dbReady }) {
  if (!dbReady()) {
    throw Object.assign(new Error("Extensions management is disabled (database unavailable)"), { code: "db-unavailable", status: 503 });
  }
  const pack = await parseBuffer(buffer);
  const hasScripts = pack.inventory.some((f) => f.script && f.action === "stored");
  // Multipart form fields arrive as strings ("true"), JSON bodies as booleans.
  const confirmed = fields.confirm === true || fields.confirm === "true";
  if (hasScripts && !confirmed) {
    throw Object.assign(
      new Error("This package carries executable script files; explicit confirmation is required to install it"),
      { code: "script-confirm-required", status: 400 },
    );
  }
  const name = resolveName({ fieldsName: fields.name, frontmatter: pack.frontmatter, fileName });
  if (!name) {
    throw Object.assign(new Error("the package yields no usable skill name (give one in the form)"), { code: "invalid-name", status: 422 });
  }

  const existing = store.getCustomSkill(name);
  let replaced = false;
  if (existing) {
    const ownedByUpload = existing.originMeta?.kind === ORIGIN_KIND;
    if (!ownedByUpload) {
      throw Object.assign(
        new Error(`A skill named "${name}" already exists (origin: ${existing.originPackId ? `pack ${existing.originPackId}` : existing.originMeta?.kind === "external" ? `external ${existing.originMeta.source}/${existing.originMeta.slug}` : "user"})`),
        { code: "name-conflict", status: 409 },
      );
    }
    replaced = true;
  }

  const payload = {
    description: String(fields.description ?? "").trim() || pack.frontmatter?.description || "",
    content: pack.body,
    files: Object.keys(pack.files).length > 0 ? pack.files : null,
    frontmatter: sanitizeFrontmatter(pack.frontmatter),
    originMeta: {
      kind: ORIGIN_KIND,
      fileName: String(fileName ?? ""),
      upstreamName: pack.frontmatter?.name ?? null,
    },
  };
  const row = replaced
    ? store.updateCustomSkill(name, payload)
    : store.addCustomSkill({ name, enabled: true, ...payload });
  // Materialize last: a materialization failure leaves a valid DB row the
  // next boot's rebuildFromDb re-attempts (the DB is the durable store).
  materialize.writeSkill(row);
  return { skill: row, replaced };
}
