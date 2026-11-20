#!/usr/bin/env node
// ── Facet-owned fleet plane (facet-owns-its-fleets 1.x/2.x/3.x) ─────────────
//
// Pins the promises this change makes, all against the facet's OWN store:
//
//   1.1/1.2  the store creates fleets/members/edges, WAL, origin default,
//            harness column present.
//   1.3      origin='platform' ⇒ every write is a 409 whose body says why.
//   2.1      the route module carries NO cross-domain call (grep-level check).
//   2.2      the read face answers JSON for a signed-in caller and 401 anon;
//            the by-slug console is anonymous but only for a published slug.
//   2.3      each write route: success, platform-origin 409, anonymous 401.
//   2.4      a fresh fleet's console view model carries executor:null and no
//            post claims a running state (只管不跑).
//   3.3      the facet console view model's organization facts match a second
//            build of the same store (same-component isomorphism, host-free).
//
//   node --test scripts/test-facet-fleets.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmp = mkdtempSync(path.join(tmpdir(), "facet-fleets-"));
test.after(() => rmSync(tmp, { recursive: true, force: true }));

const { createFleetDatabase } = await import("../facet/fleets-db.js");
const { registerFleetRoutes } = await import("../facet/fleets-routes.js");

// Test identity rides a header (mirrors scripts/test-blueprints.mjs): the real
// facet resolves the OIDC cookie, which a unit test cannot mint.
function mount({ dbFile = path.join(mkdtempSync(path.join(tmp, "db-")), "fleets.db") } = {}) {
  const db = createFleetDatabase({ file: dbFile });
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use((req, _res, next) => {
    const email = req.headers["x-test-user"];
    req.user = typeof email === "string" && email ? { email, groups: [] } : null;
    next();
  });
  registerFleetRoutes(app, { resolveUser: (req) => req.user, dataRoot: tmp, fleetDb: db });
  const server = app.listen(0, "127.0.0.1");
  return { server, db, dbFile };
}

async function ready(server) {
  await new Promise((r) => server.once("listening", r));
  return `http://127.0.0.1:${server.address().port}`;
}
const as = (email, init = {}) => ({
  ...init,
  headers: { "Content-Type": "application/json", ...(email ? { "x-test-user": email } : {}), ...(init.headers ?? {}) },
});
const close = (server) => new Promise((r) => server.close(r));

const SEED_MEMBERS = [
  { ref: "lead", title: "主编", cadence: { cron: "0 9 * * *", tz: "Asia/Shanghai" }, kpiSlots: [{ key: "briefs", label: "简报" }], harness: "acp-claude-code" },
  { ref: "writer", title: "撰写", parentRef: "lead", harness: "dsh" },
];
const SEED_EDGES = [{ kind: "report", from: "writer", to: "lead" }];

// ── 1.1 / 1.2 data layer ────────────────────────────────────────────────────
test("1.1 createFleetDatabase creates a fleet/member/edge store (WAL + camelCase API)", () => {
  const file = path.join(mkdtempSync(path.join(tmp, "db-")), "fleets.db");
  const db = createFleetDatabase({ file });
  try {
    const fleet = db.createFleet({ id: "flt_a", name: "内容工作室", ownerEmail: "alice@x" });
    assert.equal(fleet.origin, "facet", "origin defaults to facet");
    assert.equal(db.listFleets().length, 1);
    const m = db.createMember({ id: "fm_a", fleetId: "flt_a", title: "主编", harness: "dsh", kpiSlots: [{ key: "k", label: "K" }] });
    assert.equal(m.harness, "dsh");
    assert.deepEqual(m.kpiSlots, [{ key: "k", label: "K" }]);
    db.createEdge({ id: "fe_a", fleetId: "flt_a", kind: "report", from: "fm_a", to: "fm_a" });
    assert.equal(db.listEdges("flt_a").length, 1);
    const mode = db.db.pragma("journal_mode", { simple: true });
    assert.equal(String(mode).toLowerCase(), "wal");
  } finally {
    db.close();
  }
});

test("1.2 fleets carry an origin column and members a harness column", () => {
  const file = path.join(mkdtempSync(path.join(tmp, "db-")), "fleets.db");
  const db = createFleetDatabase({ file });
  try {
    const fleetCols = db.db.prepare("PRAGMA table_info(fleets)").all().map((c) => c.name);
    const memberCols = db.db.prepare("PRAGMA table_info(fleet_members)").all().map((c) => c.name);
    assert.ok(fleetCols.includes("origin"), "fleets.origin present");
    assert.ok(memberCols.includes("harness"), "fleet_members.harness present");
    // origin only accepts the two declared values via createFleet's coercion.
    const unknown = db.createFleet({ id: "flt_u", name: "x", ownerEmail: "a@x", origin: "elsewhere" });
    assert.equal(unknown.origin, "facet");
  } finally {
    db.close();
  }
});

// ── 2.1 no cross-domain call in the route module ────────────────────────────
test("2.1 fleets-routes.js contains no platform URL and no outbound fetch(", () => {
  const src = readFileSync(path.join(ROOT, "facet/fleets-routes.js"), "utf8");
  assert.equal(src.includes("PLATFORM_INTERNAL_URL"), false, "no platform env reference");
  assert.equal(/\bfetch\s*\(/.test(src), false, "no outbound fetch call in the route module");
});

// ── 2.2 read face ───────────────────────────────────────────────────────────
test("2.2 read face: anon 401, owner reads own list, by-slug share gated", async () => {
  const { server, db } = mount();
  const base = await ready(server);
  try {
    assert.equal((await fetch(`${base}/api/fleets`, as(null))).status, 401);
    assert.equal((await fetch(`${base}/api/fleets/flt_x`, as(null))).status, 401);

    const created = await fetch(`${base}/api/fleets`, as("alice@x", { method: "POST", body: JSON.stringify({ name: "电商团队", members: SEED_MEMBERS, edges: SEED_EDGES }) }))
      .then((r) => r.json());
    const id = created.fleet.id;

    const list = await fetch(`${base}/api/fleets`, as("alice@x")).then((r) => r.json());
    assert.equal(list.fleets.length, 1);
    assert.equal(list.executor, null);
    // Another user's list is empty and their detail read 404s (no existence leak).
    assert.deepEqual((await fetch(`${base}/api/fleets`, as("bob@x")).then((r) => r.json())).fleets, []);
    assert.equal((await fetch(`${base}/api/fleets/${id}`, as("bob@x"))).status, 404);

    // Unpublished ⇒ the anonymous by-slug read is 404, identical to unknown.
    assert.equal((await fetch(`${base}/api/fleets/by-slug/nope/console`)).status, 404);
    // Publish, then the share read works anonymously.
    await fetch(`${base}/api/fleets/${id}`, as("alice@x", { method: "PATCH", body: JSON.stringify({ published: true }) }));
    const slug = db.getFleet(id).consoleSlug;
    assert.ok(slug, "publishing derives a slug");
    const share = await fetch(`${base}/api/fleets/by-slug/${encodeURIComponent(slug)}/console`).then((r) => r.json());
    assert.equal(share.surface, "share");
    assert.equal(share.fleet.name, "电商团队");
  } finally {
    await close(server);
  }
});

// ── 2.3 write face, all three paths per route ───────────────────────────────
test("2.3 PATCH fleet: success, platform-origin 409, anonymous 401", async () => {
  const { server, db } = mount();
  const base = await ready(server);
  try {
    const facet = db.createFleet({ id: "flt_f", name: "本域队", ownerEmail: "alice@x" });
    const plat = db.createFleet({ id: "flt_p", name: "平台队", ownerEmail: "alice@x", origin: "platform" });

    // success
    const ok = await fetch(`${base}/api/fleets/${facet.id}`, as("alice@x", { method: "PATCH", body: JSON.stringify({ state: "active", name: "改名" }) }));
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.equal(body.fleet.name, "改名");
    assert.equal(body.fleet.state, "active");

    // platform-origin gate
    const denied = await fetch(`${base}/api/fleets/${plat.id}`, as("alice@x", { method: "PATCH", body: JSON.stringify({ name: "x" }) }));
    assert.equal(denied.status, 409);
    assert.match((await denied.json()).error, /平台|platform/);

    // anonymous
    assert.equal((await fetch(`${base}/api/fleets/${facet.id}`, as(null, { method: "PATCH", body: "{}" }))).status, 401);
  } finally {
    await close(server);
  }
});

test("2.3 PATCH member: success, platform-origin 409, anonymous 401", async () => {
  const { server, db } = mount();
  const base = await ready(server);
  try {
    const facet = db.createFleet({ id: "flt_f", name: "队", ownerEmail: "alice@x" });
    const m = db.createMember({ id: "fm_1", fleetId: facet.id, title: "岗", harness: "dsh" });
    const plat = db.createFleet({ id: "flt_p", name: "平台队", ownerEmail: "alice@x", origin: "platform" });
    const pm = db.createMember({ id: "fm_p", fleetId: plat.id, title: "平台岗" });

    const ok = await fetch(`${base}/api/fleets/${facet.id}/members/${m.id}`, as("alice@x", {
      method: "PATCH",
      body: JSON.stringify({ cadence: { cron: "0 10 * * *" }, harness: "acp-claude-code", kpiSlots: [{ key: "k", label: "K" }] }),
    }));
    assert.equal(ok.status, 200);
    const updated = (await ok.json()).member;
    assert.equal(updated.harness, "acp-claude-code");
    assert.deepEqual(updated.cadence, { cron: "0 10 * * *" });
    assert.deepEqual(updated.kpiSlots, [{ key: "k", label: "K" }]);

    const denied = await fetch(`${base}/api/fleets/${plat.id}/members/${pm.id}`, as("alice@x", { method: "PATCH", body: JSON.stringify({ harness: "x" }) }));
    assert.equal(denied.status, 409);

    assert.equal((await fetch(`${base}/api/fleets/${facet.id}/members/${m.id}`, as(null, { method: "PATCH", body: "{}" }))).status, 401);
  } finally {
    await close(server);
  }
});

test("2.3 answer a decision: success, platform-origin 409, anonymous 401", async () => {
  const { server, db } = mount();
  const base = await ready(server);
  try {
    const facet = db.createFleet({ id: "flt_f", name: "队", ownerEmail: "alice@x" });
    const d = db.createDecision({ id: "dec_1", fleetId: facet.id, question: "要不要发？" });
    const plat = db.createFleet({ id: "flt_p", name: "平台队", ownerEmail: "alice@x", origin: "platform" });
    const pd = db.createDecision({ id: "dec_p", fleetId: plat.id, question: "?" });

    const ok = await fetch(`${base}/api/fleets/${facet.id}/decisions/${d.id}/answer`, as("alice@x", { method: "POST", body: JSON.stringify({ choice: "approve" }) }));
    assert.equal(ok.status, 200);
    const answered = (await ok.json()).decision;
    assert.equal(answered.state, "resolved");
    assert.equal(answered.resolution.choice, "approve");
    // A second answer is a 409 (first resolution wins).
    assert.equal((await fetch(`${base}/api/fleets/${facet.id}/decisions/${d.id}/answer`, as("alice@x", { method: "POST", body: JSON.stringify({ choice: "reject" }) }))).status, 409);

    const denied = await fetch(`${base}/api/fleets/${plat.id}/decisions/${pd.id}/answer`, as("alice@x", { method: "POST", body: JSON.stringify({ choice: "x" }) }));
    assert.equal(denied.status, 409);

    assert.equal((await fetch(`${base}/api/fleets/${facet.id}/decisions/${d.id}/answer`, as(null, { method: "POST", body: "{}" }))).status, 401);
  } finally {
    await close(server);
  }
});

// ── 2.4 "no executor attached" state ────────────────────────────────────────
test("2.4 console view model: executor null and no running status for a fresh fleet", async () => {
  const { server } = mount();
  const base = await ready(server);
  try {
    const created = await fetch(`${base}/api/fleets`, as("alice@x", { method: "POST", body: JSON.stringify({ name: "待接线队", members: SEED_MEMBERS }) })).then((r) => r.json());
    const view = await fetch(`${base}/api/fleets/${created.fleet.id}/console?surface=platform`, as("alice@x")).then((r) => r.json());
    assert.equal(view.executor, null, "no executor is attached");
    const team = view.blocks.find((b) => b.block === "team");
    assert.equal(team.state, "ready");
    for (const m of team.data.members) {
      assert.notEqual(m.status, "on_duty", "a post must not read as running");
      assert.equal(m.status, "vacant");
      assert.equal(m.statusReason, "no_executor");
    }
  } finally {
    await close(server);
  }
});

// ── 3.3 same-component isomorphism (host-free) ──────────────────────────────
test("3.3 the console organization facts are stable across a re-read (same store, same shape)", async () => {
  const { server } = mount();
  const base = await ready(server);
  try {
    const created = await fetch(`${base}/api/fleets`, as("alice@x", { method: "POST", body: JSON.stringify({ name: "同构队", members: SEED_MEMBERS, edges: SEED_EDGES }) })).then((r) => r.json());
    const id = created.fleet.id;
    const a = await fetch(`${base}/api/fleets/${id}/console?surface=platform`, as("alice@x")).then((r) => r.json());
    const b = await fetch(`${base}/api/fleets/${id}/console?surface=platform`, as("alice@x")).then((r) => r.json());
    // Compare organization facts only (not sampledAt / shell).
    const org = (v) => {
      const team = v.blocks.find((x) => x.block === "team");
      const orch = v.blocks.find((x) => x.block === "orchestration");
      return {
        titles: team.data.members.map((m) => m.title),
        cadence: team.data.members.map((m) => m.cadence?.cron ?? null),
        kpiKeys: team.data.members.map((m) => (m.kpiSlots ?? []).map((s) => s.key)),
        edges: (orch?.data?.declared?.edges ?? []).map((e) => `${e.kind}:${e.from}->${e.to}`),
      };
    };
    assert.deepEqual(org(a), org(b), "organization facts do not drift between reads");
    const o = org(a);
    assert.deepEqual(o.titles, ["主编", "撰写"]);
    assert.deepEqual(o.cadence, ["0 9 * * *", null]);
    assert.deepEqual(o.kpiKeys, [["briefs"], []]);
    assert.equal(o.edges.length, 1);
  } finally {
    await close(server);
  }
});
