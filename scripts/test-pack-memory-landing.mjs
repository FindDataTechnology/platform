// add-pack-memory-declaration 4.1/4.2: the landing write, and when NOT to write.
//
// The claims worth pinning are the ones a later refactor would quietly break:
//   · the write uses a POD token for exactly `d/<pack>` — not the platform token,
//     which could reach any root
//   · a pack that declares no process axis writes NOTHING (an empty document is
//     the CLEAR operation, so "nothing to say" must not mean "delete")
//   · archiving clears only when no live team from that pack remains
//   · every failure degrades open: landing a team never fails because memory is
//     unreachable
//
//   node --test scripts/test-pack-memory-landing.mjs

import test from "node:test";
import assert from "node:assert/strict";
import {
  landPackMemoryPolicy,
  releasePackMemoryPolicy,
  resetPackMemoryTokenCache,
  syncPackMemoryPolicy,
} from "../server/pack-memory-policy-landing.js";

const ENV = {
  CELL_MEMORY_ENABLED: "1",
  CELL_MEMORY_URL: "http://fdmem.test",
  CELL_MEMORY_PLATFORM_TOKEN: "platform-token",
  CELL_MEMORY_DATA: "/tmp/unused-for-these-tests",
};

const quiet = { warn: () => {}, log: () => {} };

function stub({ mintOk = true, putOk = true, putBody = { cleared: false } } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, method: init.method ?? "GET", body: init.body, auth: init.headers?.authorization });
    if (u.endsWith("/admin/mint")) {
      if (!mintOk) return { ok: false, status: 500, json: async () => ({}) };
      const ns = JSON.parse(init.body).namespace;
      return { ok: true, status: 200, json: async () => ({ token: `pod:${ns}` }) };
    }
    if (u.includes("/policy")) {
      if (!putOk) return { ok: false, status: 400, json: async () => ({}), text: async () => "policy_invalid" };
      return { ok: true, status: 200, json: async () => putBody };
    }
    throw new Error(`unexpected call ${u}`);
  };
  return { calls, fetchImpl };
}

test.beforeEach(() => resetPackMemoryTokenCache());

test("landing writes the declared process axis with a token scoped to the pack root", async () => {
  const { calls, fetchImpl } = stub();
  const r = await landPackMemoryPolicy({
    packId: "legal-crew",
    manifest: { memory: { process: { distill: "off", cold_after_days: 90 } } },
    env: ENV,
    fetchImpl,
    log: quiet,
  });
  assert.equal(r.ok, true);
  assert.equal(r.action, "written");
  assert.equal(r.rootKey, "d-legal-crew");

  const mint = calls.find((c) => c.url.endsWith("/admin/mint"));
  assert.equal(JSON.parse(mint.body).namespace, "d/legal-crew", "the token must be minted for the pack root");
  assert.equal(mint.auth, "Bearer platform-token");

  const put = calls.find((c) => c.url.includes("/policy"));
  const u = new URL(put.url);
  // 反面断言：**绝不能**带 rootKey（2026-11-13 线上实测 400 rootKey_is_platform_seam_only）。
  // 旧测试这里写的是 `assert.equal(u.searchParams.get("rootKey"), "d-legal-crew")`——
  // 它把错的行为钉死了：stub 的 fetch 不执行服务端的缝规则，所以测试一直绿，
  // 而生产里每次落地都静默失败（degrade-open 只 warn）。断言必须钉住「不带」。
  assert.equal(u.searchParams.get("rootKey"), null, "a pod token must not name a root — the service refuses it with 400");
  assert.equal(u.searchParams.get("scope"), "root");
  assert.equal(put.auth, "Bearer pod:d/legal-crew", "the write must NOT ride the platform token");
  assert.deepEqual(JSON.parse(put.body), { process: { distill: "off", cold_after_days: 90 } });
});

test("a pack that declares no process axis writes NOTHING (empty document = clear)", async () => {
  for (const manifest of [{}, { memory: {} }, { memory: { read: { scope: "shared" } } }, null]) {
    const { calls, fetchImpl } = stub();
    const r = await landPackMemoryPolicy({ packId: "p", manifest, env: ENV, fetchImpl, log: quiet });
    assert.equal(r.action, "none", `${JSON.stringify(manifest)} must not write`);
    assert.equal(calls.filter((c) => c.url.includes("/policy")).length, 0, "no PUT was sent");
  }
});

test("archiving clears the row only when no live team from that pack remains", async () => {
  // Last team gone → clear.
  {
    const { calls, fetchImpl } = stub({ putBody: { cleared: true } });
    const r = await releasePackMemoryPolicy({
      packId: "legal-crew",
      manifest: { memory: { process: { distill: "off" } } },
      liveFleets: 0,
      env: ENV,
      fetchImpl,
      log: quiet,
    });
    assert.equal(r.action, "cleared");
    const put = calls.find((c) => c.url.includes("/policy"));
    assert.deepEqual(JSON.parse(put.body), { process: {} }, "clearing sends an empty document");
  }
  // A sibling team keeps the same pack alive → the row must survive untouched.
  {
    const { calls, fetchImpl } = stub();
    const r = await releasePackMemoryPolicy({
      packId: "legal-crew",
      manifest: { memory: { process: { distill: "off" } } },
      liveFleets: 1,
      env: ENV,
      fetchImpl,
      log: quiet,
    });
    assert.equal(r.action, "written", "a surviving team's declaration is re-asserted, never cleared");
    assert.deepEqual(JSON.parse(calls.find((c) => c.url.includes("/policy")).body).process, { distill: "off" });
  }
});

test("memory not configured, or an uncompilable declaration, changes nothing", async () => {
  {
    const { calls, fetchImpl } = stub();
    const r = await syncPackMemoryPolicy({
      packId: "p",
      manifest: { memory: { process: { distill: "off" } } },
      env: { ...ENV, CELL_MEMORY_URL: "" },
      fetchImpl,
      log: quiet,
    });
    assert.equal(r.action, "skipped");
    assert.equal(calls.length, 0);
  }
  {
    const { calls, fetchImpl } = stub();
    const r = await syncPackMemoryPolicy({
      packId: "p",
      manifest: { memory: { process: { distil: "off" } } }, // misspelled
      env: ENV,
      fetchImpl,
      log: quiet,
    });
    assert.equal(r.ok, false);
    assert.equal(r.action, "refused");
    assert.equal(r.reason, "memory_key_unknown");
    assert.equal(calls.length, 0, "a declaration we cannot fully understand must not be written into a shared root");
  }
});

test("a failed write or mint degrades open and names the reason", async () => {
  {
    resetPackMemoryTokenCache(); // the sub-cases share a pack id: a cached token would hide the mint failure
    const { fetchImpl } = stub({ putOk: false });
    const r = await landPackMemoryPolicy({
      packId: "p",
      manifest: { memory: { process: { distill: "off" } } },
      env: ENV,
      fetchImpl,
      log: quiet,
    });
    assert.equal(r.ok, false);
    assert.equal(r.action, "failed");
    assert.match(r.reason, /HTTP 400/);
  }
  {
    resetPackMemoryTokenCache();
    const { fetchImpl } = stub({ mintOk: false });
    const r = await landPackMemoryPolicy({
      packId: "p",
      manifest: { memory: { process: { distill: "off" } } },
      env: ENV,
      fetchImpl,
      log: quiet,
    });
    assert.equal(r.ok, false);
    assert.match(r.reason, /mint HTTP 500/);
  }
});

test("one token per root: a second landing on the same pack reuses the mint", async () => {
  const { calls, fetchImpl } = stub();
  for (const _ of [1, 2]) {
    await landPackMemoryPolicy({ packId: "legal-crew", manifest: { memory: { process: { distill: "off" } } }, env: ENV, fetchImpl, log: quiet });
  }
  assert.equal(calls.filter((c) => c.url.endsWith("/admin/mint")).length, 1);
  assert.equal(calls.filter((c) => c.url.includes("/policy")).length, 2, "both landings still assert the row");
});
