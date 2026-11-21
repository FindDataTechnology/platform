// ── Facade species absorbs AgentCards (unify-supply-spine-lineage 5.1/5.2) ───
//
//   node --test scripts/test-supply-catalog-facade.mjs
//
// 钉住三条：
//   1. 每个 facade 行都有 `runnable`（installable|reachable）与 `deployment.state`；
//   2. 「只注册未部署」的 AgentCard 出现在目录里（state=undeployed），
//      而不是因为「没有 serving 记录」被丢掉——那会把「有什么」和「跑什么」
//      变成同一个集合，正是本物种存在的理由；
//   3. 同一 agent 不得出现两条（部署面优先），否则 facade 计数会与任何拿
//      服务面做对账的闸不一致。
//
// 装配的是 server 实际用的纯函数（facet/supply-catalog.js），不是复制品。
import { test } from "node:test";
import assert from "node:assert/strict";

import { projectFacadeEntries, UNDEPLOYED } from "../facet/supply-catalog.js";

const served = [
  { slug: "live-one", name: "Live One", description: "serving", status: "idle" },
  { slug: "live-two", name: "Live Two", description: "serving", status: "serving" },
];

test("every facade row carries runnable and deployment.state", () => {
  const { facades } = projectFacadeEntries(served, { asOf: "2026-11-21" });
  assert.equal(facades.length, 2);
  for (const f of facades) {
    assert.ok(["installable", "reachable"].includes(f.runnable), `${f.id} runnable`);
    assert.ok(f.deployment && typeof f.deployment.state === "string", `${f.id} deployment.state`);
  }
});

test("a registered-but-undeployed agent appears as an undeployed facade", () => {
  const { facades } = projectFacadeEntries([], {
    registrations: [{ slug: "card-only", name: "Card Only", description: "registered" }],
    asOf: "2026-11-21",
  });
  assert.equal(facades.length, 1);
  const f = facades[0];
  assert.equal(f.id, "card-only");
  assert.equal(f.runnable, "reachable");
  assert.equal(f.deployment.state, UNDEPLOYED);
  assert.equal(f.deployment.provenance, "registry-agentcard");
});

test("a deployed agent is not also added from its AgentCard", () => {
  const { facades } = projectFacadeEntries(served, {
    registrations: [
      { slug: "live-one", name: "Duplicate name" },
      { slug: "card-only", name: "Card Only" },
    ],
    asOf: "2026-11-21",
  });
  const ids = facades.map((f) => f.id);
  assert.equal(ids.filter((i) => i === "live-one").length, 1, "one row per agent");
  assert.equal(facades.find((f) => f.id === "live-one").name, "Live One", "serving plane wins");
  assert.equal(facades.length, 3);
});

test("a serving status is not overwritten by the undeployed default", () => {
  const { facades } = projectFacadeEntries(served, { asOf: "2026-11-21" });
  const one = facades.find((f) => f.id === "live-one");
  assert.equal(one.deployment.state, "idle", "the serving plane's reported status is authoritative");
  assert.notEqual(one.deployment.state, UNDEPLOYED);
});

test("the species enumeration is untouched", async () => {
  const mod = await import("../facet/supply-catalog.js");
  assert.deepEqual(mod.SUPPLY_SPECIES, ["pack", "skill", "mcp", "facade", "data-anchor", "plugin"]);
  assert.equal(mod.SUPPLY_SPECIES_VERSION, 2);
});
