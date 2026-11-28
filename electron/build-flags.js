// ── Build facts that travel with the artifact (harden-desktop-release-lane D5)
//
// "Is this build signed?" used to be read from `process.env.DESKTOP_SIGNED` —
// a flag NO build step ever set, so a signed macOS build would still have
// degraded to notify-only forever. The answer belongs to the artifact, not to
// the shell that launched it: afterPack writes resources/build-flags.json from
// the same env the signer consumed, and this module reads it back at runtime.
//
// On macOS the claim is then verified against the bundle itself (codesign), so
// a stale/forged flag degrades honestly instead of attempting an install that
// Gatekeeper will refuse.

import { readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export const BUILD_FLAGS_FILE = "build-flags.json";

export function readBuildFlags(resourcesPath) {
  try {
    const raw = JSON.parse(readFileSync(path.join(resourcesPath, BUILD_FLAGS_FILE), "utf8"));
    return { signed: raw.signed === true, notarized: raw.notarized === true };
  } catch {
    // Dev runs and builds older than this flag carry no file: unsigned.
    return { signed: false, notarized: false };
  }
}

export function verifyMacSignature(bundlePath, spawn = spawnSync) {
  if (!bundlePath) return false;
  const res = spawn("codesign", ["--verify", "--deep", "--strict", bundlePath], { encoding: "utf8" });
  return res.status === 0;
}

export function resolveSigned({ resourcesPath, platform, bundlePath, verify = verifyMacSignature }) {
  const flags = readBuildFlags(resourcesPath);
  if (!flags.signed) return false;
  if (platform !== "darwin") return true;
  return verify(bundlePath);
}

// electron-builder's afterPack input: same env the signer reads. A missing
// secret means electron-builder skips signing, so it must mean unsigned here.
export function buildFlagsFromEnv(env = process.env, platform) {
  const signed = platform === "darwin" ? Boolean(env.CSC_LINK) : platform === "win32" ? Boolean(env.WIN_CSC_LINK) : false;
  const notarized = signingNotarizeReady(env);
  return { signed, notarized: signed && notarized, at: new Date().toISOString() };
}

function signingNotarizeReady(env) {
  return Boolean(env.APPLE_ID && env.APPLE_APP_SPECIFIC_PASSWORD && env.APPLE_TEAM_ID);
}
