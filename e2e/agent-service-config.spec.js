// ── Agent service config e2e (agent-service-config, fast lane) ──────────────
//
// The serving config plane against the REAL cell server + the hermetic
// registry stub (now carrying an agent-entry store): publish a serving pack →
// deploy → the descriptor lands in the registry → the service-config routes
// read it back with provenance and rewrite it in place (GET-merge-PUT, the
// five-minute propagation contract).
//
// Scope note: the deploy/config path needs no runner — the runner side of the
// contract (per-deployment model derivation, drain-and-respawn on a model
// change) runs in the FAST LANE'S unit suite instead (scripts/test-agent-runner
// — the manager is exercised directly; there is no runner process in this
// harness). The model LANE gate is asserted here in its honest fast-lane
// environment: no billing plane configured ⇒ fail-closed, nothing lands.
//
//   npm run test:e2e -- e2e/agent-service-config.spec.js

import { expect, test } from "@playwright/test";

const REGISTRY = process.env.E2E_REGISTRY_URL || "http://127.0.0.1:4599";
const REGISTRY_TOKEN = process.env.E2E_REGISTRY_TOKEN || "e2e-registry-token";

const MANIFEST = {
  name: "配置流 e2e",
  description: "服务配置 e2e",
  tags: ["e2e"],
  skills: [],
  mcpServers: [],
  agents: [
    {
      id: "cfg-agent",
      name: "配置角色",
      persona: "你是配置测试角色。",
      serving: {
        protocol: "a2a",
        model: "e2e-m-in",
        modelWhitelist: ["e2e-m-in"],
        budget: { turnMinutes: 5 },
      },
    },
  ],
};

const entryOf = async (agentPath) => {
  const r = await fetch(`${REGISTRY}/api/agents${agentPath}`, {
    headers: { Authorization: `Bearer ${REGISTRY_TOKEN}` },
  });
  if (r.status === 404) return null;
  expect(r.ok, `registry stub GET failed (${r.status})`).toBeTruthy();
  return r.json();
};

async function publishAndDeploy(request, extra = {}) {
  const pub = await request.post("/api/packs", { data: { manifest: MANIFEST } });
  expect(pub.ok(), await pub.text()).toBeTruthy();
  const { id, version } = await pub.json();
  const dep = await request.post(`/api/packs/${id}/versions/${version}/deploy`, { data: extra });
  return { id, version, dep };
}

test("service config: the descriptor lands, reads back with provenance, and rewrites in place", async ({ page }) => {
  const { id, dep } = await publishAndDeploy(page.request);
  expect(dep.status(), await dep.text()).toBe(200);
  const deployed = (await dep.json()).deployed.find((d) => d.agentId === "cfg-agent");
  expect(deployed?.agentPath).toBeTruthy();

  // The descriptor landed on the registry entry with today's declaration as
  // the resolved effective values.
  let entry = await entryOf(deployed.agentPath);
  expect(entry?.metadata?.packVersion).toBe(1);
  expect(entry?.metadata?.effective_budget_minutes).toBe(5);
  expect(entry?.metadata?.effective_model).toBe("e2e-m-in");
  expect(entry?.metadata?.config_overrides).toBeUndefined();

  // Read face: effective value + provenance per dimension.
  const read = await page.request.get(`/api/packs/${id}/deployments/cfg-agent/config`);
  expect(read.status(), await read.text()).toBe(200);
  const cfg = (await read.json()).config;
  expect(cfg.rhythm).toMatchObject({ effective: null, source: "default" });
  expect(cfg.budgetMinutes).toMatchObject({ effective: 5, source: "declared" });
  expect(cfg.model).toMatchObject({ effective: "e2e-m-in", source: "declared" });

  // Write face: a rhythm pin lands as an override in the descriptor — the
  // five-minute propagation contract is stated on the response.
  const put = await page.request.put(`/api/packs/${id}/deployments/cfg-agent/config`, {
    data: { rhythm: [{ every: "1h" }] },
  });
  expect(put.status(), await put.text()).toBe(200);
  expect((await put.json()).effectiveWithinSecs).toBe(300);
  entry = await entryOf(deployed.agentPath);
  expect(entry.metadata.effective_rhythm).toEqual([{ every: "1h" }]);
  expect(entry.metadata.config_overrides).toEqual({ rhythm: [{ every: "1h" }] });
  expect(entry.metadata.effective_budget_minutes).toBe(5);

  // Read face flips the provenance; a clear (null) returns to the declaration.
  const read2 = await page.request.get(`/api/packs/${id}/deployments/cfg-agent/config`);
  expect((await read2.json()).config.rhythm.source).toBe("override");
  const clear = await page.request.put(`/api/packs/${id}/deployments/cfg-agent/config`, {
    data: { rhythm: null },
  });
  expect(clear.status(), await clear.text()).toBe(200);
  entry = await entryOf(deployed.agentPath);
  expect(entry.metadata.effective_rhythm).toBeUndefined();
  expect(entry.metadata.config_overrides).toEqual({ rhythm: null });

  // Unknown dimensions refuse and change nothing (shape discipline).
  const junk = await page.request.put(`/api/packs/${id}/deployments/cfg-agent/config`, {
    data: { persona: "x" },
  });
  expect(junk.status()).toBe(400);
  expect((await entryOf(deployed.agentPath)).metadata.effective_model).toBe("e2e-m-in");
});

test("service config: model writes are fail-closed without a validating billing plane", async ({ page }) => {
  const { id, dep } = await publishAndDeploy(page.request);
  expect(dep.status(), await dep.text()).toBe(200);
  const deployed = (await dep.json()).deployed.find((d) => d.agentId === "cfg-agent");
  const before = await entryOf(deployed.agentPath);

  // The config-write lane gate: no sub2api admin key in this harness ⇒ no
  // lanes to validate against ⇒ the inactive plane refuses, nothing lands.
  const put = await page.request.put(`/api/packs/${id}/deployments/cfg-agent/config`, {
    data: { model: "e2e-m-in" },
  });
  expect(put.status()).toBe(503);
  expect((await put.json()).error).toMatch(/billing plane not configured/);
  const after = await entryOf(deployed.agentPath);
  expect(after.metadata.config_overrides).toEqual(before.metadata.config_overrides);
  expect(after.metadata.effective_model).toBe("e2e-m-in", "the declared default is untouched");

  // A deploy-time model rides the same gate: the deploy refuses and no entry
  // is (re)written for a second agent id (fresh pack, fresh agent path).
  const pub = await page.request.post("/api/packs", {
    data: { manifest: { ...MANIFEST, name: "配置流 e2e 2", agents: [{ ...MANIFEST.agents[0], id: "cfg-agent-2" }] } },
  });
  expect(pub.ok(), await pub.text()).toBeTruthy();
  const { id: id2, version: v2 } = await pub.json();
  const dep2 = await page.request.post(`/api/packs/${id2}/versions/${v2}/deploy`, {
    data: { models: { "cfg-agent-2": "e2e-m-in" } },
  });
  expect(dep2.status()).toBe(503);
  expect(await entryOf(`/packs/${id2}/cfg-agent-2`)).toBeNull();
});