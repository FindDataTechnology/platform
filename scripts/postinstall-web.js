#!/usr/bin/env node
// Root postinstall — build the React frontend so `npm start` works out of the box.
//
// Skips when:
//   - PLATFORM_SKIP_WEB_BUILD=1 is set (CI, contributors iterating on web/ manually)
//   - web/dist/index.html already exists (repeat installs don't rebuild)
//   - web/package.json is missing (safety, though this shouldn't happen)
//
// Spec: openspec/changes/redesign-chat-ui-react-shadcn/specs/chat-ui-shell/spec.md
//       § "A single build step produces the frontend"
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const webDir = path.join(root, "web");
const dist = path.join(webDir, "dist", "index.html");

// packages/core (the shared protocol package consumed by web/ via file:) has
// no deps of its own — its imports (zustand, react types) resolve through a
// symlink onto web/node_modules so there is exactly ONE instance of each.
// Runs BEFORE the skip guards: CI sets PLATFORM_SKIP_WEB_BUILD=1 yet its unit
// suites import packages/core TS sources, whose zustand must not fall back to
// the root node_modules (zustand without a sibling react → ERR_MODULE_NOT_FOUND).
// Idempotent: recreate only when missing or pointing elsewhere.
import { symlinkSync, readlinkSync, rmSync } from "node:fs";
const coreModules = path.join(root, "packages", "core", "node_modules");
const coreTarget = path.join("..", "..", "web", "node_modules");
let linked = false;
try {
  linked = readlinkSync(coreModules) === coreTarget;
} catch {
  /* missing or not a symlink */
}
if (!linked) {
  try {
    rmSync(coreModules, { recursive: true, force: true });
  } catch {
    /* nothing to remove */
  }
  try {
    symlinkSync(coreTarget, coreModules, "dir");
    console.log("[postinstall] linked packages/core/node_modules -> web/node_modules");
  } catch (err) {
    console.warn(`[postinstall] could not link packages/core/node_modules: ${err.message}`);
  }
}

if (process.env.PLATFORM_SKIP_WEB_BUILD === "1") {
  console.log("[postinstall] PLATFORM_SKIP_WEB_BUILD=1, skipping web build");
  process.exit(0);
}
if (!existsSync(path.join(webDir, "package.json"))) {
  console.log("[postinstall] web/package.json not found, skipping");
  process.exit(0);
}

if (existsSync(dist)) {
  console.log("[postinstall] web/dist/index.html exists, skipping build");
  process.exit(0);
}

console.log("[postinstall] installing web/ deps...");
// shell: true so Windows resolves `npm` -> `npm.cmd` (a .cmd batch file that
// spawnSync cannot exec without a shell; without it the install silently
// fails on windows-latest).
let r = spawnSync("npm", ["install"], { cwd: webDir, stdio: "inherit", shell: true });
if (r.status !== 0) process.exit(r.status ?? 1);

console.log("[postinstall] building web/...");
r = spawnSync("npm", ["run", "build"], { cwd: webDir, stdio: "inherit", shell: true });
process.exit(r.status ?? 0);
