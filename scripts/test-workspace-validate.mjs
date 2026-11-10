// Self-check for the workspace path validator (server/agent-session.js).
// It is the trust boundary between a client-supplied string and the directory
// the dsh child gets spawned in, so the branches worth breaking are: relative
// paths, missing paths, files-not-directories, and symlink resolution.
//
// Run: node scripts/test-workspace-validate.mjs

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { validateWorkspace } from "../server/agent-session.js";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ws-validate-"));

try {
  const realDir = path.join(tmp, "project");
  const file = path.join(tmp, "notes.txt");
  const link = path.join(tmp, "link-to-project");
  await fs.mkdir(realDir);
  await fs.writeFile(file, "x");
  await fs.symlink(realDir, link);

  // Rejects: empty / non-string.
  assert.equal((await validateWorkspace("")).ok, false);
  assert.equal((await validateWorkspace("   ")).ok, false);
  assert.equal((await validateWorkspace(null)).ok, false);
  assert.equal((await validateWorkspace(42)).ok, false);

  // Rejects: relative paths. A relative path would resolve against the SERVER's
  // cwd, which is never what the user meant.
  const rel = await validateWorkspace("./src");
  assert.equal(rel.ok, false);
  assert.match(rel.error, /absolute/i);
  assert.equal((await validateWorkspace("src/lib")).ok, false);
  assert.equal((await validateWorkspace("../escape")).ok, false);

  // Rejects: nonexistent.
  const missing = await validateWorkspace(path.join(tmp, "nope"));
  assert.equal(missing.ok, false);
  assert.match(missing.error, /No such directory/);

  // Rejects: a regular file.
  const notDir = await validateWorkspace(file);
  assert.equal(notDir.ok, false);
  assert.match(notDir.error, /Not a directory/);

  // Accepts a real directory, returning the resolved path.
  const good = await validateWorkspace(realDir);
  assert.equal(good.ok, true);
  assert.equal(good.path, await fs.realpath(realDir));

  // Accepts a symlink, but returns the TARGET. Handing dsh the link while
  // having validated the target is exactly how a check gets bypassed.
  const viaLink = await validateWorkspace(link);
  assert.equal(viaLink.ok, true);
  assert.equal(viaLink.path, await fs.realpath(realDir));
  assert.notEqual(viaLink.path, link);

  // Surrounding whitespace is trimmed, not rejected.
  assert.equal((await validateWorkspace(`  ${realDir}  `)).ok, true);

  // A symlink pointing at a file is still not a directory.
  const fileLink = path.join(tmp, "link-to-file");
  await fs.symlink(file, fileLink);
  assert.equal((await validateWorkspace(fileLink)).ok, false);

  // A dangling symlink resolves to nothing.
  const dangling = path.join(tmp, "dangling");
  await fs.symlink(path.join(tmp, "gone"), dangling);
  assert.equal((await validateWorkspace(dangling)).ok, false);

  console.log("workspace validate: all assertions passed");
} finally {
  await fs.rm(tmp, { recursive: true, force: true });
}
