// ── Desktop update core (add-desktop-in-app-update) ──────────────────────────
//
// Electron-free core of the desktop in-app update lifecycle — everything the
// electron-bound shell (updater.js) needs EXCEPT the electron-updater client
// itself, so node --test can pin the decisions:
//
//   - the channel decision: Windows runs the real updater; macOS unsigned
//     builds DEGRADE to notify-only (Gatekeeper refuses unsigned auto-swaps —
//     宁提示不假绿), signed mac builds may be flipped on by the host later.
//   - release metadata: parse electron-builder's latest.yml / latest-mac.yml
//     (version + file list with sha512), pick the newest version, compare
//     against the running version (semver-ish three-way).
//   - the download URL of an asset for a given platform/arch from the yml.
//
// The static lane contract (spec desktop-app-update): the lane serves
// latest.yml (win NSIS) and latest-mac.yml (dmg) beside the installers;
// entries carry url/path + sha512 — the client verifies what it downloads
// through electron-updater's built-in hash check (win) and by surfacing the
// checksummed URL for manual download (mac notify-only).

// The lane: served from the public download host (harden-desktop-release-lane).
// It used to point at a tailnet-only host, so every client installed from the
// public download page failed its check silently. The internal address is still
// available for machines that cannot reach the public host, but it is read from
// the environment (DESKTOP_UPDATE_INTERNAL_FALLBACK) rather than baked in: this
// module ships in the OSS drop, and an internal host in source is both an
// infrastructure leak and the reason the file used to be excluded — which left
// the shipped updater.js importing a module that was not there.
export const DEFAULT_UPDATE_URL = process.env.DESKTOP_UPDATE_URL || "https://platform.finddatatech.cloud/dl/platform/lane";
export const INTERNAL_UPDATE_URL = process.env.DESKTOP_UPDATE_INTERNAL_FALLBACK || "";

// Should this platform run the real auto-update flow? Windows NSIS: yes.
// macOS: only when the host says the build is signed (autoUpdater on an
// unsigned mac hard-fails mid-download — the honest posture is notify-only).
export function autoUpdateSupported({ platform, signed = false, appImage = false } = {}) {
  if (platform === "win32") return true;
  if (platform === "darwin") return Boolean(signed);
  // Linux: only when we really ARE an AppImage (electron-updater needs the
  // APPIMAGE path to rename over). An extracted/unpacked run has no file to
  // swap, so it degrades to notify-only like an unsigned mac.
  if (platform === "linux") return Boolean(appImage);
  return false;
}

// The lane metadata file a platform reads. electron-updater's naming, which our
// generator mirrors.
export function laneMetadataFor(platform) {
  if (platform === "darwin") return "latest-mac.yml";
  if (platform === "linux") return "latest-linux.yml";
  return "latest.yml";
}

// Pick the artifact that matches the RUNNING architecture. Before this, the
// mac notify-only path took files[0] — which is arm64 because the CI matrix
// lists it first — so every Intel Mac was pointed at an arm64 dmg it cannot
// run (harden-desktop-release-lane 3.1). A single-artifact lane is used as-is
// (nothing to choose), and a multi-artifact lane with no match returns null so
// the caller can say "no package for this machine" instead of guessing.
// Extension per platform, so a mixed-up lane can never hand a mac client an
// AppImage (or vice versa): the metadata files are per-platform, but a single
// wrong file on the host must not become a wrong INSTALL.
export function platformExtensions(platform = process.platform) {
  if (platform === "darwin") return [".dmg", ".pkg", ".zip"];
  if (platform === "linux") return [".appimage", ".deb", ".rpm"];
  return [".exe", ".msi"];
}

export function pickArtifactForArch(files, arch = process.arch, platform = process.platform) {
  const exts = platformExtensions(platform);
  const onPlatform = (files ?? []).filter((f) => exts.some((e) => String(f?.url || "").toLowerCase().endsWith(e)));
  const archRe = arch === "arm64" ? /[-_.]arm64(?:[-_.]|$)/i : /[-_.]x64(?:[-_.]|$)/i;
  const anyArch = /[-_.](arm64|x64|universal)(?:[-_.]|$)/i;
  return (
    onPlatform.find((f) => archRe.test(String(f?.url || "")) || /[-_.]universal(?:[-_.]|$)/i.test(String(f?.url || ""))) ??
    onPlatform.find((f) => !anyArch.test(String(f?.url || ""))) ??
    null
  );
}

export function chooseUpdateArtifact({ meta, arch = process.arch, platform = process.platform } = {}) {
  const files = meta?.files ?? [];
  if (!files.length) return null;
  return pickArtifactForArch(files, arch, platform);
}

// Notify-only degrade: fetch the platform's lane metadata and compare versions,
// never download or install (mac unsigned builds, and Linux runs that are not
// an AppImage — nothing to swap in either case). Returns { available, url, version } | null (lane
// unreachable / malformed — the caller logs and stays silent per spec).
export async function macNotifyCheck({ channelUrl, currentVersion, fetchImpl = fetch, arch = process.arch, platform = "darwin", metadata = "latest-mac.yml" }) {
  const base = String(channelUrl || "").replace(/\/+$/, "");
  if (!base) return null;
  let text;
  try {
    const res = await fetchImpl(`${base}/${metadata}`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    text = await res.text();
  } catch {
    return null; // 通道不可达如实降级（spec: 不弹错、不重试风暴）
  }
  const meta = parseLatestYml(text);
  if (!meta || !meta.version) return null;
  const cmp = compareVersions(meta.version, currentVersion);
  if (cmp <= 0) return { available: false, version: meta.version, url: null };
  const file = chooseUpdateArtifact({ meta, arch, platform });
  // No artifact for this architecture: report the version honestly with no
  // download path rather than serving the other arch's package.
  return { available: true, version: meta.version, url: file ? `${base}/${file.url}` : null, archMissing: !file };
}

// Parse electron-builder's latest*.yml — a tiny intentional subset (the
// generator only ever writes version + files(url/sha512/size) + path/sha512
// top-level aliases + releaseDate), so no YAML dependency ships for this.
// Indentation is the structure: 2-space dash lines open file entries, deeper
// lines fill them, 0-indent lines are top level.
export function parseLatestYml(text) {
  if (typeof text !== "string" || !text.trim()) return null;
  const out = { version: null, files: [], releaseDate: null };
  let current = null;
  let primary = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("- ")) {
      current = {};
      out.files.push(current);
      const rest = line.slice(2);
      const i = rest.indexOf(":");
      if (i > 0) current[rest.slice(0, i).trim()] = rest.slice(i + 1).trim();
      continue;
    }
    const idx = line.indexOf(":");
    if (idx < 1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    const indented = /^\s/.test(raw);
    if (indented && current) {
      current[key] = value;
    } else if (key === "version") {
      out.version = value;
    } else if (key === "releaseDate") {
      out.releaseDate = value;
    } else if (key === "path" || key === "url") {
      // Top-level `path` names the primary artifact (electron-builder <= 23),
      // `url` the same from 24+ — normalize so files[0] can come from either.
      primary = primary || {};
      primary.url = value;
    } else if (key === "sha512" && !indented) {
      primary = primary || {};
      primary.sha512 = value;
    }
  }
  if (primary && out.files.length === 0) out.files.push(primary);
  if (!out.version || out.files.length === 0) return null;
  return out;
}

// Generate the lane metadata for one platform's artifacts — the CI publish
// step's input. files: [{ file, sha512, size }]. The yml shape mirrors
// electron-builder's own (version / files(url,sha512,size) / releaseDate /
// path+sha512 top-level aliases) so electron-updater reads it natively.
export function generateLatestYml({ version, files, releaseDate = new Date().toISOString() }) {
  if (!version || !Array.isArray(files) || files.length === 0) {
    throw new Error("generateLatestYml: version and a non-empty files list are required");
  }
  for (const f of files) {
    if (!f.file || !f.sha512 || !Number.isFinite(f.size)) {
      throw new Error(`generateLatestYml: each file needs file/sha512/size — got ${JSON.stringify(f)}`);
    }
  }
  const primary = files[0];
  const fileLine = (f) =>
    `  - url: ${f.file}\n    sha512: ${f.sha512}\n    size: ${f.size}` +
    // electron-updater reads blockMapSize to fetch <file>.blockmap and apply a
    // differential update; omitting it silently turns every update into a full
    // 260MB download (harden-desktop-release-lane 4.1).
    (Number.isFinite(f.blockMapSize) ? `\n    blockMapSize: ${f.blockMapSize}` : "");
  const lines = [
    `version: ${version}`,
    `files:`,
    ...files.map(fileLine),
    `path: ${primary.file}`,
    `sha512: ${primary.sha512}`,
    `releaseDate: ${releaseDate}`,
    "",
  ];
  return lines.join("\n");
}

// Three-way version compare on dotted numerics (1.3.9 < 1.3.10 < 1.4.0);
// non-numeric segments compare lexically. Run-out semantics: fewer NUMERIC
// segments = older, but a pure release outranks its own prerelease
// (1.3.28 > 1.3.28-beta.1 — the tag is the younger sibling).
export function compareVersions(a, b) {
  const pa = String(a ?? "").split(/[.-]/).filter(Boolean);
  const pb = String(b ?? "").split(/[.-]/).filter(Boolean);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const x = pa[i];
    const y = pb[i];
    if (x === undefined) {
      if (y === undefined) return 0;
      return Number.isFinite(Number(y)) && String(Number(y)) === y ? -1 : 1;
    }
    if (y === undefined) {
      return Number.isFinite(Number(x)) && String(Number(x)) === x ? 1 : -1;
    }
    const nx = Number(x);
    const ny = Number(y);
    if (Number.isFinite(nx) && Number.isFinite(ny) && String(nx) === x && String(ny) === y) {
      if (nx !== ny) return nx < ny ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}
