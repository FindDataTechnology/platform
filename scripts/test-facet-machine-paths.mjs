// ── Machine surfaces are not masked by the facet shell ─────────────────────
//
//   node --test scripts/test-facet-machine-paths.mjs
//
// 钉住的契约（fix-supply-machine-faces / facet-platform "Shell views are
// addressable hash routes"）：
//   · facet 宿主对 /llms.txt、/llms-full.txt、/catalog.json、/robots.txt
//     一律 404 + text/plain 空体——绝不 200 一个 index.html（软 200 对爬虫
//     而言与真机器面不可区分）；
//   · 大小写与尾斜杠变体同一判据；
//   · 人类路由不受影响：/、/docs、任意未知路径仍返回壳文档；
//   · /api/** 不被拦，POST 不被当读面处理。
//
// 这里装配的是 server 实际用的同一个 middleware（facet/machine-paths.js），
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
  machineSurfaceGuard,
} from "../facet/machine-paths.js";

const SHELL = "<!doctype html><html><body>shell</body></html>";

function makeDist() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "facet-dist-"));
  fs.writeFileSync(path.join(dir, "index.html"), SHELL);
  return dir;
}

/** The exact wiring facet/index.js uses, minus the parts that need a DB. */
async function startApp() {
  const dist = makeDist();
  const app = express();
  app.get("/api/ping", (_req, res) => res.json({ ok: true }));
  app.use(machineSurfaceGuard());
  app.use(express.static(dist, { index: "index.html" }));
  app.get(/^\/(?!api\/|auth\/).*/, (_req, res) => res.sendFile(path.join(dist, "index.html")));

  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, base, close: () => new Promise((r) => server.close(r)) };
}

test("the deny list is the four published machine surfaces", () => {
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

test("machine paths answer 404 text/plain, never the shell", async () => {
  const app = await startApp();
  try {
    for (const p of MACHINE_SURFACE_PATHS) {
      const res = await fetch(`${app.base}${p}`);
      assert.equal(res.status, 404, `${p} must be 404`);
      assert.match(res.headers.get("content-type") ?? "", /text\/plain/, `${p} must not be typed as HTML`);
      const body = await res.text();
      assert.equal(body.includes("<!doctype"), false, `${p} body must not be the shell`);
      assert.equal(body.trim(), "", `${p} body must be empty`);
    }
    // variants take the same branch
    for (const p of ["/LLMS.TXT", "/llms-full.txt/", "/Catalog.json"]) {
      const res = await fetch(`${app.base}${p}`);
      assert.equal(res.status, 404, `${p} must be 404`);
    }
    // HEAD is a machine read too
    const head = await fetch(`${app.base}/llms.txt`, { method: "HEAD" });
    assert.equal(head.status, 404);
  } finally {
    await app.close();
  }
});

test("human routes still reach the shell", async () => {
  const app = await startApp();
  try {
    for (const p of ["/", "/docs", "/packs", "/some/unknown/path"]) {
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
    assert.equal(res.status, 404); // express default, not the guard's empty text/plain
    assert.equal((await res.text()).includes("<!doctype"), false);
  } finally {
    await app.close();
  }
});
