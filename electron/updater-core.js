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

// The lane: RustFS (S3-compatible) on the tailnet — desktop machines are all
// inside finddata's tailnet, so the lane is internal-only by design (无公网
// 暴露；bucket yizuo-desktop carries anonymous-read for the unsigned GETs the
// updater makes). MagicDNS alias: windows-laptop.mesh.finddata.cn:9000.
export const DEFAULT_UPDATE_URL = process.env.DESKTOP_UPDATE_URL || "http://100.64.0.10:9000/yizuo-desktop";

// Should this platform run the real auto-update flow? Windows NSIS: yes.
// macOS: only when the host says the build is signed (autoUpdater on an
// unsigned mac hard-fails mid-download — the honest posture is notify-only).
export function autoUpdateSupported({ platform, signed = false } = {}) {
  if (platform === "win32") return true;
  if (platform === "darwin") return Boolean(signed);
  return false;
}

// Notify-only degrade: fetch the mac metadata and compare versions, never
// download or install. Returns { available, url, version } | null (lane
// unreachable / malformed — the caller logs and stays silent per spec).
export async function macNotifyCheck({ channelUrl, currentVersion, fetchImpl = fetch }) {
  const base = String(channelUrl || "").replace(/\/+$/, "");
  if (!base) return null;
  let text;
  try {
    const res = await fetchImpl(`${base}/latest-mac.yml`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    text = await res.text();
  } catch {
    return null; // 通道不可达如实降级（spec: 不弹错、不重试风暴）
  }
  const meta = parseLatestYml(text);
  if (!meta || !meta.version) return null;
  const cmp = compareVersions(meta.version, currentVersion);
  if (cmp <= 0) return { available: false, version: meta.version, url: null };
  const file = meta.files.find((f) => String(f.url || "").endsWith(".dmg")) || meta.files[0];
  return { available: true, version: meta.version, url: file ? `${base}/${file.url}` : base };
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
  const lines = [
    `version: ${version}`,
    `files:`,
    ...files.map((f) => `  - url: ${f.file}\n    sha512: ${f.sha512}\n    size: ${f.size}`),
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
