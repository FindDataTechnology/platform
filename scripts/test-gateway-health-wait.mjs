#!/usr/bin/env node
// ── The shared "wait until the server answers" helper, pinned ────────────────
//
// Eight fixtures used to carry their own copy of this loop with drifting budgets
// (20s in three of them, 30s in two). This file pins the helper's arithmetic and
// text so a later edit cannot quietly reintroduce a 20s bound, and one structural
// assertion keeps the copies from growing back.

import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_HEALTH_BUDGET_MS,
  DEFAULT_HEALTH_INTERVAL_MS,
  healthBudgetMs,
  healthTries,
  waitForHealthy,
} from "./lib/wait-for-health.mjs";

const SCRIPTS = path.dirname(fileURLToPath(import.meta.url));

/** A throwaway HTTP server answering `status` on every path. */
async function serve(status) {
  const srv = createServer((_req, res) => {
    res.statusCode = status;
    res.end("ok");
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const { port } = srv.address();
  return { base: `http://127.0.0.1:${port}`, close: () => new Promise((r) => srv.close(r)) };
}

test("预算缺省 30 秒 —— 与 app-pairing 已论证过的口径一致，环境变量只能放大", () => {
  assert.equal(DEFAULT_HEALTH_BUDGET_MS, 30_000);
  assert.equal(healthBudgetMs({}), 30_000);
  assert.equal(healthBudgetMs({ HEALTH_BUDGET_MS: "90000" }), 90_000);
  // 荒谬值不许把预算缩成 0（那会让每个用例立即假红）
  assert.equal(healthBudgetMs({ HEALTH_BUDGET_MS: "0" }), 30_000);
  assert.equal(healthBudgetMs({ HEALTH_BUDGET_MS: "abc" }), 30_000);
  assert.equal(healthBudgetMs({ HEALTH_BUDGET_MS: "-5" }), 30_000);
});

test("轮询次数按预算算：30s/250ms=120，60s/100ms=600，预算再小也至少一次", () => {
  assert.equal(healthTries(30_000, 250), 120);
  assert.equal(healthTries(60_000, 100), 600);
  assert.equal(healthTries(10, 250), 1);
  assert.equal(DEFAULT_HEALTH_INTERVAL_MS, 250);
});

test("起来了就立刻返回，等的时间远小于预算", async () => {
  const s = await serve(200);
  try {
    const waited = await waitForHealthy(s.base, { budgetMs: 5_000, intervalMs: 20 });
    assert.ok(waited < 1_000, `等了 ${waited}ms —— 健康了却还在等`);
  } finally {
    await s.close();
  }
});

test("一直不健康 ⇒ 抛错且把预算与实际等待都念出来", async () => {
  const s = await serve(503);
  try {
    await assert.rejects(
      () => waitForHealthy(s.base, { budgetMs: 200, intervalMs: 50 }),
      (err) => {
        assert.match(err.message, /never became healthy within 200ms/);
        assert.match(err.message, /waited \d+ms/);
        assert.match(err.message, /\/healthz/);
        return true;
      },
    );
  } finally {
    await s.close();
  }
});

test("子进程已退出就早退，不把预算耗满", async () => {
  const s = await serve(503);
  try {
    const started = Date.now();
    await assert.rejects(
      () =>
        waitForHealthy(s.base, {
          budgetMs: 10_000,
          intervalMs: 20,
          onDead: () => true,
          failMessage: (waited) => `gateway exited early (waited ${waited}ms)`,
        }),
      /gateway exited early \(waited \d+ms\)/,
    );
    assert.ok(Date.now() - started < 2_000, "早退路径把预算耗满了");
  } finally {
    await s.close();
  }
});

test("failMessage 能把调用方自己的文案与子进程日志接回去（含 dead 分支）", async () => {
  const s = await serve(503);
  try {
    await assert.rejects(
      () =>
        waitForHealthy(s.base, {
          budgetMs: 100,
          intervalMs: 50,
          failMessage: (waited, { dead }) => `${dead ? "exited early" : "never became healthy"}:\n[err] boot failed (${waited}ms)`,
        }),
      /never became healthy:\n\[err\] boot failed \(\d+ms\)/,
    );
    await assert.rejects(
      () =>
        waitForHealthy(s.base, {
          budgetMs: 100,
          intervalMs: 50,
          onDead: () => true,
          failMessage: (_waited, { dead }) => `${dead ? "exited early" : "never became healthy"}:\n[err] boot failed`,
        }),
      /exited early:\n\[err\] boot failed/,
    );
  } finally {
    await s.close();
  }
});

test("init 透传给 fetch、accept 决定什么叫就绪（cell-isolation 要的是 200，不是任意 2xx）", async () => {
  const s = await serve(200);
  try {
    let seenHeader;
    const waited = await waitForHealthy(s.base, {
      path: "/api/ready",
      budgetMs: 5_000,
      intervalMs: 20,
      init: { headers: { "x-cell-identity": "user-a" } },
      accept: (res) => {
        seenHeader = res.status;
        return res.status === 200;
      },
    });
    assert.ok(waited >= 0);
    assert.equal(seenHeader, 200, "accept 没被调用，init 也没走这条路径");
  } finally {
    await s.close();
  }
  // accept 说「不算就绪」⇒ 只能耗尽预算报错，不许被 .ok 悄悄放过去
  const s2 = await serve(204);
  try {
    await assert.rejects(
      () => waitForHealthy(s2.base, { budgetMs: 150, intervalMs: 50, accept: (r) => r.status === 200 }),
      /never became healthy/,
    );
  } finally {
    await s2.close();
  }
});

// ── Structural: the copies must not grow back ───────────────────────────────
//
// The signature of a hand-rolled copy is *giving up* on a probe counter compared
// against a literal — `if (i === 79) throw new Error("... never became healthy")`.
// That exact shape must not come back; `if (i === 0) assert...` is a different
// thing (an assertion on the first iteration, no timeout) and stays allowed.
//
// NOT in this list on purpose: `test-cell-auth-paths.mjs` and
// `test-cell-workspace.mjs` also loop `i < 100`, but they poll for a
// `spawn-dump.json` to *parse* (`readDump`), not for a server to answer — a
// different wait with a different failure mode, so folding them in would only
// blur what the assertion means.
const CONVERTED = [
  "test-cell-gateway.mjs",
  "test-cell-bindings.mjs",
  "test-cell-isolation.mjs",
  "test-gateway-sessionless.mjs",
  "test-onboarding-hosted.mjs",
  "test-session-share.mjs",
  "test-mp-auth.mjs",
  "test-mp-demo.mjs",
  "test-app-pairing.mjs",
];

test("收编过的文件不许再自己数探测次数（不允许出现 `i === <字面量>` 判超时）", () => {
  const offenders = [];
  for (const name of CONVERTED) {
    const src = readFileSync(path.join(SCRIPTS, name), "utf8");
    const handRolled = /if\s*\(\s*i\s*===\s*\d+\s*\)\s*throw\b/.test(src);
    const imports = /wait-for-health\.mjs/.test(src);
    if (handRolled) offenders.push(`${name}: 仍在自己数探测次数`);
    if (!imports) offenders.push(`${name}: 没有引用 scripts/lib/wait-for-health.mjs`);
  }
  assert.deepEqual(offenders, [], `这些文件还没收编到共用入口：\n  ${offenders.join("\n  ")}`);
});
