// server/plugin-package-write.js — land a plugin package on disk, atomically.
//
// Split out of lib/plugin-package.js on purpose: that module is pure (a Map in,
// a Map out) so the determinism criterion can be judged in memory. Writing is
// the part that can fail halfway, so it lives here where failure can be handled:
// the bytes go to a sibling temp directory first and are renamed into place only
// after every file is written. A half-written package is worse than none — a
// host that loads it sees a package whose `plugin.json` promises skills that
// are not on disk.

import { mkdir, writeFile, rename, rm, readdir } from "node:fs/promises";
import path from "node:path";

function fail(message, code) {
  return Object.assign(new Error(message), { status: 400, code });
}

/**
 * Write `files` (a Map from lib/plugin-package.js) under `targetDir`.
 *
 * Refuses a non-empty existing target: overwriting in place is how a package
 * ends up as a mixture of two exports. Callers that want to refresh should
 * remove the directory first and let this land a fresh one.
 */
export function packageEntries(files) {
  // The envelope family in server/pack-projection.js returns plain objects
  // (`{ files: Record<string,string> }`, same as toDshBundle); a Map is accepted
  // too because it is the natural thing for a caller to build incrementally.
  // Normalising here keeps both writers from each growing their own rule.
  if (files instanceof Map) return [...files.entries()];
  if (files && typeof files === "object" && !Array.isArray(files)) return Object.entries(files);
  return [];
}

export async function writePluginPackage(files, targetDir) {
  const entries = packageEntries(files);
  if (entries.length === 0) {
    throw fail("plugin package carries no files", "plugin_package_empty");
  }
  const target = path.resolve(String(targetDir));

  let existing = [];
  try {
    existing = await readdir(target);
  } catch (err) {
    if (err.code !== "ENOENT") throw err; // exists but unreadable is not "absent"
  }
  if (existing.length > 0) {
    throw fail(
      `target directory is not empty: ${target} (${existing.length} entries); remove it first`,
      "plugin_package_target_not_empty",
    );
  }

  const parent = path.dirname(target);
  await mkdir(parent, { recursive: true });
  const staging = path.join(parent, `.${path.basename(target)}.tmp-${process.pid}`);
  await rm(staging, { recursive: true, force: true });

  try {
    for (const [relPath, value] of [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      const destination = path.join(staging, relPath);
      if (!destination.startsWith(staging + path.sep)) {
        throw fail(`refusing to write outside the package root: ${relPath}`, "plugin_package_escape");
      }
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, value, "utf8");
    }
    await rm(target, { recursive: true, force: true });
    await rename(staging, target);
  } catch (err) {
    await rm(staging, { recursive: true, force: true });
    throw err;
  }
  return target;
}
