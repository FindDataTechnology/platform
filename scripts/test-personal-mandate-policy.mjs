// 个人委托状 · 存储与迁移 (add-personal-mandate 2.1-2.4)
//
// 这一组钉的是「升级即等价」：v2 结构写进去之后，deputy 路径读到的
// routes/maxSeverity/dailyBudget 必须与升级前逐字段相同；未声明的域不得因为
// 升级而获得任何执行额度。
//
// Run: node --test scripts/test-personal-mandate-policy.mjs

import { test, before } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import express from "express";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "personal-mandate-"));
process.env.CRON_STORAGE_PATH = tmpRoot;
process.env.DB_PATH = path.join(tmpRoot, "app.db");
process.env.PLATFORM_DATA_DIR = tmpRoot;
process.env.DSH_HOME = path.join(tmpRoot, "dsh");
fs.mkdirSync(process.env.DSH_HOME, { recursive: true });

const { initDb } = await import("../db.js");
const { createFleetRoutes } = await import("../server/routes/fleets.js");
const {
  createFleetDatabase,
  setFleetDatabase,
  normalizeDelegationPolicy,
  routeForItem,
  delegationToMandate,
  mandateToBlob,
  opsModeForEnabled,
} = await import("../server/routes/fleets-db.js");
const { DECISION, MODES, resolveMandate } = await import("../lib/personal-mandate.js");

await initDb();
const fleetDb = createFleetDatabase({});
setFleetDatabase(fleetDb);

const FLEET = "fleet_mandate_1";
const OWNER = "owner@test";

before(() => {
  fleetDb.createFleet({ id: FLEET, name: "委托状舰队", ownerEmail: OWNER });
});

// ── 2.1 既有归一化签名与语义不变 ─────────────────────────────────────────────

test("2.1 normalizeDelegationPolicy keeps its shape and hard gates", () => {
  const p = normalizeDelegationPolicy(
    { enabled: true, routes: { "config-change": "deputy", hr: "deputy", spend: "deputy", "routine-ops": "deputy" } },
    null,
  );
  assert.equal(p.routes["config-change"], "owner");
  assert.equal(p.routes.hr, "owner");
  assert.equal(p.routes.spend, "owner");
  assert.equal(p.routes["routine-ops"], "deputy");
  assert.equal(p.enabled, true);
  assert.equal(typeof p.maxSeverity, "string");
  assert.equal(typeof p.dailyBudget, "number");
});

// ── 2.2 惰性迁移：读旧写新，legacy 字段镜像 ──────────────────────────────────

test("2.2 a legacy blob reads as v2 ops without losing its fields", () => {
  const legacy = {
    enabled: true,
    routes: { "routine-ops": "deputy", "infra-ticket": "deputy-triage", default: "owner" },
    maxSeverity: "low",
    dailyBudget: 9,
    model: "m1",
    digest: "weekly",
    deputyMemberId: "m_deputy",
  };
  const v2 = delegationToMandate(legacy, null);
  const ops = v2.domains.ops;
  assert.equal(v2.version, 2);
  assert.equal(ops.enabled, true);
  assert.equal(ops.maxSeverity, "low");
  assert.equal(ops.dailyBudget, 9);
  assert.equal(ops.model, "m1");
  assert.equal(ops.digest, "weekly");
  assert.equal(ops.deputyMemberId, "m_deputy");
  assert.equal(ops.mode, MODES.draft);
});

test("2.2 ops mode is conservative: disabled delegation is advise, never auto", () => {
  assert.equal(opsModeForEnabled(false), MODES.advise);
  assert.equal(opsModeForEnabled(true), MODES.draft);
  const v2 = delegationToMandate({ enabled: false }, null);
  assert.equal(v2.domains.ops.mode, MODES.advise);
});

test("2.2 a v2 write mirrors the ops legacy fields on the top level", () => {
  const blob = mandateToBlob({
    version: 2,
    domains: {
      ops: {
        mode: "advise",
        enabled: true,
        routes: { "routine-ops": "deputy", default: "owner" },
        maxSeverity: "normal",
        dailyBudget: 12,
        model: "m3",
        digest: "daily",
        deputyMemberId: "m_dep",
      },
      "external-comms": { mode: "draft", discloseScope: ["public"] },
    },
  });
  assert.equal(blob.version, 2);
  assert.equal(blob.enabled, true);
  assert.equal(blob.dailyBudget, 12);
  assert.equal(blob.maxSeverity, "normal");
  assert.deepEqual(blob.domains["external-comms"].discloseScope, ["public"]);
  // The deputy reader still sees a flat shape.
  const legacyView = normalizeDelegationPolicy(blob, null);
  assert.equal(legacyView.dailyBudget, 12);
  assert.equal(legacyView.routes["routine-ops"], "deputy");
});

test("2.2 setFleetMandatePolicy persists a v2 blob readable by both readers", () => {
  fleetDb.setFleetMandatePolicy(FLEET, {
    version: 2,
    domains: {
      ops: {
        mode: "advise",
        enabled: true,
        routes: { "routine-ops": "deputy", default: "owner" },
        maxSeverity: "normal",
        dailyBudget: 11,
      },
      advancement: { mode: "draft", limits: { count: 3 } },
    },
  });

  const raw = fleetDb.getFleetDelegationPolicyRaw(FLEET);
  assert.equal(raw.version, 2);

  const deputyView = fleetDb.getFleetDelegationPolicy(FLEET);
  assert.equal(deputyView.dailyBudget, 11);
  assert.equal(deputyView.routes["routine-ops"], "deputy");

  const mandateView = fleetDb.getFleetMandatePolicy(FLEET);
  assert.equal(mandateView.domains.advancement.mode, "draft");
  assert.equal(mandateView.domains.advancement.limits.count, 3);
});

test("2.2 setFleetMandatePolicy rejects an unknown domain instead of storing it", () => {
  const before = fleetDb.getFleetDelegationPolicyRaw(FLEET);
  const result = fleetDb.setFleetMandatePolicy(FLEET, {
    version: 2,
    domains: { "extrnal-comms": { mode: "draft" } },
  });
  assert.equal(result, null);
  const after = fleetDb.getFleetDelegationPolicyRaw(FLEET);
  assert.deepEqual(after, before, "a rejected write must not touch storage");
});

// ── 2.3 等价性：升级后 deputy 路由逐格相同 ───────────────────────────────────

test("2.3 routeForItem is identical before and after the v2 write (matrix)", () => {
  const categories = ["routine-ops", "infra-ticket", "config-change", "hr", "spend", null];
  const severities = ["low", "normal", "high"];

  const policies = [
    { enabled: false },
    { enabled: true },
    { enabled: true, maxSeverity: "low", routes: { "routine-ops": "owner", "infra-ticket": "deputy" } },
    { enabled: true, maxSeverity: "high", dailyBudget: 3, routes: { "routine-ops": "deputy-triage" } },
  ];

  // Cell-level policies go to the CELL key on purpose: cell storage replaces the
  // routes object, fleet storage merges into it. Writing a cell policy into the
  // fleet column would silently switch merge semantics and resurrect defaults.
  for (const [index, cellPolicy] of policies.entries()) {
    const fleetId = `fleet_eq_${index}`;
    fleetDb.createFleet({ id: fleetId, name: `等价${index}`, ownerEmail: OWNER });

    const legacyView = normalizeDelegationPolicy(cellPolicy, null);

    fleetDb.setCellMandatePolicy(cellPolicy);
    const upgradedCell = fleetDb.getFleetDelegationPolicy(fleetId);

    for (const category of categories) {
      for (const severity of severities) {
        const item = { category, severity };
        assert.equal(
          routeForItem(item, upgradedCell),
          routeForItem(item, legacyView),
          `cell mismatch for policy#${index} category=${category} severity=${severity}`,
        );
      }
    }
  }
});

test("2.3 a fleet override stays equivalent and never resurrects absent keys", () => {
  const cellPolicy = {
    enabled: true,
    routes: { "infra-ticket": "owner", default: "owner" },
    maxSeverity: "normal",
  };
  fleetDb.setCellMandatePolicy(cellPolicy);

  const fleetId = "fleet_eq_override";
  fleetDb.createFleet({ id: fleetId, name: "覆写等价", ownerEmail: OWNER });

  // The override only speaks about routine-ops. infra-ticket must stay at the
  // cell's `owner`, not fall back to DEFAULT's `deputy-triage`.
  const override = { routes: { "routine-ops": "deputy" } };
  fleetDb.setFleetMandatePolicy(fleetId, override);

  const legacyView = normalizeDelegationPolicy(cellPolicy, override);
  const upgraded = fleetDb.getFleetDelegationPolicy(fleetId);

  for (const category of ["routine-ops", "infra-ticket", "config-change", "hr", "spend", null]) {
    for (const severity of ["low", "normal", "high"]) {
      assert.equal(
        routeForItem({ category, severity }, upgraded),
        routeForItem({ category, severity }, legacyView),
        `override mismatch category=${category} severity=${severity}`,
      );
    }
  }
  assert.equal(upgraded.routes["infra-ticket"], "owner", "absent key must not be resurrected from defaults");
});

// ── 2.4 未声明域不获得任何执行能力 ───────────────────────────────────────────

test("2.4 an unconfigured domain resolves to advise with zero quota", () => {
  fleetDb.setFleetMandatePolicy(FLEET, {
    version: 2,
    domains: { ops: { mode: "advise", enabled: true, dailyBudget: 5 } },
  });
  const policy = fleetDb.getFleetMandatePolicy(FLEET);

  const res = resolveMandate({
    policy,
    domain: "external-comms",
    action: { id: "chat.message.send", risk: "write", revocable: true },
    principal: { kind: "agent" },
  });
  assert.equal(res.decision, DECISION.ADVISE);
  assert.deepEqual(res.reasons, ["no_policy"]);
});

test("2.4 a fleet override can tighten the cell default but not widen it", () => {
  fleetDb.setCellMandatePolicy({
    version: 2,
    domains: { advancement: { mode: "act-notify", limits: { count: 4 } } },
  });

  const widened = delegationToMandate(
    { version: 2, domains: { advancement: { mode: "act-notify" } } },
    { version: 2, domains: { advancement: { mode: "act-silent" } } },
  );
  assert.equal(widened.domains.advancement.mode, "act-notify", "override may not raise the mode");

  const tightened = delegationToMandate(
    { version: 2, domains: { advancement: { mode: "act-notify" } } },
    { version: 2, domains: { advancement: { mode: "draft" } } },
  );
  assert.equal(tightened.domains.advancement.mode, "draft");
});

// ── 2.4 读写端点 ────────────────────────────────────────────────────────────

test("2.4 the policy endpoint exposes and accepts the domain-level mandate", async () => {
  const ctx = { authEnabled: false, cellUserEmail: OWNER, currentPreset: null };
  const app = express();
  app.use(express.json());
  createFleetRoutes(app, ctx);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (method, p, body) =>
    fetch(`${base}${p}`, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

  try {
    // Write a domain-level mandate.
    const put = await call("PUT", "/api/fleets/delegation-policy", {
      scope: "cell",
      mandate: { version: 2, domains: { "external-comms": { mode: "draft", discloseScope: ["public"] } } },
    });
    assert.equal(put.status, 200);
    assert.equal(put.body.mandate.domains["external-comms"].mode, "draft");

    // Read it back; the legacy flattened view must still be present and valid.
    const got = await call("GET", "/api/fleets/delegation-policy");
    assert.equal(got.status, 200);
    assert.equal(got.body.mandate.domains["external-comms"].mode, "draft");
    assert.ok(got.body.effective);

    // An unknown domain is a structured 400, not a silent write.
    const bad = await call("PUT", "/api/fleets/delegation-policy", {
      scope: "cell",
      mandate: { version: 2, domains: { "no-such-domain": { mode: "draft" } } },
    });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /unknown domain/);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
