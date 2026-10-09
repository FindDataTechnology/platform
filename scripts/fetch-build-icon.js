#!/usr/bin/env node
// ── Optional build icon download (openspec: add-deployment-branding) ────────
//
// ICON_URL set   → download to build/icon.downloaded.png (gitignored); a bad
//                  URL, non-PNG body, or <512px image logs a warning and falls
//                  back to the vendored build/icon.png — never fails the build.
// ICON_URL unset → remove any stale download and no-op.
// electron-builder.js picks icon.downloaded.png over the vendored icon when
// present, so this script is the ONLY writer of that path.

import { promises as fs } from "node:fs";
import path from "node:path";

const VENDORED = "build/icon.png";
const DOWNLOADED = "build/icon.downloaded.png";

// PNG IHPR dims: bytes 16..24 of a well-formed PNG (after signature + IHDR).
function pngSize(buf) {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

async function main() {
  const url = (process.env.ICON_URL || "").trim();
  if (!url) {
    await fs.rm(DOWNLOADED, { force: true });
    return;
  }
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const size = pngSize(buf);
    if (!size) throw new Error("body is not a PNG");
    if (size.width < 512 || size.height < 512) {
      console.warn(`[icon] ${url} is ${size.width}x${size.height}; electron-builder wants ≥512px — proceeding anyway`);
    }
    await fs.mkdir(path.dirname(DOWNLOADED), { recursive: true });
    await fs.writeFile(DOWNLOADED, buf);
    console.log(`[icon] downloaded ${size.width}x${size.height} from ${url}`);
  } catch (err) {
    console.warn(`[icon] ICON_URL download failed (${err.message}); using the vendored ${VENDORED}`);
    await fs.rm(DOWNLOADED, { force: true });
  }
}

main().catch((err) => {
  console.warn(`[icon] unexpected failure: ${err.message}; using the vendored ${VENDORED}`);
});
