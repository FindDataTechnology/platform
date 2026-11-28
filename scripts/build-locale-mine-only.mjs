// Build "mine-only" locale files: HEAD baseline + only the keys this change
// owns. The working tree also carries a parallel session's `blueprints` keys;
// those must NOT be staged here (their session commits them).
//
// Usage: node scripts/build-locale-mine-only.mjs
import { execFileSync } from "node:child_process";
import fs from "node:fs";

const LOCALES = ["en", "es", "fr", "ja", "zh-CN"];

// The key paths this change owns (deep-copied from the working tree).
const MINE = [
  ["packs", "mine", "sourceBundle"],
  ["onboarding", "tour"],
  ["fleet", "local"],
  ["fleet", "catalog", "idle"],
  ["fleet", "catalog", "readOnlyNote"],
];
// Keys this change REMOVED (the catalog's old read-only deploy affordance).
const REMOVED = [["fleet", "catalog", "deploy"], ["fleet", "catalog", "deployPending"], ["fleet", "catalog", "deployNote"]];

function get(obj, path) {
  let cur = obj;
  for (const key of path) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = cur[key];
  }
  return cur;
}

function set(obj, path, value) {
  let cur = obj;
  for (let i = 0; i < path.length - 1; i += 1) {
    const key = path[i];
    if (cur[key] == null || typeof cur[key] !== "object") cur[key] = {};
    cur = cur[key];
  }
  cur[path[path.length - 1]] = value;
}

function drop(obj, path) {
  let cur = obj;
  for (let i = 0; i < path.length - 1; i += 1) {
    const key = path[i];
    if (cur == null || typeof cur !== "object") return;
    cur = cur[key];
  }
  if (cur && typeof cur === "object") delete cur[path[path.length - 1]];
}

for (const loc of LOCALES) {
  const rel = `web/src/locales/${loc}/common.json`;
  const head = JSON.parse(execFileSync("git", ["show", `HEAD:${rel}`], { encoding: "utf8" }));
  const work = JSON.parse(fs.readFileSync(rel, "utf8"));
  for (const path of MINE) {
    const value = get(work, path);
    if (value === undefined) throw new Error(`working tree is missing ${path.join(".")} in ${loc}`);
    set(head, path, value);
  }
  for (const path of REMOVED) drop(head, path);
  const out = `${JSON.stringify(head, null, 2)}\n`;
  fs.writeFileSync(`/tmp/locale-mine-${loc}.json`, out);
  console.log(`built /tmp/locale-mine-${loc}.json (${out.length} bytes)`);
}
