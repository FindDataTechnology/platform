// ── Machine surfaces on the supply-domain front door ────────────────────────
//
//   node --test scripts/test-facet-machine-paths.mjs
//
// 钉住的契约（unify-supply-spine-lineage D3，2026-11-21 反转）：
//
//   facet 是供给域正门，**拥有**这四个机器面。所以：
//     · 文件在   → 200 真字节（不是壳、不是 404）
//     · 文件缺   → 503 text/plain（**不是** 404，更不是 200 的 index.html）
//     · 非机器路径 → 人类路由照常（壳 / API 不受影响）
//
// 为什么 503 这条必须单独测：这个中间件上一版的契约是「一律 404」，而
// 404 与 503 的分界正是「我不拥有这块面」与「我拥有但它此刻不可用」。
// 反转后如果有人把缺失分支写成 next()，它会掉进 SPA catch-all，回一个
// 软 200 的 index.html——对爬虫与真机器面不可区分。这个用例就是钉住它。
//
// 装配的是 server 实际用的同一个 middleware（facet/machine-paths.js），
// 不是它的复制品——复制品的绿灯是自证。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";

import {
  MACHINE_SURFACE_PATHS,
  isMachineSurfacePath,
  machineSurfaceFile,
  machineSurfaceGuard,
} from "../facet/machine-paths.js";

const SHELL = "<!doctype html><html><body>shell</body></html>";
const SURFACES = {
  "llms.txt": "# llms\nfront door\n",
  "llms-full.txt": "# llms full\n",
  "catalog.json": '{"materials":[]}\n',
  "robots.txt": "User-agent: *\n",
};
const CONTENT_TYPES = {
  "/llms.txt": /text\/plain/,
  "/llms-full.txt": /text\/plain/,
  "/catalog.json": /application\/json/,
  "/robots.txt": /text\/plain/,
};

function makeSite({ withSurfaces = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "facet-site-"));
  fs.writeFileSync(path.join(dir, "index.html"), SHELL);
  if (withSurfaces) {
    for (const [name, body] of Object.entries(SURFACES)) {
      fs.writeFileSync(path.join(dir, name), body);
    }
  }
  return dir;
}

/** The exact wiring facet/index.js uses, minus the parts that need a DB. */
async function startApp({ siteRoot, exists } = {}) {
  const root = siteRoot ?? makeSite();
  const app = express();
  app.get("/api/ping", (_req, res) => res.json({ ok: true }));
  // Same order as facet/index.js: guard → static → SPA catch-all.
  app.use(machineSurfaceGuard({ siteRoot: root, exists }));
  if (root) app.use(express.static(root, { index: "index.html" }));
  app.get(/^\/(?!api\/|auth\/).*/, (_req, res) =>
    res.type("html").send(root ? fs.readFileSync(path.join(root, "index.html"), "utf8") : SHELL),
  );

  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, base, root, close: () => new Promise((r) => server.close(r)) };
}

test("the owned list is the four published machine surfaces", () => {
  assert.deepEqual([...MACHINE_SURFACE_PATHS], [
    "/llms.txt",
    "/llms-full.txt",
    "/catalog.json",
    "/robots.txt",
  ]);
});

test("matching ignores case and a trailing slash", () => {
  assert.equal(isMachineSurfacePath("/llms.txt"), true);
  assert.equal(isMachineSurfacePath("/LLMS.TXT"), true);
  assert.equal(isMachineSurfacePath("/llms.txt/"), true);
  assert.equal(isMachineSurfacePath("/catalog.json"), true);
  assert.equal(isMachineSurfacePath("/docs"), false);
  assert.equal(isMachineSurfacePath("/"), false);
  assert.equal(isMachineSurfacePath("/llms.txt.bak"), false);
});

test("surface paths resolve to their file inside the site root", () => {
  const hit = machineSurfaceFile("/LLMS.TXT/", "/site");
  assert.equal(hit.file, "llms.txt");
  assert.equal(hit.path, "/site/llms.txt");
  // The generated/ fallback is the same generation, for a freshly seeded root.
  assert.equal(hit.fallbackPath, "/site/generated/llms.txt");
  assert.equal(machineSurfaceFile("/docs", "/site"), null);
});

test("a surface present only under generated/ is still served", async () => {
  const root = makeSite({ withSurfaces: false });
  fs.mkdirSync(path.join(root, "generated"), { recursive: true });
  for (const [name, body] of Object.entries(SURFACES)) {
    fs.writeFileSync(path.join(root, "generated", name), body);
  }
  const app = await startApp({ siteRoot: root });
  try {
    for (const p of MACHINE_SURFACE_PATHS) {
      const res = await fetch(`${app.base}${p}`);
      assert.equal(res.status, 200, `${p} must be served from the generated/ fallback`);
      assert.equal(await res.text(), SURFACES[path.basename(p)]);
    }
  } finally {
    await app.close();
  }
});

test("present surfaces are served as their own bytes, never the shell", async () => {
  const app = await startApp();
  try {
    for (const p of MACHINE_SURFACE_PATHS) {
      const res = await fetch(`${app.base}${p}`);
      assert.equal(res.status, 200, `${p} must be 200 from the owning host`);
      assert.match(res.headers.get("content-type") ?? "", CONTENT_TYPES[p], `${p} content-type`);
      const body = await res.text();
      assert.equal(body, SURFACES[path.basename(p)], `${p} must be the file itself`);
      assert.equal(body.includes("<!doctype"), false, `${p} must never be the shell`);
    }
    // variants take the same branch
    for (const p of ["/LLMS.TXT", "/catalog.json/"]) {
      const res = await fetch(`${app.base}${p}`);
      assert.equal(res.status, 200, `${p} must be 200`);
      assert.equal((await res.text()).includes("<!doctype"), false);
    }
    const head = await fetch(`${app.base}/llms.txt`, { method: "HEAD" });
    assert.equal(head.status, 200);
  } finally {
    await app.close();
  }
});

test("a missing surface is 503, not 404 and never a soft 200 shell", async () => {
  const app = await startApp({ siteRoot: makeSite({ withSurfaces: false }) });
  try {
    for (const p of MACHINE_SURFACE_PATHS) {
      const res = await fetch(`${app.base}${p}`);
      assert.equal(res.status, 503, `${p} must be 503 when the owning host cannot serve it`);
      assert.match(res.headers.get("content-type") ?? "", /text\/plain/, `${p} must not be typed as HTML`);
      const body = await res.text();
      assert.equal(body.includes("<!doctype"), false, `${p} must not fall through to the shell`);
      assert.match(body, /machine surface unavailable/);
    }
  } finally {
    await app.close();
  }
});

test("a host with no site root at all is not silently treated as owning nothing", async () => {
  // siteRoot="" means the deployment forgot to wire the surfaces. That is a
  // misconfiguration of an OWNING host, so it must be 503, not a 404 that
  // reads as "this host has no machine faces".
  const app = await startApp({ siteRoot: "" });
  try {
    const res = await fetch(`${app.base}/llms.txt`);
    assert.equal(res.status, 503);
  } finally {
    await app.close();
  }
});

test("human routes still reach the shell", async () => {
  const app = await startApp();
  try {
    // The site root here holds only surfaces + an index; the shell is index.html.
    for (const p of ["/", "/packs", "/some/unknown/path"]) {
      const res = await fetch(`${app.base}${p}`);
      assert.equal(res.status, 200, `${p} must serve the shell`);
      assert.match(res.headers.get("content-type") ?? "", /text\/html/, `${p} must be HTML`);
      assert.match(await res.text(), /<!doctype html>/);
    }
  } finally {
    await app.close();
  }
});

test("the API plane is not intercepted", async () => {
  const app = await startApp();
  try {
    const res = await fetch(`${app.base}/api/ping`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  } finally {
    await app.close();
  }
});

test("a write to a machine path is not treated as a surface read", async () => {
  const app = await startApp();
  try {
    const res = await fetch(`${app.base}/llms.txt`, { method: "POST" });
    assert.notEqual(res.status, 503, "the guard only governs GET/HEAD");
  } finally {
    await app.close();
  }
});
