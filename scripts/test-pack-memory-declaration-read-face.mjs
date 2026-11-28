// Pack declaration preview (fix-memory-axes-executed-truth / "四列读面").
//
// `/api/memory/declaration` answers a DIFFERENT question from `/api/memory/policy`:
// "what does the pack ask for" (computed from the installed manifest) versus "what
// is actually stored in the memory service" (proxied rows). The claims worth
// pinning are the ones a later refactor would quietly break:
//
//   · every axis gets a row — not just the process axis the service happens to own
//   · `executed` is false wherever no consumer exists, and those keys land in
//     `not_executed`; a declaration nobody honours must never read as "in force"
//   · `knowledge.memory` is folded in as the read axis (old spelling, same axis)
//   · the root key is DERIVED from packId; a caller-supplied `rootKey` is ignored
//   · the preview does not depend on the memory service being reachable
//
//   node --test scripts/test-pack-memory-declaration-read-face.mjs

import test from "node:test";
import assert from "node:assert/strict";

import { registerMemoryRoutes } from "../server/routes/memory.js";

const ROW_ORDER = [
  "store.home",
  "read.scope",
  "read.budget",
  "write.authority",
  "process.distill",
  "process.promote_after",
  "process.cold_after_days",
];

const session = { user: { email: "deployer@x.dev" } };

function makeApp() {
  const routes = new Map();
  const app = { get: (p, h) => routes.set(`GET ${p}`, h), post: (p, h) => routes.set(`POST ${p}`, h) };
  return { app, routes };
}

function makeRes() {
  const res = { statusCode: 200, body: undefined, sent: false };
  res.status = (n) => { res.statusCode = n; return res; };
  res.json = (doc) => { res.body = doc; res.sent = true; return res; };
  return res;
}

/** Call the preview route with a stubbed pack store. */
async function call({ query = {}, user = session.user, manifest = null, version = "1.0.0", installed } = {}) {
  const { app, routes } = makeApp();
  registerMemoryRoutes({
    app,
    getInstalledPack: (packId) => (installed === undefined
      ? (manifest ? { packId, version, manifest } : null)
      : installed(packId)),
  });
  const res = makeRes();
  await routes.get("GET /api/memory/declaration")({ user, query }, res);
  return res;
}

test("every axis gets a row, in a stable order, and undeclared keys say so", async () => {
  const res = await call({ query: { packId: "legal-crew" }, manifest: { fleet: {} } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(Object.keys(res.body.rows), ROW_ORDER, "all axes are present, not just process");
  for (const sub of ROW_ORDER) {
    assert.equal(res.body.rows[sub].declared, null, `${sub}: nothing declared`);
  }
  // `write.authority` is the one axis with NO platform default: "whose conclusion
  // counts" is not a question a platform can answer on an agent's behalf, so an
  // undeclared authority stays null instead of inheriting a value nobody chose.
  for (const sub of ROW_ORDER.filter((s) => s !== "write.authority")) {
    assert.equal(res.body.rows[sub].inherited_from, "platform", `${sub}: fills from the platform default`);
    assert.notEqual(res.body.rows[sub].effective, null, `${sub}: has an effective value`);
  }
  assert.equal(res.body.rows["write.authority"].inherited_from, null);
  assert.equal(res.body.rows["write.authority"].effective, null);
  assert.deepEqual(res.body.not_executed, [], "nothing declared ⇒ nothing to call out");
  assert.equal(res.body.source, "declaration");
  assert.equal(res.body.policy_root, "d-legal-crew");
  assert.equal(res.body.scope, "pack", "the row belongs to the pack root, not one team");
});

test("a declared axis with no consumer is reported unexecuted, with its declared value kept", async () => {
  const res = await call({
    query: { packId: "legal-crew" },
    manifest: {
      memory: {
        store: { home: "fleet" },
        read: { scope: "off", budget: 800 },
        write: { authority: "shared" },
        process: { distill: "off", cold_after_days: 90 },
      },
    },
  });
  assert.equal(res.statusCode, 200);
  const rows = res.body.rows;
  for (const sub of ["store.home", "read.scope", "read.budget", "write.authority"]) {
    assert.equal(rows[sub].executed, false, `${sub} has no consumer in this version`);
  }
  assert.equal(rows["store.home"].declared, "fleet", "the declaration is still reported faithfully");
  assert.equal(rows["store.home"].effective, "fleet");
  assert.equal(rows["read.scope"].effective, "off");
  assert.equal(rows["write.authority"].declared, "shared");
  // `process.distill` is the one axis with a consumer; the other two process keys
  // resolve but nothing acts on them.
  assert.equal(rows["process.distill"].executed, true);
  assert.equal(rows["process.cold_after_days"].executed, false);
  assert.deepEqual(res.body.not_executed, [
    "store.home",
    "read.scope",
    "read.budget",
    "write.authority",
    "process.cold_after_days",
  ]);
});

test("knowledge.memory is the same axis as memory.read (old spelling still works)", async () => {
  const res = await call({
    query: { packId: "legal-crew" },
    manifest: { knowledge: { memory: { enabled: false, budget: 640 } } },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.rows["read.scope"].declared, "off", "enabled:false is the old spelling of scope:off");
  assert.equal(res.body.rows["read.scope"].inherited_from, "pack");
  assert.equal(res.body.rows["read.budget"].declared, 640);
});

test("memory.read wins over knowledge.memory when both speak (they must agree anyway)", async () => {
  const res = await call({
    query: { packId: "legal-crew" },
    manifest: { memory: { read: { scope: "shared" } }, knowledge: { memory: { enabled: false } } },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.rows["read.scope"].declared, "shared");
});

test("the root key is derived from packId — a caller-supplied rootKey is ignored", async () => {
  const res = await call({ query: { packId: "legal-crew", rootKey: "u/someone-else" } , manifest: { fleet: {} } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.policy_root, "d-legal-crew");
  assert.ok(!JSON.stringify(res.body).includes("someone-else"), "a caller must not be able to name a root");
});

test("no session, no data: 401 / 400 / 404 each name themselves", async () => {
  {
    const res = await call({ query: { packId: "legal-crew" }, user: null, manifest: { fleet: {} } });
    assert.equal(res.statusCode, 401);
    assert.equal(res.body.code, "unauthenticated");
  }
  for (const packId of ["", "   ", "bad id!", "x".repeat(65)]) {
    const res = await call({ query: { packId }, manifest: { fleet: {} } });
    assert.equal(res.statusCode, 400, JSON.stringify(packId));
    assert.equal(res.body.code, "pack_id_invalid");
  }
  {
    // Not installed ⇒ 404. Deliberately not a table full of defaults: that would be
    // byte-identical to "this pack declared the defaults", the failure this change
    // exists to remove.
    const res = await call({ query: { packId: "not-installed" }, manifest: null });
    assert.equal(res.statusCode, 404);
    assert.equal(res.body.code, "pack_not_installed");
    assert.equal(res.body.rows, undefined);
  }
});

test("the preview never touches the memory service (it must work while that is down)", async () => {
  const realFetch = globalThis.fetch;
  let called = 0;
  globalThis.fetch = async () => { called += 1; throw new Error("no network expected"); };
  try {
    const res = await call({ query: { packId: "legal-crew" }, manifest: { memory: { process: { distill: "off" } } } });
    assert.equal(res.statusCode, 200);
    assert.equal(called, 0, "the preview is computed from the manifest, not proxied");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("an agent-level declaration does not leak into the pack preview", async () => {
  // The preview answers "what does the pack declare"; agent overrides resolve per
  // member and belong to the team console, not to this row set.
  const res = await call({
    query: { packId: "legal-crew" },
    manifest: { agents: [{ id: "a1", memory: { read: { scope: "off" } } }] },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.rows["read.scope"].declared, null);
});
