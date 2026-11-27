#!/usr/bin/env node
// ── 两扇门写同一份规则：paas 这扇门也跑同一份夹具 ──────────────────────────
//
// 暂停/恢复只写一个字段——registry 条目的 `metadata.paused`——但有两扇门写它：
// 萬星门面的控制台，与壹座这边的 packs 面（`lib/agent-serving.js` 的
// `setAgentPaused`，`gateway/packs.js` 调用）。两扇门必须写**同一份**载荷，不然
// 症状是静默的：一边把 agent 停了、另一边看不见，或者恢复后留下一个
// `paused: false` 的形状让下一个消费者踩到。
//
// 判据是 vendored 的 `facet/contract/lifecycle-write.fixture.json`（萬星持有，
// 逐字节副本）。本测试不调断言层面的"等价"，而是捕获**真正要 PUT 出去的 body**
// 逐字段比对——等价物写法（先写 false 再删）在最终 body 上才看得出差别。
//
//   node --test scripts/test-wanxing-write-doors.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");

const fixture = JSON.parse(
  readFileSync(path.join(ROOT, "facet", "contract", "lifecycle-write.fixture.json"), "utf8"),
);

const { setAgentPaused } = await import("../lib/agent-serving.js");

// A fake registry: GET /api/agents<path> answers with the case's entry, and the
// PUT (or the register fallback) records exactly what this door tried to write.
function fakeRegistry(entry) {
  const written = [];
  const fetchImpl = async (url, init = {}) => {
    const method = (init.method ?? "GET").toUpperCase();
    if (method === "GET") {
      return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(entry)) };
    }
    written.push({ url, method, body: JSON.parse(init.body) });
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  return { fetchImpl, written };
}

test("write doors: the vendored fixture declares a revision and cases", () => {
  assert.match(fixture["x-contract-rev"], /^\d+$/);
  assert.ok(Array.isArray(fixture.cases) && fixture.cases.length >= 4);
});

for (const c of fixture.cases) {
  test(`write doors: paas packs surface writes the fixture payload — ${c.name}`, async () => {
    const { fetchImpl, written } = fakeRegistry(c.entry);
    await setAgentPaused({
      registryUrl: "http://registry.test",
      token: "tok",
      fetchImpl,
      agentPath: "/packs/p/a",
      paused: c.paused,
    });
    assert.equal(written.length, 1, "exactly one write per transition");
    assert.deepEqual(written[0].body, c.expect,
      `payload diverged from the fixture\n  expect ${JSON.stringify(c.expect)}\n  actual ${JSON.stringify(written[0].body)}`);
  });
}

test("write doors: resuming never leaves an explicit `paused: false` in the body", async () => {
  // The discriminating case: an implementation that assigns
  // `metadata.paused = false` passes an `=== false` check but fails this one.
  const { fetchImpl, written } = fakeRegistry({ metadata: { paused: true, rhythm: "0 8 * * *" } });
  await setAgentPaused({ registryUrl: "http://r", token: "t", fetchImpl, agentPath: "/packs/p/a", paused: false });
  const body = written[0].body;
  assert.equal("paused" in (body.metadata ?? {}), false, "resume must DELETE the key");
  assert.notEqual(body.metadata?.paused, false);
  assert.equal(body.metadata.rhythm, "0 8 * * *", "sibling metadata must survive");
});
