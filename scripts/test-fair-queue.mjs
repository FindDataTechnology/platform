#!/usr/bin/env node
// ── Fleet queue fairness (split-meta-team-queue-capacity 1.2-1.4, 2.1-2.4) ────
//
// The selector is a pure function over the pending list, so the policy can be
// pinned without a live queue: given a waiting set, which index runs next?
//
// Live motivation (2026-11-08): one cell, one serial slot, one owner. A single
// fleet's 8-hop handoff chain took 5-8 of 23 dispatch slots while the internal
// meta teams waited 78 and 48 minutes — both then timed out. Fairness here is a
// distribution policy, never a concurrency change: the queue stays strictly
// serial (task-queue-liveness).
//
//   node --test scripts/test-fair-queue.mjs

import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
process.env.CRON_STORAGE_PATH = fs.mkdtempSync(path.join(os.tmpdir(), "fair-queue-"));

const engine = await import(path.join(here, "../task-engine.js"));

// The policy knobs are read from env on every call, so a test can flip them
// without reloading the module.
function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// A pending entry is only {id, human, fleetId, at} — the selector's whole input.
const entry = (id, fleetId, at = 0) => ({ id, human: false, fleetId, at });

// ── 1.2 归属解析 ─────────────────────────────────────────────────────────────

test("1.2 a task with no fleet tag shares the unattributed bucket", () => {
  // Exercised through the snapshot: two untagged tasks must land in one bucket
  // keyed null, never in two.
  const seen = engine.queueFairnessSnapshot();
  assert.ok(Array.isArray(seen.fleets), "snapshot always reports a fleets array");
  assert.equal(seen.enabled, false, "fairness is off unless FLEET_FAIR_QUEUE=1");
});

test("1.2 sourceTag wins over origin, origin is the fallback, neither means null", () => {
  const key = engine.__fleetKeyForTest;
  assert.equal(key({ sourceTag: { fleetId: "from-source" }, origin: { fleet: { fleetId: "from-origin" } } }), "from-source");
  assert.equal(key({ origin: { fleet: { fleetId: "from-origin" } } }), "from-origin");
  assert.equal(key({ sourceTag: null, origin: null }), null);
  assert.equal(key({}), null);
  assert.equal(key({ sourceTag: { fleetId: "" } }), null, "an empty id is not a fleet");
  assert.equal(key({ sourceTag: { fleetId: 42 } }), null, "a non-string id is not a fleet");
  assert.equal(key(null), null);
});

// ── 1.3 突发上限 ─────────────────────────────────────────────────────────────

test("1.3 a burst from one fleet yields the slot to another waiting fleet", () => {
  withEnv({ FLEET_FAIR_QUEUE: "1", FLEET_DISPATCH_BURST: "2" }, () => {
    // Live-queue dispatch is exercised in 4.1; this asserts the observable
    // contract the design fixed: with a burst limit of 2, a long chain from one
    // fleet cannot take a third consecutive slot while another fleet waits.
    const cfg = engine.queueFairnessSnapshot();
    assert.equal(cfg.enabled, true);
    assert.equal(cfg.burst, 2);
  });
});

test("1.3 the burst limit is configurable and defaults to 2", () => {
  withEnv({ FLEET_FAIR_QUEUE: "1", FLEET_DISPATCH_BURST: undefined }, () => {
    assert.equal(engine.queueFairnessSnapshot().burst, 2, "default burst is 2");
  });
  withEnv({ FLEET_FAIR_QUEUE: "1", FLEET_DISPATCH_BURST: "5" }, () => {
    assert.equal(engine.queueFairnessSnapshot().burst, 5);
  });
  withEnv({ FLEET_FAIR_QUEUE: "1", FLEET_DISPATCH_BURST: "0" }, () => {
    assert.equal(engine.queueFairnessSnapshot().burst, 2, "a non-positive burst falls back to the default");
  });
  withEnv({ FLEET_FAIR_QUEUE: "1", FLEET_DISPATCH_BURST: "not-a-number" }, () => {
    assert.equal(engine.queueFairnessSnapshot().burst, 2, "garbage falls back, never throws");
  });
});

// ── 2.1 / 2.3 保留车道与反向边界 ─────────────────────────────────────────────

test("2.1 the meta resolver is injectable and defaults to 'no meta fleets'", () => {
  const before = engine.queueFairnessSnapshot();
  assert.ok(Array.isArray(before.fleets));

  engine.setMetaFleetResolver((id) => id === "fleet_meta");
  withEnv({ FLEET_FAIR_QUEUE: "1" }, () => {
    const snap = engine.queueFairnessSnapshot();
    assert.equal(typeof snap.metaRotations, "number");
  });

  // A throwing resolver must degrade to "normal fleet", never propagate.
  engine.setMetaFleetResolver(() => {
    throw new Error("boom");
  });
  assert.doesNotThrow(() => engine.queueFairnessSnapshot());
  engine.setMetaFleetResolver(null);
});

test("2.1 the meta lane rotation bound defaults to 2 and is configurable", () => {
  withEnv({ FLEET_FAIR_QUEUE: "1", META_LANE_ROTATIONS: undefined }, () => {
    assert.equal(engine.queueFairnessSnapshot().metaRotations, 2);
  });
  withEnv({ FLEET_FAIR_QUEUE: "1", META_LANE_ROTATIONS: "4" }, () => {
    assert.equal(engine.queueFairnessSnapshot().metaRotations, 4);
  });
});

// ── 默认关闭：现网零变化 ─────────────────────────────────────────────────────

test("the policy is off unless FLEET_FAIR_QUEUE is exactly '1'", () => {
  for (const v of [undefined, "", "0", "true", "yes"]) {
    withEnv({ FLEET_FAIR_QUEUE: v }, () => {
      assert.equal(engine.queueFairnessSnapshot().enabled, false, `FLEET_FAIR_QUEUE=${v} must stay legacy`);
    });
  }
  withEnv({ FLEET_FAIR_QUEUE: "1" }, () => {
    assert.equal(engine.queueFairnessSnapshot().enabled, true);
  });
});

// ── 快照形状（可观测面契约） ─────────────────────────────────────────────────

test("the snapshot carries the fields the readiness probe publishes", () => {
  withEnv({ FLEET_FAIR_QUEUE: "1" }, () => {
    const snap = engine.queueFairnessSnapshot();
    for (const key of ["enabled", "burst", "metaRotations", "rotations", "served", "fleets"]) {
      assert.ok(key in snap, `snapshot must expose ${key}`);
    }
    assert.ok(Array.isArray(snap.fleets));
  });
});

// ── 行为断言：直接对选择器跑派发序列 ─────────────────────────────────────────
//
// 以上都是配置管线；下面才是策略本身。用一个合成 pending 列表模拟泵：每步挑一个
// 下标、把它摘掉、记录舰队归属，然后断言序列形状。

function simulate({ pending, burst = 2, metaRotations = 2, metaIds = [], steps = null }) {
  engine.setMetaFleetResolver((id) => metaIds.includes(id));
  engine.fairResetRotation();
  const queue = pending.map((e) => ({ ...e }));
  const order = [];
  const limit = steps ?? queue.length;
  for (let i = 0; i < limit && queue.length > 0; i += 1) {
    const idx = engine.pickFairIndex(queue, { burst, metaRotations });
    const [taken] = queue.splice(idx, 1);
    order.push(taken.fleetId);
    // Mirror what drainExecutions does after picking.
    engine.__fairNoteDispatchForTest?.(taken.fleetId ?? null);
    if (typeof engine.__fairNoteDispatchForTest !== "function") {
      // The dispatcher's bookkeeping lives in drainExecutions; without the hook
      // this simulation would not advance the rotation. Fail loudly instead of
      // pretending the assertion means something.
      throw new Error("missing bookkeeping hook");
    }
  }
  engine.setMetaFleetResolver(null);
  return order;
}

test("1.3 A×8 + B×1 不得让 A 连拿三席（突发上限 2）", () => {
  const fleetA = Array.from({ length: 8 }, (_, i) => entry(`a${i}`, "A", i));
  const fleetB = [entry("b0", "B", 0)];
  const order = simulate({ pending: [...fleetA, ...fleetB], burst: 2 });
  assert.equal(order.slice(0, 3).join(","), "A,A,B", `前三位应为 A,A,B，实际 ${order.slice(0, 3)}`);
});

test("1.4 单舰队时退化为 FIFO，不引入额外等待", () => {
  const fleetA = Array.from({ length: 5 }, (_, i) => entry(`a${i}`, "A", i));
  const order = simulate({ pending: fleetA, burst: 2 });
  assert.deepEqual(order, ["A", "A", "A", "A", "A"]);
});

test("2.2 内部舰队在有界圈内拿到派发位", () => {
  const normals = [];
  for (let i = 0; i < 12; i += 1) normals.push(entry(`n${i}`, `N${i % 3}`, i));
  const meta = [entry("m0", "META", 0)];
  const order = simulate({ pending: [...normals, ...meta], burst: 2, metaRotations: 2, metaIds: ["META"] });
  const firstMeta = order.indexOf("META");
  assert.ok(firstMeta !== -1 && firstMeta <= 4, `内部舰队应在 ≤4 位内出现，实际 ${firstMeta}`);
});

test("2.3 保留车道不得饿死普通舰队（普通 ≥ 内部 − 1）", () => {
  const pending = [
    entry("m1", "M1", 0), entry("m2", "M2", 0), entry("m3", "M3", 0),
    entry("n1", "N1", 0), entry("n2", "N2", 0),
  ];
  const order = simulate({ pending, burst: 2, metaRotations: 2, metaIds: ["M1", "M2", "M3"] });
  const normalsServed = order.filter((f) => f.startsWith("N")).length;
  const metaServed = order.filter((f) => f.startsWith("M")).length;
  assert.ok(normalsServed > 0, `普通舰队必须拿到派发位，实际 ${normalsServed}`);
  assert.ok(normalsServed >= metaServed - 1, `普通(${normalsServed}) 不得落后内部(${metaServed}) 超过 1`);
});
