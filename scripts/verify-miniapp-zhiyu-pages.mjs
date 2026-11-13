#!/usr/bin/env node
// Verify the mini-program's zhiyu pages exist in the BUILD ARTIFACT, not just in
// the source tree (openspec: add-zhiyu-mobile-clients, task 3.1).
//
// This distinction is the whole point of the task: `app.config.ts` is a config
// file, and a page can be listed there and still not ship — a bad import, a
// path typo, or a Taro template that never gets generated all look fine in
// `src/` and produce a package where the page cannot be opened.
//
// What "in the artifact" means for Taro weapp:
//   • `dist/app.json` lists the route (the router's own source of truth);
//   • `dist/pages/<route>/{index.js,index.json,index.wxml}` exist;
//   • the testids the pages hang behaviour on are in the emitted JS.
//     Taro compiles to ONE generic template (`base.wxml` + `taro_tmpl`), so the
//     marker strings live in the page bundle, not the wxml — grepping the wxml
//     finds nothing and would look like a failure of the page.
//   • something NAVIGATES to the list. A registered page with no inbound link is
//     shipped and unreachable: the first version of this change had exactly
//     that, pages in `app.json` and nothing in the UI pointing at them.
//
//   node scripts/verify-miniapp-zhiyu-pages.mjs [--no-build]
//
// Exit 0 = the pages ship. Exit 1 = they do not, with the missing item named.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const MINIAPP = path.join(ROOT, "miniapp");
const DIST = path.join(MINIAPP, "dist");

const PAGES = ["pages/zhiyu/list/index", "pages/zhiyu/room/index"];

/** The markers each page must carry into the bundle. */
const MARKERS = {
  "pages/zhiyu/list/index": ["mp-zhiyu-list", "mp-zhiyu-room-item-"],
  "pages/zhiyu/room/index": [
    "mp-zhiyu-room",
    "mp-zy-msg-",
    "mp-zy-load-earlier",
    "mp-zy-composer",
    "mp-zy-send",
    "mp-zy-talk",
    "mp-zy-presence",
    "mp-zy-connection-note",
    "mp-zy-handoff-",
  ],
};

if (!process.argv.includes("--no-build")) {
  console.log("[verify] building the mini program (npm run build:weapp)…");
  execFileSync("npm", ["run", "build:weapp"], { cwd: MINIAPP, stdio: "pipe" });
}

const problems = [];

const appJsonPath = path.join(DIST, "app.json");
if (!fs.existsSync(appJsonPath)) {
  console.error(`[verify] no build artifact at ${DIST} — run the build first`);
  process.exit(1);
}
const appJson = JSON.parse(fs.readFileSync(appJsonPath, "utf8"));
const shipped = new Set(appJson.pages ?? []);

for (const page of PAGES) {
  if (!shipped.has(page)) problems.push(`${page}: not in dist/app.json`);
  for (const ext of ["js", "json", "wxml"]) {
    const file = path.join(DIST, `${page}.${ext}`);
    if (!fs.existsSync(file)) problems.push(`${page}.${ext}: missing from the artifact`);
  }
  const jsPath = path.join(DIST, `${page}.js`);
  if (fs.existsSync(jsPath)) {
    const js = fs.readFileSync(jsPath, "utf8");
    for (const marker of MARKERS[page] ?? []) {
      if (!js.includes(marker)) problems.push(`${page}.js: marker "${marker}" not shipped`);
    }
  }
}

// The doorway: at least one bundle that is NOT the page itself must name the
// route, or the user can never get there.
const chunks = [
  ...fs.readdirSync(DIST).filter((f) => f.endsWith(".js")).map((f) => path.join(DIST, f)),
  ...fs.readdirSync(path.join(DIST, "pages"), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => path.join(DIST, "pages", e.name, "index.js"))
    .filter((f) => fs.existsSync(f)),
];
const NOT_A_DOORWAY = new Set([
  // `app.js` carries the route TABLE (every page's path lives here), so it names
  // every route whether or not anything can reach it. Counting it would make
  // this check always pass.
  path.join(DIST, "app.js"),
  path.join(DIST, "pages", "zhiyu", "list", "index.js"),
  path.join(DIST, "pages", "zhiyu", "room", "index.js"),
]);
const doors = chunks.filter((f) => {
  if (NOT_A_DOORWAY.has(f)) return false;
  return fs.readFileSync(f, "utf8").includes("pages/zhiyu/list/index");
});
if (!doors.length) {
  problems.push("no bundle outside the zhiyu pages links to pages/zhiyu/list/index — the pages ship but are unreachable");
}

if (problems.length) {
  console.error(`✖ ${problems.length} problem(s):`);
  for (const p of problems) console.error(`  • ${p}`);
  process.exit(1);
}
console.log(
  `✔ ${PAGES.join(", ")} ship with their markers (${PAGES.length} pages, ${Object.values(MARKERS).flat().length} markers), ` +
    `reachable from ${doors.map((d) => path.relative(DIST, d)).join(", ")}`,
);
