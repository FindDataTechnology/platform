// adopt-yongyi-client-sdk task 3 — the cluster lane now consumes
// @finddatatechnology/yongyi-client. Ladder internals, token mint/cache and
// HTTP wire behavior are the SDK suite's job now; 壹座 pins the wiring
// contracts that survive as THIS repo's seams: the injected-block titles
// (byte-identical labels + line assembly), the CELL_MEMORY_* env semantics
// (digest rollback lever, chat total kill, k/budget, digest deadline), the
// off/absent identity baselines, and the import resolving at all. Mock
// fetch — no fd-memory instance needed; the HTTP contract is pinned by
// fd-memory's own suite.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clusterMemoryFor,
  clusterProjectId,
  digestTimeoutMs,
  memoryInjectionFor,
  chatMemoryInjectionFor,
  chatPromptWithMemory,
  CLUSTER_TITLES_LABEL,
  CHAT_TITLES_LABEL,
} from "@finddatatechnology/yongyi-client";

function tmpData() {
  return mkdtempSync(join(tmpdir(), "cluster-mem-"));
}

function baseEnv(data, url = "http://memory.test") {
  return {
    CELL_MEMORY_ENABLED: "1",
    CELL_MEMORY_URL: url,
    CELL_MEMORY_PLATFORM_TOKEN: "plat",
    CELL_MEMORY_DATA: data,
  };
}

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A fetch impl that mints once and then serves /pages GET.
function stubFetch(pages = []) {
  return async (url, _init = {}) => {
    const u = String(url);
    if (u.endsWith("/admin/mint")) {
      return { ok: true, status: 200, json: async () => ({ token: "fdm_stub", id: "t1" }) };
    }
    if (u.includes("/pages")) {
      return { ok: true, status: 200, json: async () => ({ project: "c1", pages }) };
    }
    throw new Error(`unexpected fetch ${u}`);
  };
}

test("wiring: the ladder surfaces cluster lane consumes resolve from the SDK", () => {
  for (const fn of [clusterMemoryFor, clusterProjectId, digestTimeoutMs, memoryInjectionFor, chatMemoryInjectionFor, chatPromptWithMemory]) {
    assert.equal(typeof fn, "function");
  }
  // the two injected-block titles, byte-identical to the historical strings
  assert.equal(CLUSTER_TITLES_LABEL, "【集群共享记忆】本集群此前回合的沉淀，供参考：");
  assert.equal(CHAT_TITLES_LABEL, "【工作记忆】此前会话的沉淀，供参考：");
});

test("clusterMemoryFor: config off or owner missing → null (hooks no-op)", async () => {
  const data = tmpData();
  try {
    assert.equal(await clusterMemoryFor({ CELL_MEMORY_ENABLED: "0" }, "o@x"), null);
    assert.equal(await clusterMemoryFor(baseEnv(data), null), null);
    assert.equal(await clusterMemoryFor(baseEnv(data), ""), null);
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

test("clusterMemoryFor: wired client exposes the three faces and the fetchImpl seam rides through", async () => {
  const data = tmpData();
  try {
    const mem = await clusterMemoryFor(baseEnv(data), "owner@test.local", stubFetch([{ title: "首轮 digest", updated_at: "2026-10-22T01:00:00.000Z" }]));
    assert.ok(mem, "client built");
    assert.equal(typeof mem.readDigest, "function");
    assert.equal(typeof mem.readShared, "function");
    assert.equal(typeof mem.writeDigest, "function");
    const pages = await mem.readShared("cluster-42");
    assert.equal(pages.length, 1);
    assert.equal(pages[0].title, "首轮 digest");
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

test("clusterProjectId: sanitized, path-safe, defaulted", () => {
  assert.equal(clusterProjectId("dyn_abc-1"), "dyn_abc-1");
  assert.equal(clusterProjectId("a/b\\c"), "a-b-c");
  assert.equal(clusterProjectId("  "), "cluster");
  assert.equal(clusterProjectId(null), "cluster");
});

test("digestTimeoutMs: default 9000, env override, clamped to [500, 60000]", () => {
  assert.equal(digestTimeoutMs({}), 9000);
  assert.equal(digestTimeoutMs({ CELL_MEMORY_DIGEST_TIMEOUT_MS: "12000" }), 12000);
  assert.equal(digestTimeoutMs({ CELL_MEMORY_DIGEST_TIMEOUT_MS: "100" }), 500, "below the floor clamps up");
  assert.equal(digestTimeoutMs({ CELL_MEMORY_DIGEST_TIMEOUT_MS: "999999" }), 60000, "above the cap clamps down");
  assert.equal(digestTimeoutMs({ CELL_MEMORY_DIGEST_TIMEOUT_MS: "abc" }), 9000);
  assert.equal(digestTimeoutMs({ CELL_MEMORY_DIGEST_TIMEOUT_MS: "-5" }), 9000);
});

// ── digest injection ladder (byte shapes are the pin) ────────────────────────

function ladderMemory({ digest = null, digestError = null, pages = [], pagesError = null } = {}) {
  return {
    async readDigest() {
      if (digestError) throw digestError;
      return digest;
    },
    async readShared() {
      if (pagesError) throw pagesError;
      return pages;
    },
  };
}

test("ladder: digest face wins — rendered block appended verbatim", async () => {
  const d = "## 记忆摘要 / Memory digest（fd-memory，截至 2026-10-25）\n\n### 相关记忆 / Related memory\n- 〔L2·experience｜置信 0.80｜2026-10-24〕集群巡检：先读 digest 再分派";
  const out = await memoryInjectionFor(ladderMemory({ digest: { digest: d } }), "c1", "本轮任务");
  assert.equal(out.source, "digest");
  assert.ok(out.prompt.startsWith("本轮任务\n\n## 记忆摘要"));
  assert.ok(!out.prompt.includes("【集群共享记忆】"), "digest block carries its own header, no legacy wrapper");
});

test("ladder: digest failure falls back to the exact historical title-list shape", async () => {
  const pages = [
    { title: "集群回合 2026-10-24 08:00", updated_at: "2026-10-24T00:00:00.000Z" },
    { title: "集群回合 2026-10-23 08:00", updated_at: "2026-10-23T00:00:00.000Z" },
  ];
  const out = await memoryInjectionFor(ladderMemory({ digestError: new Error("digest HTTP 503"), pages }), "c1", "本轮任务");
  assert.equal(out.source, "titles");
  assert.equal(out.prompt, "本轮任务\n\n【集群共享记忆】本集群此前回合的沉淀，供参考：\n- 集群回合 2026-10-24 08:00（2026-10-24）\n- 集群回合 2026-10-23 08:00（2026-10-23）");
});

test("ladder: both rungs fail → task prompt unchanged, no throw", async () => {
  const out = await memoryInjectionFor(ladderMemory({ digestError: new Error("x"), pagesError: new Error("y") }), "c1", "本轮任务");
  assert.equal(out.source, "none");
  assert.equal(out.prompt, "本轮任务");
});

test("ladder: CELL_MEMORY_DIGEST=0 skips only the digest rung (rollback lever); env k/budget ride the call", async () => {
  const seen = [];
  const mem = {
    async readDigest(_c, q, opts) {
      seen.push({ q, ...opts });
      return { digest: "## 记忆摘要" };
    },
    async readShared() { return []; },
  };
  const out = await memoryInjectionFor(mem, "c1", "任务A", { env: { CELL_MEMORY_DIGEST_K: "3", CELL_MEMORY_DIGEST_BUDGET: "800" } });
  assert.equal(out.source, "digest");
  assert.deepEqual(seen, [{ q: "任务A", k: 3, budget: 800 }]);
  const off = await memoryInjectionFor(mem, "c1", "任务A", { env: { CELL_MEMORY_DIGEST: "0" } });
  assert.equal(off.source, "none");
  assert.equal(seen.length, 1, "digest face skipped, titles face still reachable when digest lever is off");
});

test("ladder: null clusterMemory → no calls, prompt unchanged (switch off = byte-identical)", async () => {
  const out = await memoryInjectionFor(null, "c1", "本轮任务");
  assert.equal(out.source, "none");
  assert.equal(out.prompt, "本轮任务");
});

// ── chat lane (byte shapes are the pin) ──────────────────────────────────────

test("chat ladder: digest read targets project default; k/budget ride the shared env; block only appends", async () => {
  const seen = [];
  const mem = {
    async readDigest(project, q, opts) {
      seen.push({ project, q, ...opts });
      return { digest: "## 记忆摘要" };
    },
    async readShared() {
      return [];
    },
  };
  const out = await chatMemoryInjectionFor(mem, "帮我继续昨天的事", { env: { CELL_MEMORY_DIGEST_K: "6", CELL_MEMORY_DIGEST_BUDGET: "1200" } });
  assert.equal(out.source, "digest");
  assert.deepEqual(seen, [{ project: "default", q: "帮我继续昨天的事", k: 6, budget: 1200 }]);
  assert.ok(out.prompt.startsWith("帮我继续昨天的事"), "injection appends, never rewrites the user text");
});

test("chat ladder: CELL_MEMORY_CHAT_DIGEST=0 → byte-identical prompt, zero fd-memory calls", async () => {
  let anyCall = 0;
  const mem = {
    async readDigest() {
      anyCall += 1;
      return { digest: "## 记忆摘要" };
    },
    async readShared() {
      anyCall += 1;
      return [{ title: "旧沉淀", updated_at: "2026-10-24T00:00:00.000Z" }];
    },
  };
  const out = await chatMemoryInjectionFor(mem, "原文照旧", { env: { CELL_MEMORY_CHAT_DIGEST: "0" } });
  assert.equal(out.source, "none");
  assert.equal(out.prompt, "原文照旧");
  assert.equal(anyCall, 0, "total kill switch: neither digest nor titles face runs");
});

test("chat ladder: digest failure → generic working-memory title rung (historical bytes); both fail → unchanged", async () => {
  const pages = [{ title: "偏好：周报用中文", updated_at: "2026-10-24T00:00:00.000Z" }];
  const out = await chatMemoryInjectionFor(ladderMemory({ digestError: new Error("digest HTTP 503"), pages }), "继续");
  assert.equal(out.source, "titles");
  assert.equal(out.prompt, "继续\n\n【工作记忆】此前会话的沉淀，供参考：\n- 偏好：周报用中文（2026-10-24）");
  assert.ok(!out.prompt.includes("集群"), "chat rung must not carry cluster wording");
  const none = await chatMemoryInjectionFor(ladderMemory({ digestError: new Error("x"), pagesError: new Error("y") }), "继续");
  assert.equal(none.source, "none");
  assert.equal(none.prompt, "继续");
});

test("chat wiring: no identity or config off → prompt untouched, zero fetch", async () => {
  assert.equal(await chatPromptWithMemory(null, "原样"), "原样");
  const data = tmpData();
  try {
    const boom = async (u) => {
      throw new Error(`unexpected fetch ${u}`);
    };
    const env = { ...baseEnv(data), CELL_MEMORY_ENABLED: "0" };
    const email = `off-${Date.now()}@t.local`;
    assert.equal(await chatPromptWithMemory(email, "原样", env, boom), "原样");
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});
