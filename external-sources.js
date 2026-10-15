// external-sources.js — Mirror of external skill markets (刀一 read-only shelf;
// 刀二 adds package retrieval for installation).
//
// openspec: add-external-skill-sources (read-only shelf) and
// add-external-skill-install (package fetch). Each external market is an
// adapter implementing list + get (metadata, for the shelf) and fetchPackage
// (the installable artifact). The registry decides which adapters are enabled
// (EXTERNAL_SKILL_SOURCES); a snapshot cache bounds upstream traffic (TTL
// ≤1h) and keeps the last good data on failure (stale-on-failure, the same
// posture registry-bridge established for the self-hosted registry).
//
// Boundary: this module never writes the database, the skill store, or the
// materialization tree — it only fetches, validates and returns package
// contents. The install orchestration (external-install.js) owns the writes.

import JSZip from "jszip";
import yaml from "js-yaml";
import {
  isTextFilePath,
  isScriptFilePath,
  safePackagePath as sharedSafePackagePath,
} from "./lib/skill-files.js";

const SNAPSHOT_TTL_MS = 60 * 60 * 1000; // spec: at most 1 hour
const DEFAULT_PAGE_SIZE = 20; // design D6
const MAX_PAGE_SIZE = 50;

// ── Package limits (刀二 design D3): exceed = fail, never truncate silently.
export const PACKAGE_LIMITS = {
  maxDownloadBytes: 30 * 1024 * 1024, // compressed body cap
  maxFileBytes: 512 * 1024, // one auxiliary text file
  maxTotalAuxBytes: 2 * 1024 * 1024, // all auxiliary files together
  maxAuxFiles: 64,
  maxUnpackedBytes: 50 * 1024 * 1024, // unpacked-bytes cap (zip-bomb guard)
  maxBodyChars: 200_000, // SKILL.md body cap (prompt-injection surface bound)
};

// Text-extension/whitelist/path rules now live in lib/skill-files.js
// (add-packaged-skills D3: one definition shared with the pack-manifest
// validator and the upload endpoints). safePackagePath keeps its exported name
// here — 刀二's importers (tests, install orchestration) are untouched.
export function safePackagePath(rawPath) {
  return sharedSafePackagePath(rawPath);
}

function isJunkPath(relPath) {
  return relPath.startsWith("__MACOSX/") || relPath.endsWith("/.DS_Store") || relPath === ".DS_Store";
}

// Parse a package's file map ({relPath: Buffer|string}) into the normalized
// installable shape. Both adapters deliver their file map through it.
//   → { body, frontmatter, files: {path: text}, inventory: [{path, bytes, script, action}] }
// action: "stored" | "omitted-binary" | "omitted-large"
export function parsePackage(rawFiles) {
  let skillMdPath = null;
  for (const p of Object.keys(rawFiles)) {
    const safe = safePackagePath(p);
    if (safe && /(^|\/)SKILL\.md$/i.test(safe)) {
      // Prefer a root-level SKILL.md; accept the shallowest one.
      if (!skillMdPath || safe.split("/").length < skillMdPath.split("/").length) skillMdPath = safe;
    }
  }
  if (!skillMdPath) {
    throw Object.assign(new Error("package contains no SKILL.md"), { code: "invalid-package" });
  }
  const rawBody = rawFiles[skillMdPath];
  const text = Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : String(rawBody ?? "");
  const { frontmatter, body } = splitFrontmatter(text);
  if (body.length > PACKAGE_LIMITS.maxBodyChars) {
    throw Object.assign(new Error(`SKILL.md body exceeds ${PACKAGE_LIMITS.maxBodyChars} chars`), { code: "limit-exceeded" });
  }

  const files = {};
  const inventory = [];
  let auxCount = 0;
  let auxBytes = 0;
  // The skill body itself is the first inventory row (honest preview).
  inventory.push({ path: skillMdPath, bytes: Buffer.byteLength(text, "utf8"), script: false, action: "stored" });
  for (const [rawPath, data] of Object.entries(rawFiles)) {
    const safe = safePackagePath(rawPath);
    if (!safe || safe === skillMdPath || isJunkPath(safe)) continue;
    const isScript = isScriptFilePath(safe);
    // Adapters may deliver { oversized: true } descriptors instead of bytes
    // (the contents-API path refuses to download huge files and reports them).
    if (data && typeof data === "object" && !Buffer.isBuffer(data) && data.oversized) {
      inventory.push({ path: safe, bytes: Number(data.size) || 0, script: isScript, action: "omitted-large" });
      continue;
    }
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data ?? ""), "utf8");
    const bytes = buf.length;
    if (bytes > PACKAGE_LIMITS.maxFileBytes) {
      inventory.push({ path: safe, bytes, script: isScript, action: "omitted-large" });
      continue;
    }
    const head = buf.subarray(0, 64).toString("utf8");
    if (!isTextFilePath(safe, head)) {
      inventory.push({ path: safe, bytes, script: isScript, action: "omitted-binary" });
      continue;
    }
    auxCount += 1;
    auxBytes += bytes;
    if (auxCount > PACKAGE_LIMITS.maxAuxFiles) {
      throw Object.assign(new Error(`package exceeds ${PACKAGE_LIMITS.maxAuxFiles} auxiliary files`), { code: "limit-exceeded" });
    }
    if (auxBytes > PACKAGE_LIMITS.maxTotalAuxBytes) {
      throw Object.assign(new Error(`package auxiliary files exceed ${PACKAGE_LIMITS.maxTotalAuxBytes} bytes`), { code: "limit-exceeded" });
    }
    files[safe] = buf.toString("utf8");
    inventory.push({ path: safe, bytes, script: isScript, action: "stored" });
  }
  inventory.sort((a, b) => a.path.localeCompare(b.path));
  return { body, frontmatter, files, inventory, skillMdPath };
}

// Split a SKILL.md text into { frontmatter, body }. Malformed YAML yields a
// null frontmatter rather than failing the package (the body still installs).
function splitFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { frontmatter: null, body: text };
  let fm = null;
  try {
    const parsed = yaml.load(m[1]);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) fm = parsed;
  } catch { /* malformed frontmatter: keep the body only */ }
  return { frontmatter: fm, body: text.slice(m[0].length) };
}

export function parseSourceSelection(env, knownIds) {
  const raw = (env ?? "").trim();
  // Unset/empty = all known sources enabled (spec scenario).
  if (!raw) return [...knownIds];
  const wanted = raw.split(",").map((s) => s.trim()).filter(Boolean);
  // Unknown ids are ignored silently (design D6) — a typo must not kill the shelf.
  return knownIds.filter((id) => wanted.includes(id));
}

export function requestedPageSize(env) {
  const n = Number(env);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_PAGE_SIZE;
  return Math.min(Math.floor(n), MAX_PAGE_SIZE);
}

// ── Binary/package outbound fetch (刀二) ──────────────────────────────────────
// The shelf's JSON helper refuses nothing about redirects because its upstreams
// answer directly. Package retrieval DOES get redirected (SkillHub → COS), so
// this variant follows redirects MANUALLY and enforces a per-source host
// allowlist at every hop — a 302 to an arbitrary host must not be chased.
// Returns { body: Buffer, finalUrl }. `fetchImpl` is injectable so tests never
// touch the network (and so the whole package layer shares one transport).
export async function outboundFetchBytes(url, { allowedHosts, headers, signal, fetchImpl = fetch, maxBytes = PACKAGE_LIMITS.maxDownloadBytes } = {}) {
  const timer = AbortSignal.timeout(15_000);
  const composed = signal ? AbortSignal.any([signal, timer]) : timer;
  let current = url;
  for (let hop = 0; hop <= 3; hop += 1) {
    const host = new URL(current).hostname;
    if (allowedHosts && !allowedHosts.some((h) => host === h || host.endsWith(`.${h}`))) {
      throw Object.assign(new Error(`redirect left the allowed hosts (${host})`), { code: "upstream-host-rejected" });
    }
    const res = await fetchImpl(current, {
      signal: composed,
      redirect: "manual",
      headers: {
        "User-Agent": "yizuo-external-skill-sources/1.0 (+https://finddatatech.cloud)",
        ...headers,
      },
    });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) throw new Error(`redirect without location (HTTP ${res.status})`);
      current = new URL(loc, current).toString();
      continue;
    }
    if (!res.ok) {
      throw Object.assign(new Error(`HTTP ${res.status}`), { code: res.status === 404 ? "upstream-not-found" : "upstream-error", status: res.status });
    }
    const body = Buffer.from(await res.arrayBuffer());
    if (body.length > maxBytes) {
      throw Object.assign(new Error(`package exceeds ${maxBytes} bytes`), { code: "limit-exceeded" });
    }
    return { body, finalUrl: current };
  }
  throw Object.assign(new Error("too many redirects"), { code: "upstream-error" });
}

// Unpack an in-memory zip into a {relPath: Buffer} map, enforcing the shared
// path safety (jszip does path normalization of its own — this never trusts
// that it did the right thing).
export async function unzipToMap(buf) {
  const zip = await JSZip.loadAsync(buf);
  const files = {};
  let unpacked = 0;
  for (const [name, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue;
    const safe = safePackagePath(name);
    if (!safe) {
      throw Object.assign(new Error(`package entry escapes the root: ${name}`), { code: "invalid-package" });
    }
    const data = await entry.async("nodebuffer");
    unpacked += data.length;
    if (unpacked > PACKAGE_LIMITS.maxUnpackedBytes) {
      throw Object.assign(new Error(`package unpacks beyond ${PACKAGE_LIMITS.maxUnpackedBytes} bytes`), { code: "limit-exceeded" });
    }
    files[safe] = data;
  }
  return files;
}

// Resolve a repo-relative path the way a tree walk would: normalizes
// `dir/../other` WITHOUT touching the filesystem, and refuses escapes. Used
// for contents-API symlink entries (verified live 2026-10-15: a Smithery
// entry's `.claude/skills` is a symlink to `../.agents/skills`).
export function resolveRepoPath(baseDir, target) {
  const combined = `${baseDir}/${target}`.split("/");
  const out = [];
  for (const seg of combined) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      if (out.length === 0) return null; // escapes the repo root
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return out.join("/");
}

// Resolve a directory path segment-by-segment through the contents API so an
// INTERMEDIATE symlink resolves too (verified live 2026-10-15: a Smithery
// entry path `.claude/skills/commit` hides behind `.claude/skills` being a
// symlink to `../.agents/skills` — a plain GET of the full path 404s). Each
// segment is probed; a symlink answer replaces the resolved prefix with its
// target (bounded budget) and the NEXT segment continues from there.
export async function githubResolveDir(owner, repo, ref, dirPath, { fetchImpl = outboundFetch, followBudget = 6 } = {}) {
  const segs = dirPath.split("/").filter(Boolean);
  let resolved = "";
  let i = 0;
  let budget = followBudget;
  while (i < segs.length) {
    const candidate = resolved ? `${resolved}/${segs[i]}` : segs[i];
    const res = await fetchImpl(
      `https://api.github.com/repos/${owner}/${repo}/contents/${candidate}?ref=${encodeURIComponent(ref)}`,
    );
    if (res.status === 404) {
      throw Object.assign(new Error("entry directory not found in the upstream repository"), { code: "upstream-not-found" });
    }
    if (!res.ok) throw Object.assign(new Error(`github contents HTTP ${res.status}`), { code: "upstream-error" });
    const doc = await res.json();
    if (Array.isArray(doc)) {
      resolved = candidate;
      i += 1;
      continue;
    }
    if (doc?.type === "symlink" && doc.target) {
      if (budget <= 0) throw Object.assign(new Error("symlink chain too deep"), { code: "invalid-package" });
      budget -= 1;
      const target = resolveRepoPath(resolved, doc.target);
      if (!target) {
        throw Object.assign(new Error(`upstream symlink escapes the repository: ${candidate}`), { code: "invalid-package" });
      }
      resolved = target; // the target replaces the symlink segment outright
      i += 1;
      continue;
    }
    throw Object.assign(new Error(`upstream path component is not a directory: ${candidate}`), { code: "invalid-package" });
  }
  return resolved;
}

// Read one resolved directory via the GitHub contents API (public repos,
// unauthenticated, 60 req/h/IP — adequate for installs). Returns entries
// carrying type/size/target. The API reports sizes BEFORE download, which is
// what keeps the limits enforceable without moving bytes.
export async function githubListDir(owner, repo, ref, dirPath, { fetchImpl = outboundFetch } = {}) {
  const resolvedPath = await githubResolveDir(owner, repo, ref, dirPath, { fetchImpl });
  const res = await fetchImpl(
    `https://api.github.com/repos/${owner}/${repo}/contents/${resolvedPath}?ref=${encodeURIComponent(ref)}`,
  );
  if (res.status === 404) {
    throw Object.assign(new Error("entry directory not found in the upstream repository"), { code: "upstream-not-found" });
  }
  if (!res.ok) throw Object.assign(new Error(`github contents HTTP ${res.status}`), { code: "upstream-error" });
  const doc = await res.json();
  if (!Array.isArray(doc)) {
    throw Object.assign(new Error("upstream path is not a directory"), { code: "invalid-package" });
  }
  return doc.map((e) => ({ name: e.name, path: e.path, type: e.type, size: Number(e.size) || 0, target: e.target ?? null, download_url: e.download_url }));
}

// Fetch a directory tree file-by-file from the contents API. Subdirectories
// (dir symlinks resolve inside githubListDir) recurse under the shared depth
// bound; files larger than the per-file cap are NOT downloaded — they surface
// as { oversized: true } descriptors so the inventory stays honest without
// moving the bytes. The returned map is keyed relative to the entry directory.
export async function githubFetchDirFiles(owner, repo, ref, dirPath, { fetchImpl = outboundFetch, depth = 0, prefix = "" } = {}) {
  if (depth > 4) return {}; // tree depth bound
  const entries = await githubListDir(owner, repo, ref, dirPath, { fetchImpl });
  const files = {};
  for (const e of entries) {
    if (e.type === "dir") {
      const nested = await githubFetchDirFiles(owner, repo, ref, e.path, {
        fetchImpl,
        depth: depth + 1,
        prefix: `${prefix}${e.name}/`,
      }).catch(() => null);
      if (nested) Object.assign(files, nested);
      continue;
    }
    if (e.type === "symlink") {
      // A file-level symlink inside the directory: fetch its target instead.
      const target = resolveRepoPath(dirPath, e.target ?? "");
      if (!target) continue; // escaping link — ignore, never chase
      const nested = await githubFetchDirFiles(owner, repo, ref, target, {
        fetchImpl,
        depth: depth + 1,
        prefix: `${prefix}${e.name}/`,
      }).catch(() => null);
      if (nested) Object.assign(files, nested);
      continue;
    }
    if (e.type !== "file" || !e.download_url) continue;
    if (e.size > PACKAGE_LIMITS.maxFileBytes * 4) {
      files[`${prefix}${e.name}`] = { oversized: true, size: e.size };
      continue;
    }
    const res = await fetchImpl(e.download_url, { headers: { Accept: "application/octet-stream" } });
    if (!res.ok) throw Object.assign(new Error(`raw fetch HTTP ${res.status} for ${e.path}`), { code: "upstream-error" });
    files[`${prefix}${e.name}`] = Buffer.from(await res.arrayBuffer());
  }
  return files;
}

// Shared outbound helper (design D7): bounded, credential-free, platform UA.
export async function outboundFetch(url, { signal, headers } = {}) {
  const timer = AbortSignal.timeout(10_000);
  const composed = signal ? AbortSignal.any([signal, timer]) : timer;
  return fetch(url, {
    signal: composed,
    headers: {
      Accept: "application/json",
      "User-Agent": "yizuo-external-skill-sources/1.0 (+https://finddatatech.cloud)",
      ...headers,
    },
  });
}

// ── Snapshot cache ────────────────────────────────────────────────────────────
// Key = request shape (sourceId + op + params). Bad/failed refreshes keep the
// previous { at, data } and flag it stale; a source that has never succeeded
// reports an error state instead of inventing data.

export function createSnapshotCache({ ttlMs = SNAPSHOT_TTL_MS, now = Date.now } = {}) {
  const map = new Map();
  async function resolve(key, loader) {
    const hit = map.get(key);
    // fresh = this call actually ran the loader (first load or past-TTL revalidate)
    if (hit && now() - hit.at < ttlMs && !hit.stale) return { ...hit, fresh: false };
    try {
      const data = await loader();
      const entry = { at: now(), data, stale: false };
      map.set(key, entry);
      return { ...entry, fresh: true };
    } catch (err) {
      if (hit) return { ...hit, stale: true, error: String(err?.message || err) };
      throw err;
    }
  }
  return { resolve, peek: (key) => map.get(key), size: () => map.size };
}

// ── Normalized Entry shape ────────────────────────────────────────────────────
// licenseState: declared / not-declared / unknown (spec: exactly these three)
// versionLayer: which metadata layer a version came from (Tencent's own
// packages carry contradictory versions across layers — recorded, not judged).

export function normalizeEntry({ source, id, name, displayName, description, originUrl, licenseState, licenseText, version, versionLayer, downloads, stars, tags, extras }) {
  return {
    source,
    id: String(id ?? name),
    name: String(name ?? id ?? ""),
    displayName: displayName || name || String(id ?? ""),
    description: String(description ?? "").slice(0, 2000),
    originUrl: originUrl || null,
    licenseState: licenseState === "declared" || licenseState === "not-declared" ? licenseState : "unknown",
    licenseText: licenseText ?? null,
    version: version != null ? String(version) : null,
    versionLayer: versionLayer ?? null,
    downloads: Number.isFinite(downloads) ? downloads : null,
    stars: Number.isFinite(stars) ? stars : null,
    tags: Array.isArray(tags) ? tags.map(String).slice(0, 8) : [],
    extras: extras && typeof extras === "object" ? extras : null,
  };
}

// ── Source adapters ───────────────────────────────────────────────────────────

// Tencent SkillHub (skillhub.cn) — free public REST, no auth (verified live
// 2026-10-14). Search has no cursor/total; the limit param IS the cap. Entries
// carry no license field → licenseState "unknown" (self-descriptions in free
// text are not machine-checkable). originUrl is the market page.
const SKILLHUB_BASE = process.env.SKILLHUB_API_BASE || "https://api.skillhub.cn/api/v1";

export function createSkillhubAdapter({ fetchImpl = outboundFetch } = {}) {
  async function search(q, limit) {
    const url = `${SKILLHUB_BASE}/search?q=${encodeURIComponent(q)}&limit=${limit}`;
    const res = await fetchImpl(url);
    if (!res.ok) throw new Error(`skillhub search HTTP ${res.status}`);
    const doc = await res.json();
    const results = Array.isArray(doc?.results) ? doc.results : [];
    return results.map((r) =>
      normalizeEntry({
        source: "skillhub",
        id: r.slug,
        name: r.slug,
        displayName: r.displayName || r.name || r.slug,
        description: r.description || r.description_zh || r.summary || "",
        originUrl: r.namespace?.publicSlug
          ? `https://skillhub.cn/skills/${r.namespace.publicSlug}`
          : `https://skillhub.cn/skills/${r.slug}`,
        licenseState: "unknown",
        version: r.version ?? null,
        versionLayer: "market-metadata",
        downloads: Number(r.downloads),
        stars: Number(r.stars),
        tags: Array.isArray(r.tags) ? r.tags : [r.category].filter(Boolean),
        extras: { category: r.category ?? null, requiresApiKey: Boolean(r.labels?.requires_api_key) },
      }),
    );
  }
  async function get(slug) {
    const res = await fetchImpl(`${SKILLHUB_BASE}/skills/${encodeURIComponent(slug)}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`skillhub detail HTTP ${res.status}`);
    const r = await res.json();
    const entry = Array.isArray(r) ? r[0] : r?.skill ?? r;
    if (!entry) return null;
    return normalizeEntry({
      source: "skillhub",
      id: entry.slug ?? slug,
      name: entry.slug ?? slug,
      displayName: entry.displayName || entry.name || slug,
      description: entry.description || entry.description_zh || entry.summary || "",
      originUrl: `https://skillhub.cn/skills/${entry.slug ?? slug}`,
      licenseState: "unknown",
      version: entry.version ?? null,
      versionLayer: "market-metadata",
      downloads: Number(entry.downloads),
      stars: Number(entry.stars),
      tags: Array.isArray(entry.tags) ? entry.tags : [entry.category].filter(Boolean),
    });
  }
  // 刀二: the installable artifact is the market's own download endpoint,
  // which 302s to the COS bucket (verified live 2026-10-15). The redirect is
  // followed manually with a per-hop host allowlist — the market host plus
  // its Tencent COS accelerator domain, nothing else.
  async function fetchPackage(slug) {
    const { body } = await outboundFetchBytes(
      `${SKILLHUB_BASE}/download?slug=${encodeURIComponent(slug)}`,
      {
        allowedHosts: ["api.skillhub.cn", "skillhub.cn", "myqcloud.com"],
        headers: { Accept: "application/zip, application/octet-stream" },
        fetchImpl,
      },
    );
    const raw = await unzipToMap(body);
    return parsePackage(raw);
  }
  return { id: "skillhub", displayName: "腾讯 SkillHub", list: search, get, fetchPackage };
}

// Smithery (smithery.ai) — free public read API, no auth (verified live
// 2026-10-14; 25k+ skills). gitUrl points at the upstream repo directory —
// that URL is the honest origin. License lives upstream (LICENSE in the repo),
// not in the API payload → unknown here; 刀二 upgrade path fetches it.
const SMITHERY_BASE = process.env.SMITHERY_API_BASE || "https://api.smithery.ai";

export function createSmitheryAdapter({ fetchImpl = outboundFetch } = {}) {
  async function search(q, limit) {
    const url = `${SMITHERY_BASE}/skills?pageSize=${limit}&q=${encodeURIComponent(q)}`;
    const res = await fetchImpl(url);
    if (!res.ok) throw new Error(`smithery search HTTP ${res.status}`);
    const doc = await res.json();
    const skills = Array.isArray(doc?.skills) ? doc.skills : [];
    return skills.map((s) =>
      normalizeEntry({
        source: "smithery",
        id: s.slug,
        name: s.slug,
        displayName: s.displayName || s.slug,
        description: s.description || "",
        originUrl: s.gitUrl || (s.namespace ? `https://smithery.ai/@${s.namespace}/${s.slug}` : null),
        licenseState: "unknown",
        version: null,
        versionLayer: null,
        downloads: Number(s.totalActivations),
        stars: Number(s.externalStars),
        tags: Array.isArray(s.categories) ? s.categories : [],
        extras: { namespace: s.namespace ?? null, verified: Boolean(s.verified) },
      }),
    );
  }
  async function get(slug) {
    // The read API exposes list + search; a single-slug endpoint is not part
    // of the verified surface. Detail resolves through search on the slug —
    // exact enough for a display card, and the snapshot cache bounds traffic.
    const res = await fetchImpl(`${SMITHERY_BASE}/skills?pageSize=5&q=${encodeURIComponent(slug)}`);
    if (!res.ok) throw new Error(`smithery detail HTTP ${res.status}`);
    const doc = await res.json();
    const hit = (doc?.skills ?? []).find((s) => s.slug === slug);
    if (!hit) return null;
    return normalizeEntry({
      source: "smithery",
      id: hit.slug,
      name: hit.slug,
      displayName: hit.displayName || hit.slug,
      description: hit.description || "",
      originUrl: hit.gitUrl || null,
      licenseState: "unknown",
      version: null,
      versionLayer: null,
      downloads: Number(hit.totalActivations),
      stars: Number(hit.externalStars),
      tags: Array.isArray(hit.categories) ? hit.categories : [],
      extras: { namespace: hit.namespace ?? null, verified: Boolean(hit.verified) },
    });
  }
  // 刀二: the installable artifact lives at the entry's gitUrl — a directory
  // inside a GitHub repository. FETCHING STRATEGY: the whole-repo tarball was
  // measured wrong for this ecosystem (a 2KB skill in a monorepo pulled 38MB;
  // codeload has no subtree endpoint), so files come from the contents API
  // one by one — the API reports each file's size BEFORE download, which keeps
  // the limits enforceable without moving bytes. The 404 case is REAL: entries
  // go stale upstream (verified live 2026-10-15 — `frontend-design`'s
  // directory was deleted while its shelf entry lived on), so a missing dir
  // fails closed with a named reason instead of installing a half-package.
  async function fetchPackage(slug) {
    const entry = await get(slug);
    const gitUrl = entry?.originUrl;
    if (!gitUrl) {
      throw Object.assign(new Error("entry has no upstream repository URL"), { code: "upstream-not-found" });
    }
    const parsed = parseGitTreeUrl(gitUrl);
    if (!parsed) {
      throw Object.assign(new Error(`unsupported upstream URL shape: ${gitUrl}`), { code: "upstream-not-found" });
    }
    const { owner, repo, ref, subPath } = parsed;
    // gitUrl may lack a ref; the contents API resolves HEAD by default when
    // ref is omitted from the query, so an absent ref stays absent.
    try {
      const raw = await githubFetchDirFiles(owner, repo, ref ?? "HEAD", subPath, { fetchImpl });
      return parsePackage(raw);
    } catch (err) {
      if (err.code === "upstream-not-found") {
        throw Object.assign(new Error(`upstream directory not found: ${gitUrl}`), { code: "upstream-not-found", cause: err });
      }
      throw err;
    }
  }
  return { id: "smithery", displayName: "Smithery", list: search, get, fetchPackage };
}

// Parse the repository-directory URL shapes Smithery's gitUrl carries:
//   https://github.com/<owner>/<repo>/tree/<ref>/<path…>
//   https://github.com/<owner>/<repo>/blob/<ref>/<path…>      (file — path's dirname wins)
// Returns { owner, repo, ref, subPath } or null when the URL is not one of these.
export function parseGitTreeUrl(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (u.hostname !== "github.com") return null;
  const parts = u.pathname.split("/").filter(Boolean);
  if (parts.length < 5) return null; // owner/repo/(tree|blob)/ref/path…
  const [owner, repo, kind, ref, ...rest] = parts;
  if (kind !== "tree" && kind !== "blob") return null;
  let subPath = rest.join("/");
  if (kind === "blob" && subPath.includes(".")) {
    // A file URL: the skill directory is its dirname.
    subPath = subPath.split("/").slice(0, -1).join("/");
  }
  if (!owner || !repo || !subPath) return null;
  return { owner, repo, ref, subPath };
}

// ── Source registry ───────────────────────────────────────────────────────────

export function createExternalSourceRegistry({ env = process.env, cache, fetchImpl } = {}) {
  const snapshot = cache ?? createSnapshotCache();
  const all = [
    createSkillhubAdapter({ fetchImpl }),
    createSmitheryAdapter({ fetchImpl }),
  ];
  const knownIds = all.map((a) => a.id);
  const enabledIds = parseSourceSelection(env.EXTERNAL_SKILL_SOURCES, knownIds);
  const adapters = all.filter((a) => enabledIds.includes(a.id));

  // list/get through the snapshot cache (key = request shape, design D2).
  async function list(adapter, query, limit) {
    const key = `${adapter.id}:list:${query}:${limit}`;
    return snapshot.resolve(key, () => adapter.list(query, limit));
  }
  async function get(adapter, slug) {
    const key = `${adapter.id}:get:${slug}`;
    return snapshot.resolve(key, () => adapter.get(slug));
  }

  // Package cache (刀二 design D4): a MUCH shorter TTL than metadata — its
  // only job is making preview→confirm a single download. Capped so the memory
  // face stays bounded; insertion-order eviction (Map semantics) drops the
  // oldest entry past the cap. Failures are never cached: an install that
  // failed must retry from scratch, not re-serve a remembered error.
  const PACKAGE_TTL_MS = 10 * 60 * 1000;
  const PACKAGE_CACHE_MAX = 5;
  const packageCache = new Map();
  async function fetchPackage(adapter, slug) {
    const key = `${adapter.id}:package:${slug}`;
    const hit = packageCache.get(key);
    if (hit && Date.now() - hit.at < PACKAGE_TTL_MS) return hit.data;
    if (hit) packageCache.delete(key);
    const data = await adapter.fetchPackage(slug); // throws propagate — nothing cached
    packageCache.set(key, { at: Date.now(), data });
    if (packageCache.size > PACKAGE_CACHE_MAX) {
      packageCache.delete(packageCache.keys().next().value);
    }
    return data;
  }

  return {
    enabled: adapters.map((a) => ({ id: a.id, displayName: a.displayName })),
    isEnabled: (id) => enabledIds.includes(id),
    searchAll: async (query, limit) => {
      const settled = await Promise.allSettled(
        adapters.map(async (a) => {
          const out = await list(a, query, limit);
          return {
            source: a.id,
            sourceDisplayName: a.displayName,
            entries: out.data,
            stale: Boolean(out.stale),
            snapshotAt: out.at,
            error: out.error ?? null,
            // A never-succeeded source surfaces its error; a stale one keeps
            // serving the last good snapshot (spec posture).
            failed: !out.stale && out.error != null ? out.error : null,
          };
        }),
      );
      // allSettled over snapshot-resolve: resolve() itself keeps stale data on
      // failure, so rejected promises here mean a source with NO prior
      // snapshot — surfaced as a failed group, never crashing the response.
      return settled.map((s, i) =>
        s.status === "fulfilled"
          ? s.value
          : {
              source: adapters[i].id,
              sourceDisplayName: adapters[i].displayName,
              entries: [],
              stale: false,
              snapshotAt: null,
              error: String(s.reason?.message || s.reason),
              failed: String(s.reason?.message || s.reason),
            },
      );
    },
    getEntry: async (sourceId, slug) => {
      const adapter = adapters.find((a) => a.id === sourceId);
      if (!adapter) return null;
      const out = await get(adapter, slug);
      return out
        ? { entry: out.data, stale: Boolean(out.stale), snapshotAt: out.at }
        : null;
    },
    // 刀二: package retrieval for the install path. Disabled/unknown source →
    // null (the route turns that into a 404); a real fetch failure THROWS
    // (the route maps its `code`). Cache-bounded per design D4.
    fetchPackage: async (sourceId, slug) => {
      const adapter = adapters.find((a) => a.id === sourceId);
      if (!adapter) return null;
      return fetchPackage(adapter, slug);
    },
  };
}
