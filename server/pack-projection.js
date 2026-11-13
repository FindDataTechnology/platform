// ── Pack projection IR (openspec: add-pack-bundle-projection, tasks 1.1–1.3) ─
//
// A pack's capability set is portable across harnesses; its ORCHESTRATION is
// not. This module is the single place that decides which is which:
//
//   manifest snapshot ──► IR { skills, personas, mcpRefs, dshCompat, displayMeta }
//                              │
//                              ├─► .yizpack      (existing container, unchanged)
//                              ├─► dsh bundle    (npm package: skills/ + presets/)
//                              └─► desktop preset manifest ({bundles:[{file, sha256}]})
//
// Why an IR at all (design D1): three adapters reading the manifest directly
// would each carry their own "what may leave" rule, and the safest rule is the
// one nobody remembers to replicate. Boundary decisions live HERE, once;
// adapters may only re-serialise what this module already allowed.
//
// Boundary (design D1 + the change's What Changes):
//   MAY leave    skills (body + files + frontmatter), personas (persona text +
//                its resource subset), MCP references (registry NAME + optional
//                tool allowlist), display metadata.
//   MUST NOT     fleet orchestration, console declarations, bots, plugin
//                demands, pricing/billing keys, and — at any depth — endpoints
//                or credential material.
//
// Pure: no filesystem, no network, no env. Deterministic: every list is sorted
// and every string is newline/encoding-normalised, so two runs on two machines
// produce one digest (task 3.2).

/** The only keys an IR document may carry (asserted by the boundary test). */
export const IR_KEYS = Object.freeze(["skills", "personas", "mcpRefs", "dshCompat", "displayMeta"]);

/**
 * Top-level manifest sections that never travel. `fleet` and `console` are
 * REFUSED (a pack that carries them is asking the projection to ship control
 * surface); `bots`/`plugins` are only DROPPED — they are deployment supply
 * decisions, and a pack that declares them is still a legal pack.
 */
export const PROJECTION_REFUSE_SECTIONS = Object.freeze(["fleet", "console", "pricing", "billing", "billingKey", "billingKeys"]);
export const PROJECTION_DROP_SECTIONS = Object.freeze(["bots", "plugins", "mcpTools", "visibility"]);

/** Keys that mean "an endpoint or a credential", refused at ANY depth. */
export const PROJECTION_FORBIDDEN_KEYS = Object.freeze([
  "baseUrl",
  "apiKey",
  "apiKeyEnv",
  "apiKeyEnvVar",
  "token",
  "secret",
  "password",
  "headers",
  "authorization",
  "command",
  "args",
  "endpoint",
  "webhook",
  "dsn",
]);

/**
 * The compatibility range the generated envelopes declare (design D3). dsh is
 * still in rc, so the coupling is written INTO the artifact rather than left to
 * a reader of our docs. Bumping the matrix means editing this constant — not
 * reshaping the envelope.
 */
export const DEFAULT_DSH_COMPAT = ">=0.2.0-rc.2 <0.3.0";

function norm(text) {
  // Encoding/newline normalisation is part of determinism: a CRLF checkout must
  // not change the digest of a pack that never changed.
  return String(text ?? "").replace(/\r\n?/g, "\n");
}

function sortedObject(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return obj;
  return Object.fromEntries(Object.keys(obj).sort().map((k) => [k, sortedObject(obj[k])]));
}

function walk(value, path, hits) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const [i, item] of value.entries()) walk(item, `${path}[${i}]`, hits);
    return;
  }
  for (const [key, inner] of Object.entries(value)) {
    const at = path ? `${path}.${key}` : key;
    if (PROJECTION_FORBIDDEN_KEYS.includes(key)) hits.push(at);
    walk(inner, at, hits);
  }
}

/**
 * Boundary half — run BEFORE projecting (task 1.2). Returns violations with the
 * field path, so the operator fixes one line instead of hunting.
 *
 * Note the split with lib/pack-manifest.js: that validator answers "is this a
 * legal pack?" (fleet/console are legal there — that is how a team template
 * ships). THIS answers "may this leave the platform?", which is stricter. Two
 * questions, two functions; folding them together would either reject legal
 * packs at install or let control surface out through the projector.
 *
 * @returns {{error: string, path?: string, code: string}[]}
 */
export function validateProjectionBoundary(manifest) {
  const errors = [];
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return [{ error: "a projection needs a manifest object", code: "projection_needs_manifest" }];
  }
  for (const section of PROJECTION_REFUSE_SECTIONS) {
    if (manifest[section] !== undefined) {
      errors.push({
        error: `'${section}' never leaves the platform (the outbound envelope carries capability only — orchestration, control surface and billing stay here)`,
        path: section,
        code: "projection_forbidden_section",
      });
    }
  }
  const hits = [];
  for (const [key, value] of Object.entries(manifest)) {
    // Sections that are refused or dropped are reported above; scanning them
    // again would double-report the same field.
    if (PROJECTION_REFUSE_SECTIONS.includes(key) || PROJECTION_DROP_SECTIONS.includes(key)) continue;
    walk(value, key, hits);
  }
  for (const hit of hits) {
    errors.push({
      error: "an endpoint or credential may not appear anywhere in an outbound envelope",
      path: hit,
      code: "projection_forbidden_key",
    });
  }
  return errors;
}

/**
 * Parse the `>=A <B` form we emit. Deliberately tiny: the generator writes the
 * range, so supporting semver's full grammar here would be pretending to read
 * ranges we never produce. A range we cannot parse is an ERROR, not a pass.
 */
function parseRange(range) {
  const text = String(range ?? "").trim();
  const m = /^>=\s*([0-9A-Za-z.+-]+)\s*<\s*([0-9A-Za-z.+-]+)$/.exec(text);
  if (!m) return null;
  return { min: m[1], max: m[2] };
}

/** Compare two `x.y.z[-pre]` versions. Returns -1/0/1, or null when unparsable. */
export function compareVersions(a, b) {
  const parse = (v) => {
    const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(v ?? "").trim());
    if (!m) return null;
    return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ?? "" };
  };
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i++) {
    if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] < pb.nums[i] ? -1 : 1;
  }
  // A prerelease sorts BEFORE the release it precedes (semver 11.3).
  if (pa.pre === pb.pre) return 0;
  if (!pa.pre) return 1;
  if (!pb.pre) return -1;
  // Identifier-wise (semver 11.4): numeric identifiers compare numerically, so
  // `rc.10` is NEWER than `rc.2`. Plain string comparison gets this backwards,
  // and dsh ships exactly this shape of rc numbering.
  const ia = pa.pre.split(".");
  const ib = pb.pre.split(".");
  for (let i = 0; i < Math.max(ia.length, ib.length); i++) {
    const x = ia[i];
    const y = ib[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) {
      const d = Number(x) - Number(y);
      if (d !== 0) return d < 0 ? -1 : 1;
      continue;
    }
    if (nx !== ny) return nx ? -1 : 1; // numeric identifiers sort before alphanumeric
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * Task 1.3: the declared range must CONTAIN the matrix version we actually bake.
 * A pack projected against a runtime the deployment does not ship would install
 * cleanly and fail at load — the exact silent state this check prevents.
 *
 * @returns {{ok: boolean, reason?: string}}
 */
export function checkDshCompat({ range = DEFAULT_DSH_COMPAT, matrixVersion } = {}) {
  const parsed = parseRange(range);
  if (!parsed) return { ok: false, reason: `unparsable dshCompat range '${range}' (expected '>=X <Y')` };
  if (!matrixVersion) return { ok: false, reason: "no matrix version given — supply cannot be proven" };
  const lo = compareVersions(matrixVersion, parsed.min);
  const hi = compareVersions(matrixVersion, parsed.max);
  if (lo === null || hi === null) {
    return { ok: false, reason: `unparsable version '${matrixVersion}' (matrix) against range '${range}'` };
  }
  if (lo < 0) return { ok: false, reason: `matrix version ${matrixVersion} is below dshCompat ${range}` };
  if (hi >= 0) return { ok: false, reason: `matrix version ${matrixVersion} is at or above dshCompat ${range}` };
  return { ok: true };
}

/**
 * Projection half — `manifest snapshot → IR` (task 1.1). Throws nothing: the
 * caller validates first (`validateProjectionBoundary`) and decides.
 *
 * Dropped sections are reported so a caller can be honest about them rather
 * than silently shipping "less than the pack declares" with no record.
 */
export function projectManifestToIR(manifest, { dshCompat = DEFAULT_DSH_COMPAT } = {}) {
  const skills = (Array.isArray(manifest?.skills) ? manifest.skills : [])
    .filter((s) => s && typeof s.name === "string")
    .map((s) => ({
      name: s.name,
      description: typeof s.description === "string" ? norm(s.description) : "",
      content: norm(s.content),
      ...(s.files && typeof s.files === "object" ? { files: sortedObject(s.files) } : {}),
      ...(s.frontmatter && typeof s.frontmatter === "object" ? { frontmatter: sortedObject(s.frontmatter) } : {}),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const personas = (Array.isArray(manifest?.agents) ? manifest.agents : [])
    .filter((a) => a && typeof a.id === "string")
    .map((a) => ({
      id: a.id,
      name: typeof a.name === "string" ? norm(a.name) : a.id,
      persona: norm(a.persona),
      // The resource subset is a narrowing of the pack's OWN capabilities, so it
      // travels with the persona; tool allowlists ride the MCP references.
      ...(a.resources && typeof a.resources === "object" ? { resources: sortedObject(a.resources) } : {}),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  const mcpRefs = (Array.isArray(manifest?.mcpServers) ? manifest.mcpServers : [])
    .filter((m) => m && typeof m.registryName === "string")
    .map((m) => ({
      registryName: m.registryName,
      ...(Array.isArray(m.allowTools) && m.allowTools.length > 0 ? { allowTools: [...m.allowTools].sort() } : {}),
      ...(m.fullSurface === true ? { fullSurface: true } : {}),
      ...(m.fullSurfaceReason ? { fullSurfaceReason: norm(m.fullSurfaceReason) } : {}),
    }))
    .sort((a, b) => a.registryName.localeCompare(b.registryName));

  const displayMeta = {
    name: norm(manifest?.name),
    description: norm(manifest?.description),
    version: Number.isInteger(manifest?.version) ? manifest.version : Number(manifest?.version) || 1,
    ...(Array.isArray(manifest?.tags) && manifest.tags.length > 0 ? { tags: [...manifest.tags].sort() } : {}),
    ...(manifest?.licence ? { licence: norm(manifest.licence) } : {}),
    ...(manifest?.i18n && typeof manifest.i18n === "object" ? { i18n: sortedObject(manifest.i18n) } : {}),
  };

  // Exactly the five IR keys — nothing else. Sections that were dropped are a
  // REPORT about the source, not part of the projection, so they come back from
  // `droppedSections()` instead of riding inside the IR (an IR with an extra key
  // would eventually be read as meaning something).
  return { skills, personas, mcpRefs, dshCompat, displayMeta };
}

/** Sections present in the source that a projection deliberately did not carry. */
export function droppedSections(manifest) {
  return PROJECTION_DROP_SECTIONS.filter((section) => manifest?.[section] !== undefined);
}

// ── The three envelopes (tasks 2.1 / 2.2 / 2.3) ─────────────────────────────
//
// One source (the immutable manifest snapshot), three serialisations. The
// BOUNDARY is not uniform, and pretending otherwise would break the platform:
//
//   .yizpack      PLATFORM envelope. It carries the full manifest, fleet template
//                 included, because another 壹座 cell/desktop re-installs it and
//                 a team template without its orchestration is a different
//                 product. So it is the snapshot verbatim — byte-identical to
//                 what the existing import pipeline already consumes.
//   dsh bundle    CROSS-HARNESS envelope. Capability only: skills + presets +
//                 display metadata. No patch layer (design D2), no endpoint, no
//                 credential — it may be consumed by a runtime we do not own.
//   desktop list  The bakery's manifest: which baked files exist and their
//                 digests. No content, no capability decisions.

import { createHash } from "node:crypto";

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

/**
 * `.yizpack` adapter (task 2.1). Delegates to the existing builder so the bytes
 * cannot drift; the returned bytes are identical to calling `buildBundle` with
 * the same arguments (the test asserts it).
 */
export async function toYizpackEnvelope({ packId, version, manifest, files = {}, origin = null }, { buildBundle } = {}) {
  if (typeof buildBundle !== "function") {
    throw Object.assign(new Error("toYizpackEnvelope needs the existing buildBundle (server/offline-bundle.js)"), {
      code: "projection_needs_builder",
    });
  }
  return buildBundle({ packId, version, manifest, files, ...(origin ? { origin } : {}) });
}

/** One SKILL.md body for a projected skill (frontmatter is the pack's own). */
function skillFile(skill) {
  const fm = skill.frontmatter && typeof skill.frontmatter === "object" ? skill.frontmatter : null;
  if (!fm) return `${skill.content}\n`;
  const lines = ["---"];
  for (const key of Object.keys(fm).sort()) {
    const value = fm[key];
    lines.push(`${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
  }
  lines.push("---", "");
  return `${lines.join("\n")}${skill.content}\n`;
}

/**
 * dsh envelope (task 2.2): an npm-package-shaped tree as `{path: content}`.
 * Deliberately produces NO `cordis.patch.yml`: a patch layer can insert loader
 * entries, i.e. take over a runtime we do not own (design D2).
 *
 * @returns {{ files: Record<string,string>, packageJson: object }}
 */
export function toDshBundle(ir) {
  const files = {};
  for (const skill of ir.skills) {
    files[`skills/${skill.name}/SKILL.md`] = skillFile(skill);
    for (const [rel, body] of Object.entries(skill.files ?? {})) {
      files[`skills/${skill.name}/${String(rel).replace(/^\.?\//, "")}`] = String(body);
    }
  }
  for (const persona of ir.personas) {
    files[`presets/${persona.id}.json`] = `${JSON.stringify(
      {
        id: persona.id,
        name: persona.name,
        persona: persona.persona,
        ...(persona.resources ? { resources: persona.resources } : {}),
      },
      null,
      2,
    )}\n`;
  }
  const slug =
    String(ir.displayMeta.name || "pack")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "pack";
  const packageJson = {
    name: `@pack/${slug}`,
    version: `0.${ir.displayMeta.version}.0`,
    description: ir.displayMeta.description,
    // The envelope points the runtime at ITSELF as the only bundle. A consumer
    // adds nothing else — what it composes around this is its own decision.
    // The envelope composes ITSELF and nothing else: what a consumer adds around
    // it is the consumer's decision, not something a shipped artifact dictates.
    dsh: { profile: { bundles: [`@pack/${slug}`] }, compat: ir.dshCompat },
    files: ["skills", "presets"],
  };
  return { files, packageJson };
}

/**
 * Desktop preset manifest (task 2.3): file names and digests only. Anything more
 * would be a second source of truth about content.
 *
 * @param {{file: string, bytes: Buffer|string}[]} entries
 */
export function toDesktopPresetManifest(entries = []) {
  const bundles = (Array.isArray(entries) ? entries : [])
    .filter((e) => e && typeof e.file === "string" && e.file)
    .map((e) => ({
      file: e.file,
      sha256: sha256(Buffer.isBuffer(e.bytes) ? e.bytes : Buffer.from(String(e.bytes ?? ""), "utf8")),
    }))
    .sort((a, b) => a.file.localeCompare(b.file));
  return { bundles };
}
