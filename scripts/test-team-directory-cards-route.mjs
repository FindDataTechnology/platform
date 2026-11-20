#!/usr/bin/env node
// The cell's directory face (openspec: add-agent-team-directory, task 2.1).
//
// Two things are pinned here, and both are the kind of defect a later UI change
// cannot repair:
//   • the SAMPLING payload (`GET /api/teams/cards`) answers for the cell owner
//     only — an anonymous caller gets 401, a different signed-in identity gets
//     the same 404 an unknown card produces, and neither response reveals a
//     handle, a team name, or a post title from someone else's card;
//   • every write/read refusal is ONE body (`{error:"not found"}`) for unknown,
//     not-yours, and bad-handle — the directory must not become an existence
//     oracle (the fleet routes' 403 contract deliberately not copied).
//
// Real express + a real socket + a temp sqlite fleet DB: route order, method
// matching and status codes are part of what is under test, so a stubbed `app`
// would let exactly the defects this file guards against pass.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import express from "express";
import { createFleetDatabase, setFleetDatabase } from "../server/routes/fleets-db.js";
import { registerTeamCardRoutes } from "../server/routes/team-cards.js";

const CELL_OWNER = "owner@cell.test";
const OTHER_USER = "other@cell.test";
const FLEET_ID = "fleet-1";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "team-cards-route-"));
process.on("exit", () => fs.rmSync(tmpDir, { recursive: true, force: true }));

let server;
let base;
let fleetDb;

before(async () => {
  fleetDb = createFleetDatabase({ file: path.join(tmpDir, "fleets.db") });
  setFleetDatabase(fleetDb);

  fleetDb.createFleet({ id: FLEET_ID, name: "客服班组", ownerEmail: CELL_OWNER, state: "active" });
  fleetDb.createMember({
    id: "post-1",
    fleetId: FLEET_ID,
    title: "接待岗",
    targetKind: "a2a",
    targetId: "pack/secret/agent-1",
    packId: "secret-pack",
  });
  fleetDb.createMember({ id: "post-2", fleetId: FLEET_ID, title: "复盘岗", targetKind: "persona", targetId: "preset-9" });

  const app = express();
  app.use(express.json({ limit: "1mb" }));
  // Stand-in for the real identity middleware: the header picks the caller.
  app.use((req, _res, next) => {
    if (req.headers["x-user"]) req.ssoUser = { email: String(req.headers["x-user"]), groups: [] };
    next();
  });
  registerTeamCardRoutes({
    app,
    authEnabled: true,
    cellUserEmail: CELL_OWNER,
    isAdminUser: (u) => u?.email === "admin@cell.test",
  });
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server?.close();
  fleetDb?.close();
});

async function call(method, url, { user = CELL_OWNER, body } = {}) {
  const res = await fetch(`${base}${url}`, {
    method,
    headers: {
      ...(user ? { "x-user": user } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* body is asserted as text below when it is not JSON */
  }
  return { status: res.status, json, text };
}

// ── sampling face ───────────────────────────────────────────────────────────

test("the owner sees the full sampled payload, with the envelope the gateway expects", async () => {
  const pub = await call("POST", "/api/teams/cards/cs-team", {
    body: { fleetId: FLEET_ID, displayName: "客服一组", description: "接售后工单", visibility: "listed" },
  });
  assert.equal(pub.status, 201, pub.text);

  const res = await call("GET", "/api/teams/cards");
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.v, 1, "the gateway trusts only v:1");
  assert.equal(typeof res.json.sampledAt, "number");
  assert.equal(Array.isArray(res.json.cards), true);
  assert.equal(res.json.cards.length, 1);
  const [entry] = res.json.cards;
  assert.equal(entry.handle, "cs-team");
  assert.deepEqual(entry.target, { kind: "fleet", id: FLEET_ID });
  assert.equal(entry.card.name, "客服一组");
  assert.deepEqual(entry.card.posts, [{ id: "post-1", title: "接待岗" }], "only a2a posts are callable");
  assert.equal(JSON.stringify(entry).includes("pack/secret/agent-1"), false, "internal ids never sampled");
  assert.equal(JSON.stringify(entry).includes("preset-9"), false);
});

test("an anonymous caller gets 401 and no card material", async () => {
  const res = await call("GET", "/api/teams/cards", { user: null });
  assert.equal(res.status, 401);
  assert.equal(res.text.includes("cs-team"), false);
  assert.equal(res.text.includes("客服一组"), false);
  assert.equal(res.text.includes("接待岗"), false);
});

test("a different signed-in identity gets the same 404 an unknown card gets", async () => {
  const res = await call("GET", "/api/teams/cards", { user: OTHER_USER });
  assert.equal(res.status, 404);
  assert.deepEqual(res.json, { error: "not found" });
  for (const leak of ["cs-team", "客服一组", "接待岗", FLEET_ID]) {
    assert.equal(res.text.includes(leak), false, `leaked ${leak}`);
  }
});

test("a private publication is never sampled, not even for the owner", async () => {
  await call("POST", "/api/teams/cards/hidden-team", {
    body: { fleetId: FLEET_ID, displayName: "内部组", visibility: "private" },
  });
  const res = await call("GET", "/api/teams/cards");
  assert.equal(res.status, 200);
  assert.equal(
    res.json.cards.some((c) => c.handle === "hidden-team"),
    false,
    "private must not leave the cell",
  );
  assert.equal(res.json.cards.some((c) => c.handle === "cs-team"), true);
});

// ── every refusal is one shape ──────────────────────────────────────────────

test("unknown team, not-yours team and bad handle answer with one identical body", async () => {
  const unknownTeam = await call("POST", "/api/teams/cards/ghost-team", {
    body: { fleetId: "no-such-fleet", visibility: "open" },
  });
  const badHandle = await call("POST", "/api/teams/cards/Bad%20Handle", {
    body: { fleetId: FLEET_ID, visibility: "open" },
  });
  const foreignFleet = fleetDb.createFleet({ id: "fleet-other", name: "别人的组", ownerEmail: OTHER_USER, state: "active" });
  const notYours = await call("POST", "/api/teams/cards/other-team", {
    body: { fleetId: foreignFleet.id, visibility: "open" },
  });
  for (const [label, res] of [["unknown", unknownTeam], ["bad handle", badHandle], ["not yours", notYours]]) {
    assert.equal(res.status, 404, `${label} must be 404, got ${res.status} ${res.text}`);
    assert.deepEqual(res.json, { error: "not found" }, `${label} must not be distinguishable`);
  }
  const listing = await call("GET", "/api/teams/cards");
  assert.equal(listing.json.cards.some((c) => c.handle === "other-team"), false);
});

test("patch without an existing publication, and withdraw of nothing, are the same 404", async () => {
  const patch = await call("PATCH", "/api/teams/cards/never-published", { body: { visibility: "open" } });
  const del = await call("DELETE", "/api/teams/cards/never-published");
  const read = await call("GET", "/api/teams/cards/never-published");
  for (const res of [patch, del, read]) {
    assert.equal(res.status, 404);
    assert.deepEqual(res.json, { error: "not found" });
  }
});

test("a non-owner cannot patch or withdraw a card that exists", async () => {
  const patch = await call("PATCH", "/api/teams/cards/cs-team", { user: OTHER_USER, body: { visibility: "open" } });
  assert.equal(patch.status, 404);
  assert.deepEqual(patch.json, { error: "not found" });
  const del = await call("DELETE", "/api/teams/cards/cs-team", { user: OTHER_USER });
  assert.equal(del.status, 404);
  const still = await call("GET", "/api/teams/cards/cs-team");
  assert.equal(still.status, 200, "a refused withdraw must not remove the card");
  assert.equal(still.json.publication.visibility, "listed");
});

// ── write face round trip ───────────────────────────────────────────────────

test("publish → patch → withdraw is visible to sampling at each step", async () => {
  const created = await call("POST", "/api/teams/cards/flow-team", {
    body: { fleetId: FLEET_ID, displayName: "流程组", visibility: "open" },
  });
  assert.equal(created.status, 201, created.text);
  assert.equal(created.json.fallbacks.length, 0, "defaults are used silently when no quota is sent");

  const open = await call("GET", "/api/teams/cards");
  assert.equal(open.json.cards.some((c) => c.handle === "flow-team"), true);

  const patched = await call("PATCH", "/api/teams/cards/flow-team", { body: { visibility: "private" } });
  assert.equal(patched.status, 200, patched.text);
  const hidden = await call("GET", "/api/teams/cards");
  assert.equal(hidden.json.cards.some((c) => c.handle === "flow-team"), false, "privacy takes effect on the next sample");

  await call("PATCH", "/api/teams/cards/flow-team", { body: { visibility: "listed" } });
  const withdrawn = await call("DELETE", "/api/teams/cards/flow-team");
  assert.equal(withdrawn.status, 200, withdrawn.text);
  assert.deepEqual(withdrawn.json, { ok: true, handle: "flow-team" });
  const gone = await call("GET", "/api/teams/cards");
  assert.equal(gone.json.cards.some((c) => c.handle === "flow-team"), false);
  // The team itself is untouched.
  assert.equal(fleetDb.getFleet(FLEET_ID)?.id, FLEET_ID);
  assert.equal(fleetDb.listMembers(FLEET_ID).length, 2);
});

test("an unlimited quota falls back and the response says which field", async () => {
  const res = await call("POST", "/api/teams/cards/quota-team", {
    body: { fleetId: FLEET_ID, visibility: "listed", usdPerDay: 0 },
  });
  assert.equal(res.status, 201, res.text);
  assert.deepEqual(
    res.json.fallbacks.map((f) => f.field),
    ["usdPerDay"],
  );
  assert.equal(res.json.card.pricing.usdPerDay > 0, true);
});

test("the owner's single-card read is the same card the directory samples", async () => {
  const one = await call("GET", "/api/teams/cards/cs-team");
  const list = await call("GET", "/api/teams/cards");
  const sampled = list.json.cards.find((c) => c.handle === "cs-team");
  assert.deepEqual(one.json.card, sampled.card, "cockpit preview and sampled card must not diverge");
});

// ── cockpit read (task 4.3 support) ────────────────────────────────────────

test("the cockpit read shows a private card, and refuses another owner's team", async () => {
  const pub = await call("POST", "/api/teams/cards/cockpit-team", {
    body: { fleetId: FLEET_ID, displayName: "驾驶舱组", visibility: "private" },
  });
  assert.equal(pub.status, 201, pub.text);

  const mine = await call("GET", `/api/teams/cards/for-fleet/${FLEET_ID}`);
  assert.equal(mine.status, 200, mine.text);
  assert.equal(mine.json.publication.handle, "cockpit-team");
  assert.equal(mine.json.card.name, "驾驶舱组");
  assert.equal(mine.json.card.availability.accepting, false, "a private card is not accepting calls");

  const foreign = fleetDb.createFleet({ id: "fleet-someone", name: "别人的组", ownerEmail: OTHER_USER, state: "active" });
  const refused = await call("GET", `/api/teams/cards/for-fleet/${foreign.id}`);
  assert.equal(refused.status, 404);
  assert.deepEqual(refused.json, { error: "not found" });

  const unknown = await call("GET", "/api/teams/cards/for-fleet/no-such-fleet");
  assert.equal(unknown.status, 404);
  assert.deepEqual(unknown.json, { error: "not found" });
});

test("an unpublished team reads as publication:null rather than 404", async () => {
  const fresh = fleetDb.createFleet({ id: "fleet-fresh", name: "未发布组", ownerEmail: CELL_OWNER, state: "active" });
  const res = await call("GET", `/api/teams/cards/for-fleet/${fresh.id}`);
  assert.equal(res.status, 200);
  assert.equal(res.json.publication, null);
  assert.equal(res.json.card, null);
});

// ── preview (task 4.3 "确认前不产生写入") ───────────────────────────────────

test("preview derives the card, refuses an unknown owner, and writes nothing", async () => {
  const before = (await call("GET", "/api/teams/cards/for-fleet/fleet-fresh")).json;
  assert.equal(before.publication, null);

  const preview = await call("POST", "/api/teams/cards/preview", {
    body: { fleetId: "fleet-fresh", handle: "fresh-team", displayName: "预览组", description: "只预览不落库", visibility: "open" },
  });
  assert.equal(preview.status, 200, preview.text);
  assert.equal(preview.json.card.name, "预览组");
  assert.equal(preview.json.card.availability.accepting, true);
  assert.equal(preview.json.card.pricing.callsPerDay > 0, true, "defaults are visible before confirming");
  assert.deepEqual(preview.json.card.posts, [], "a team with no a2a post previews as callable-by-nobody");

  const after = (await call("GET", "/api/teams/cards/for-fleet/fleet-fresh")).json;
  assert.equal(after.publication, null, "preview must not write a publication row");
  assert.equal((await call("GET", "/api/teams/cards")).json.cards.some((c) => c.handle === "fresh-team"), false);

  const foreign = await call("POST", "/api/teams/cards/preview", {
    user: OTHER_USER,
    body: { fleetId: "fleet-fresh", handle: "fresh-team" },
  });
  assert.equal(foreign.status, 404);
  assert.deepEqual(foreign.json, { error: "not found" });

  const invalid = await call("POST", "/api/teams/cards/preview", {
    body: { fleetId: "fleet-fresh", handle: "fresh-team", visibility: "sorta-public" },
  });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.json.field, "visibility");
});
