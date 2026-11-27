#!/usr/bin/env node
// ── Flow board read face is owner-scoped (make-task-flow-board-live, 3.1/3.2)
//
// The board used to return every card on the instance to every caller. Two
// things must stay true after this change, and they pull in opposite
// directions:
//
//   * under auth, a caller sees ONLY their own cards — and `unscoped` says how
//     many exist beyond them, because a board that silently loses cards is the
//     "self-consistent but smaller" defect this repo keeps fixing;
//   * auth-off (desktop / standalone) still sees EVERYTHING — an empty board on
//     a single-user install is a bug, not security.
//
// The negative case is the one worth writing down: the other user's prompt text
// must not appear in the response AT ALL, not merely be absent from `cards`.
// Filtering on the client would pass a `cards.length` assertion and still have
// shipped the content.
//
//   node --test scripts/test-task-flow-board-owner.mjs

import assert from "node:assert/strict";
import express from "express";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const tmpRoot = mkdtempSync(path.join(tmpdir(), "flow-board-owner-"));
process.env.CRON_STORAGE_PATH = tmpRoot;
process.env.PLATFORM_DATA_DIR = path.join(tmpRoot, "data");
process.env.DB_PATH = path.join(tmpRoot, "app.db");

const engine = await import("../task-engine.js");
const { registerFlowRoutes } = await import("../server/routes/flows.js");
const { createTaskFlowDatabase } = await import("../server/task-flow-db.js");

test.after(() => rmSync(tmpRoot, { recursive: true, force: true }));

const openServers = new Set();
test.afterEach(() => {
  for (const s of openServers) {
    try { s.close(); } catch { /* already closed */ }
  }
  openServers.clear();
});

// The engine's task map is module scope, so every test gets its OWN flow id and
// asserts only on that flow's cards. Deleting records between tests looked
// tidier but fought `initTaskEngine`'s reload from jobs.json; scoping by flow is
// what actually isolates the counts.
let flowSeq = 0;
const freshFlow = () => {
  flowSeq += 1;
  const flowId = `content-${flowSeq}`;
  return {
    flowId,
    name: `内容生产 ${flowSeq}`,
    stations: [
      { stationId: "draft", label: "起草", target: { kind: "persona", ref: "writer" }, acceptance: [] },
    ],
  };
};

// `who` is the header the fake auth middleware turns into req.user, so one
// harness can serve several identities — which is the whole point here.
const harness = async ({ authEnabled }) => {
  await engine.initTaskEngine({
    broadcast: () => {},
    isBusy: () => false,
    runTurn: async () => ({ ok: true }),
  });
  const taskFlowDatabase = createTaskFlowDatabase({
    file: path.join(tmpRoot, `flows-${Math.random().toString(36).slice(2)}.db`),
  });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const who = req.headers["x-test-user"];
    const groups = String(req.headers["x-test-groups"] ?? "").split(",").filter(Boolean);
    req.user = who ? { email: String(who), groups } : null;
    next();
  });
  const ctx = {
    app,
    taskFlowDatabase,
    authEnabled,
    isAdminUser: (u) => Boolean(u?.groups?.includes?.("admin")),
    flowExists: { persona: () => true, a2a: () => true, cluster: () => true },
  };
  registerFlowRoutes(ctx, {});
  const server = app.listen(0, "127.0.0.1");
  openServers.add(server);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (user, method, url, body, groups = "") => {
    const res = await fetch(`${base}${url}`, {
      method,
      headers: {
        ...(body ? { "content-type": "application/json" } : {}),
        ...(user ? { "x-test-user": user } : {}),
        ...(groups ? { "x-test-groups": groups } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  return { base, call, taskFlowDatabase };
};

const seed = async (h, flow) => {
  const put = await h.call("alice@example.com", "PUT", `/api/flows/${flow.flowId}`, flow);
  assert.equal(put.status, 200, JSON.stringify(put.body));
  const mine = await h.call("alice@example.com", "POST", `/api/flows/${flow.flowId}/cards`, { prompt: "ALICE_SECRET_PROMPT" });
  assert.equal(mine.status, 200, JSON.stringify(mine.body));
  const theirs = await h.call("bob@example.com", "POST", `/api/flows/${flow.flowId}/cards`, { prompt: "BOB_SECRET_PROMPT" });
  assert.equal(theirs.status, 200, JSON.stringify(theirs.body));
  return { mine: mine.body.card, theirs: theirs.body.card };
};

// Count only the cards belonging to THIS test's flow: the engine's map carries
// every card any earlier test created.
const cardsOf = (board, flow) => board.cards.filter((c) => c.flow?.flowId === flow.flowId);

test("3.1 auth on: a caller sees only their own cards, and unscoped counts the rest", async () => {
  const h = await harness({ authEnabled: true });
  const flow = freshFlow();
  await seed(h, flow);

  const alice = await h.call("alice@example.com", "GET", "/api/flows/board");
  assert.equal(alice.status, 200);
  assert.equal(cardsOf(alice.body, flow).length, 1, "alice sees exactly her own card");
  assert.ok(alice.body.unscoped >= 1, "bob's card is counted, not silently missing");

  const bob = await h.call("bob@example.com", "GET", "/api/flows/board");
  assert.equal(cardsOf(bob.body, flow).length, 1);
  assert.ok(bob.body.unscoped >= 1);
});

test("3.2 the other user's prompt is absent from the WHOLE response, not just from cards", async () => {
  const h = await harness({ authEnabled: true });
  const flow = freshFlow();
  await seed(h, flow);

  const alice = await h.call("alice@example.com", "GET", "/api/flows/board");
  const wire = JSON.stringify(alice.body);
  assert.ok(!wire.includes("BOB_SECRET_PROMPT"), "bob's prompt must not cross the wire at all");
  assert.ok(wire.includes("ALICE_SECRET_PROMPT"), "alice's own card must still carry her prompt");
});

test("3.1 auth off keeps the single-user contract: every card, unscoped 0", async () => {
  const h = await harness({ authEnabled: false });
  const flow = freshFlow();
  await seed(h, flow);

  // Auth-off deployments have no req.user; the viewer email falls back to
  // owner@local and includeAll is true regardless.
  const board = await h.call(null, "GET", "/api/flows/board");
  assert.equal(board.status, 200);
  assert.equal(cardsOf(board.body, flow).length, 2, "a desktop install must not lose cards");
  assert.equal(board.body.unscoped, 0);
});

test("3.1 an admin sees every card and reports none withheld", async () => {
  const h = await harness({ authEnabled: true });
  const flow = freshFlow();
  await seed(h, flow);

  const board = await h.call("ops@example.com", "GET", "/api/flows/board", undefined, "admin");
  assert.equal(board.status, 200);
  assert.equal(cardsOf(board.body, flow).length, 2, "an admin sees both cards");
  assert.equal(board.body.unscoped, 0, "nothing is withheld from an admin");
});
