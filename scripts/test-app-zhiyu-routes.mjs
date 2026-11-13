// The app's zhiyu routes, from expo-router's OWN manifest (openspec:
// add-zhiyu-mobile-clients, task 4.1).
//
// "路由可直达且不与既有 tab 冲突" is a claim about the router's resolved route
// tree, not about files existing on disk — a page can sit in the right folder
// and still not be routable (a stray `_layout`, a mis-typed group name, a
// dynamic segment that never materializes). So this calls expo-router's real
// `getRoutes()` over a fake Metro context and asserts the TREE.
//
// Why a fake context: `getRoutes` only needs `keys()` (the file list) and a
// module getter for `unstable_settings`; it does not evaluate components. That
// keeps this runnable in node — no Metro, no simulator, no device.
//
//   node --test scripts/test-app-zhiyu-routes.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const APP_ROOT = path.resolve(import.meta.dirname, "..", "app");
const ROUTES_DIR = path.join(APP_ROOT, "src", "app");
const require = createRequire(path.join(APP_ROOT, "package.json"));
const { getRoutes } = require("./node_modules/expo-router/build/getRoutes.js");

function manifest() {
  const walk = (dir) => {
    const out = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) out.push(...walk(p));
      else if (/\.(tsx|ts|jsx|js)$/.test(e.name)) out.push(p);
    }
    return out;
  };
  const keys = walk(ROUTES_DIR).map((f) => `./${path.relative(ROUTES_DIR, f)}`);
  const mod = () => ({ default: () => null, unstable_settings: undefined });
  const ctx = Object.assign(mod, { keys: () => keys, resolve: (k) => k, id: "zhiyu-routes-test" });
  return getRoutes(ctx, { platform: "ios" });
}

function find(node, route) {
  if (!node) return null;
  if (node.route === route) return node;
  for (const child of node.children ?? []) {
    const hit = find(child, route);
    if (hit) return hit;
  }
  return null;
}

const childNames = (node) => (node?.children ?? []).map((c) => c.route);

test("4.1 the tab group resolves, and the existing three tabs are still routable", () => {
  const tree = manifest();
  const tabs = find(tree, "(tabs)");
  assert.ok(tabs, "(tabs) group resolves");
  const names = childNames(tabs);
  for (const existing of ["index", "cron", "resources"]) {
    assert.ok(names.includes(existing), `existing tab "${existing}" must still resolve, got ${names.join(", ")}`);
  }
  // Group-level screens that are not routes need not change either.
  assert.ok(find(tree, "+not-found"), "the not-found route is untouched");
});

test("4.1 zhiyu is one tab with a stack inside it: list + dynamic room", () => {
  const tree = manifest();
  const tabs = find(tree, "(tabs)");
  const zhiyu = (tabs.children ?? []).find((c) => c.route === "zhiyu");
  assert.ok(zhiyu, "zhiyu resolves under (tabs)");
  const inner = childNames(zhiyu).sort();
  assert.deepEqual(inner, ["[roomId]", "index"], `the stack holds the list and the room, got ${inner.join(", ")}`);
  // Route files are what make it a stack rather than a second tab bar.
  assert.ok(fs.existsSync(path.join(ROUTES_DIR, "(tabs)", "zhiyu", "_layout.tsx")), "the nested _layout exists");
  assert.ok(fs.existsSync(path.join(ROUTES_DIR, "(tabs)", "zhiyu", "index.tsx")));
  assert.deepEqual(
    fs.readdirSync(path.join(ROUTES_DIR, "(tabs)", "zhiyu")).filter((f) => f.endsWith(".tsx")).sort(),
    ["[roomId].tsx", "_layout.tsx", "index.tsx"],
    "exactly the three route files — nothing that would create a fourth tab",
  );
});

test("4.1 the list pushes the exact pathname the router resolved", () => {
  // A rename on either side breaks the jump silently (router.push with an
  // unknown pathname is a runtime no-op, not a type error with typed routes off).
  const src = fs.readFileSync(path.join(ROUTES_DIR, "(tabs)", "zhiyu", "index.tsx"), "utf8");
  const pushed = [...src.matchAll(/pathname:\s*"([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(pushed, ["/(tabs)/zhiyu/[roomId]"], "the pushed pathname");
  const tree = manifest();
  const room = find(tree, "[roomId]");
  assert.ok(room, "the dynamic segment the pathname names resolves");
});

test("4.1 zhiyu is registered in the tab layout and every tab has a translator key", () => {
  const layout = fs.readFileSync(path.join(ROUTES_DIR, "(tabs)", "_layout.tsx"), "utf8");
  const names = [...layout.matchAll(/<Tabs\.Screen\s+name="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(names, ["index", "cron", "resources", "zhiyu"], `tab registration order, got ${names.join(", ")}`);

  // Every string on these screens goes through i18n; both app locales must have
  // the keys, or the tab renders as a raw key on one language.
  for (const locale of ["zh-CN.json", "en.json"]) {
    const dict = JSON.parse(fs.readFileSync(path.join(APP_ROOT, "src", "i18n", locale), "utf8"));
    assert.ok(dict.tabs?.zhiyu, `${locale}: tabs.zhiyu`);
    assert.ok(dict.zhiyu, `${locale}: zhiyu namespace`);
    for (const key of ["untitled", "emptyList", "loadEarlier", "placeholder", "send", "talk", "shortPoll", "handoffCopied"]) {
      assert.ok(dict.zhiyu[key], `${locale}: zhiyu.${key}`);
    }
    for (const purpose of ["private_window", "invite", "subscription"]) {
      assert.ok(dict.zhiyu.handoff?.[purpose], `${locale}: zhiyu.handoff.${purpose}`);
    }
  }
});
