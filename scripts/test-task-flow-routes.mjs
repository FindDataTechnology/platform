#!/usr/bin/env node
// ── Flow verbs over HTTP (add-task-flow, tasks 5.1–5.5)
//
// The four verbs and their refusals. The refusals carry most of the value:
//   5.1 create does NOT start the card      — arranging is not running
//   5.2 dispatch refuses an unresolvable post — no silent re-assignment
//   5.3 accept is a HARD gate                 — no-criteria is not a pass
//   5.4 return requires a reason
//   5.5 blocked cards cannot be dispatched
//
//   node --test scripts/test-task-flow-routes.mjs

import assert from "node:assert/strict";
import express from "express";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const tmpRoot = mkdtempSync(path.join(tmpdir(), "task-flow-routes-"));
process.env.CRON_STORAGE_PATH = tmpRoot;
process.env.PLATFORM_DATA_DIR = path.join(tmpRoot, "data");
process.env.DB_PATH = path.join(tmpRoot, "app.db");

// A tool station resolves when the named MCP server is CONFIGURED. The resolver
// reads the bundle manifest, then `mcp.json` — which is gitignored, so a clean
// checkout (CI) has none and `library` would read as unconfigured. Pin a
// fixture baseline instead of depending on the machine's operator file: the
// point of the test is the resolution RULE, not whatever servers this box has.
const MCP_FIXTURE = path.join(tmpRoot, "mcp.json");
writeFileSync(
  MCP_FIXTURE,
  JSON.stringify({
    mcpServers: {
      library: { command: "node", args: ["server/library-mcp.js"] },
    },
  }),
);
process.env.MCP_CONFIG_PATH = MCP_FIXTURE;

const engine = await import("../task-engine.js");
const { registerFlowRoutes } = await import("../server/routes/flows.js");
const { createTaskFlowDatabase } = await import("../server/task-flow-db.js");

test.after(() => rmSync(tmpRoot, { recursive: true, force: true }));

// Every harness server is tracked and closed after each test, whether the test
// passed or threw. Without this a failing assertion leaves a listener open and
// the whole file hangs instead of reporting the failure.
const openServers = new Set();
test.afterEach(() => {
  for (const s of openServers) {
    try { s.close(); } catch { /* already closed */ }
  }
  openServers.clear();
});

const FLOW = {
  flowId: "content",
  name: "内容生产",
  stations: [
    { stationId: "draft", label: "起草", target: { kind: "persona", ref: "writer" }, acceptance: [{ id: "has-draft", kind: "artifact-exists", target: "draft.md" }] },
    { stationId: "review", label: "审读", target: { kind: "persona", ref: "reviewer" }, acceptance: [] },
    { stationId: "vacant", label: "空岗", target: { kind: "a2a", ref: "missing-agent" }, acceptance: [] },
  ],
};

async function harness({ turns = [] } = {}) {
  await engine.initTaskEngine({
    broadcast: () => {},
    isBusy: () => false,
    runTurn: async (t) => {
      turns.push(t.id);
      return { ok: true };
    },
  });
  const taskFlowDatabase = createTaskFlowDatabase({ file: path.join(tmpRoot, `flows-${Math.random().toString(36).slice(2)}.db`) });
  const app = express();
  app.use(express.json());
  const ctx = {
    app,
    taskFlowDatabase,
    // a "missing-agent" ref resolves to nothing — the vacant post.
    // No tool checker is injected: the production wiring resolves a tool
    // station by asking whether its MCP server is configured, which is the
    // question this platform already answers in one place.
    flowExists: { persona: () => true, a2a: (r) => r !== "missing-agent", cluster: () => true },
  };
  registerFlowRoutes(ctx, {});
  const server = app.listen(0, "127.0.0.1");
  openServers.add(server);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, taskFlowDatabase, close: () => server.close() };
}

const call = async (base, method, url, body) => {
  const res = await fetch(`${base}${url}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

const putFlow = async (base) => {
  const r = await call(base, "PUT", "/api/flows/content", FLOW);
  assert.equal(r.status, 200, JSON.stringify(r.body));
};

// ── 5.1 create ───────────────────────────────────────────────────────────────

test("5.1 create: the card exists and NOTHING is enqueued", async () => {
  const turns = [];
  const h = await harness({ turns });
  await putFlow(h.base);

  const r = await call(h.base, "POST", "/api/flows/content/cards", { prompt: "写一份周报", stationId: "draft" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.card.flow.flowId, "content");
  assert.equal(r.body.card.flow.stationId, "draft");
  assert.deepEqual(r.body.card.flow.acceptance.map((a) => a.id), ["has-draft"], "criteria are staked at creation");

  // Arranging is not running. A card that starts on create is the opposite of
  // "arrange first, run when ready".
  await new Promise((res) => setTimeout(res, 50));
  assert.equal(turns.length, 0, "no turn ran for a card that was never dispatched");
  h.close();
});

// ── 5.2 dispatch ─────────────────────────────────────────────────────────────

test("5.2 dispatch: a resolvable post runs the card", async () => {
  const turns = [];
  const h = await harness({ turns });
  await putFlow(h.base);
  const created = await call(h.base, "POST", "/api/flows/content/cards", { prompt: "写周报", stationId: "draft" });
  const id = created.body.card.id;

  const r = await call(h.base, "POST", `/api/flows/cards/${id}/dispatch`, {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  for (let i = 0; i < 100 && turns.length === 0; i += 1) await new Promise((res) => setTimeout(res, 20));
  assert.ok(turns.includes(id), "the card actually ran after dispatch");
  h.close();
});

test("5.2 dispatch: an unresolvable post is refused, the card does not run", async () => {
  const turns = [];
  const h = await harness({ turns });
  try {
    await putFlow(h.base);
    // The card is placed at the vacant post at CREATION (creation does not
    // resolve — a card can legitimately sit on a post that is not staffed yet;
    // that is what "待补岗" looks like on a board).
    const created = await call(h.base, "POST", "/api/flows/content/cards", { prompt: "x", stationId: "vacant" });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const id = created.body.card.id;

    // Dispatching it is refused, and no fallback target is invented.
    const r = await call(h.base, "POST", `/api/flows/cards/${id}/dispatch`, {});
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.error, "station_unresolved");
    await new Promise((res) => setTimeout(res, 60));
    assert.equal(turns.length, 0, "a vacant post never runs and never gets a fallback");
  } finally {
    h.close();
  }
});

test("5.2 reassign: moving a card ONTO a vacant post is itself refused", async () => {
  const h = await harness();
  try {
    await putFlow(h.base);
    const created = await call(h.base, "POST", "/api/flows/content/cards", { prompt: "x", stationId: "draft" });
    const id = created.body.card.id;
    const r = await call(h.base, "POST", `/api/flows/cards/${id}/reassign`, { stationId: "vacant" });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, "reassign_refused");
    const card = (await call(h.base, "GET", "/api/flows/content")).body;
    assert.ok(card, "flow still readable");
    // The card stayed at draft: a refused takeover leaves no half-position.
    const after = engine.getRecord(id);
    assert.equal(after.flow.stationId, "draft");
  } finally {
    h.close();
  }
});

// ── 5.3 accept ───────────────────────────────────────────────────────────────

test("5.3 accept: passing criteria closes the card", async () => {
  const h = await harness();
  await putFlow(h.base);
  const created = await call(h.base, "POST", "/api/flows/content/cards", { prompt: "x", stationId: "draft" });
  const id = created.body.card.id;

  // No artifact → refused.
  const refused = await call(h.base, "POST", `/api/flows/cards/${id}/accept`, { artifacts: [] });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error, "criteria_failed");

  const ok = await call(h.base, "POST", `/api/flows/cards/${id}/accept`, { artifacts: [{ path: "draft.md", bytes: 120 }] });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.card.flow.verdict.outcome, "pass");
  assert.equal(ok.body.card.flow.verdict.by, "criteria", "an automatic pass is labelled as such");
  h.close();
});

test("5.3 accept: no criteria requires a human signature", async () => {
  const h = await harness();
  await putFlow(h.base);
  const created = await call(h.base, "POST", "/api/flows/content/cards", { prompt: "x", stationId: "review" });
  const id = created.body.card.id;

  // Station `review` declares nothing — this MUST NOT be an automatic pass.
  const refused = await call(h.base, "POST", `/api/flows/cards/${id}/accept`, {});
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error, "no_criteria");

  // A reasonless override is refused too: a bypass without a signature is the
  // bypass this whole design exists to prevent.
  const noReason = await call(h.base, "POST", `/api/flows/cards/${id}/accept`, { override: { reason: "   " } });
  assert.equal(noReason.status, 409);

  const signed = await call(h.base, "POST", `/api/flows/cards/${id}/accept`, { override: { reason: "客户催得急，先发" } });
  assert.equal(signed.status, 200, JSON.stringify(signed.body));
  assert.equal(signed.body.card.flow.verdict.by, "override");
  assert.equal(signed.body.card.flow.verdict.reason, "客户催得急，先发");
  // The two paths stay distinguishable after the fact.
  assert.notEqual(signed.body.card.flow.verdict.by, "criteria");
  h.close();
});

// ── 5.4 return ───────────────────────────────────────────────────────────────

test("5.4 return: a reason is mandatory, and the card moves back one station", async () => {
  const h = await harness();
  await putFlow(h.base);
  const created = await call(h.base, "POST", "/api/flows/content/cards", { prompt: "x", stationId: "review" });
  const id = created.body.card.id;

  const noReason = await call(h.base, "POST", `/api/flows/cards/${id}/return`, {});
  assert.equal(noReason.status, 400);
  assert.equal(noReason.body.error, "reason_required");

  const ok = await call(h.base, "POST", `/api/flows/cards/${id}/return`, { reason: "论据不足" });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.card.flow.stationId, "draft", "returned to the previous station");
  assert.equal(ok.body.card.flow.verdict.outcome, "returned");
  assert.equal(ok.body.card.flow.verdict.reason, "论据不足");

  // The trail records it, so "why did this go back" survives the session.
  const trail = h.taskFlowDatabase.reassignmentsOf(id);
  assert.equal(trail.length, 1);
  assert.equal(trail[0].to.stationId, "draft");
  assert.equal(trail[0].reason, "论据不足");
  h.close();
});

// ── 5.5 dependencies ─────────────────────────────────────────────────────────

test("5.5 deps: a blocked card cannot be dispatched, and names the blocker", async () => {
  const turns = [];
  const h = await harness({ turns });
  await putFlow(h.base);

  const a = (await call(h.base, "POST", "/api/flows/content/cards", { prompt: "A", stationId: "draft" })).body.card;
  const b = (await call(h.base, "POST", "/api/flows/content/cards", { prompt: "B", stationId: "draft", blockedBy: [a.id] })).body.card;

  const blocked = await call(h.base, "POST", `/api/flows/cards/${b.id}/dispatch`, {});
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.error, "card_blocked");
  assert.deepEqual(blocked.body.blockedBy, [a.id], "the blocker is named, not just counted");

  // A is not done, so B stays blocked. Finishing A unblocks B — but must NOT
  // dispatch it (design D7: unblocking is a condition, not an action).
  await call(h.base, "POST", `/api/flows/cards/${a.id}/accept`, { artifacts: [{ path: "draft.md", bytes: 10 }] });
  await new Promise((res) => setTimeout(res, 60));
  assert.equal(turns.filter((t) => t === b.id).length, 0, "unblocked is not dispatched");

  const nowOk = await call(h.base, "POST", `/api/flows/cards/${b.id}/dispatch`, {});
  assert.equal(nowOk.status, 200, JSON.stringify(nowOk.body));
  h.close();
});

test("5.5 deps: a card cannot block itself", async () => {
  const h = await harness();
  await putFlow(h.base);
  const a = (await call(h.base, "POST", "/api/flows/content/cards", { prompt: "A", stationId: "draft" })).body.card;
  await call(h.base, "POST", `/api/flows/cards/${a.id}/deps`, { blockedBy: [a.id] });
  assert.deepEqual(h.taskFlowDatabase.blockersOf(a.id), [], "self-dependency is dropped, not stored");
  h.close();
});

// ── declaration routes ───────────────────────────────────────────────────────

test("declaration: an invalid PUT writes nothing", async () => {
  const h = await harness();
  const bad = await call(h.base, "PUT", "/api/flows/broken", {
    name: "坏流程",
    stations: [{ stationId: "a", target: { kind: "nope", ref: "x" } }],
  });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, "flow_invalid");
  const list = await call(h.base, "GET", "/api/flows");
  assert.equal(list.body.flows.length, 0, "a refused declaration leaves no partial row");
  h.close();
});

// ── assembly: the OTHER defect this suite's fake resolver could hide ────────
//
// Every case above injects `flowExists`, so none of them can notice that the
// PRODUCTION wiring forgot to pass a persona resolver — the station would read
// "vacant" for every real persona and the board would be quietly unusable
// (found by driving the real server in a browser, 2026-11-19).
//
// This case exercises the production shape: no injected `exists`, a
// `fleetTargetResolver`, and a roster persona. It must resolve.
test("assembly: production wiring resolves a roster persona (no injected exists)", async () => {
  const { registerFlowRoutes: register } = await import("../server/routes/flows.js");
  await engine.initTaskEngine({ broadcast: () => {}, isBusy: () => false, runTurn: async () => ({ ok: true }) });

  const app = express();
  app.use(express.json());
  const taskFlowDatabase = createTaskFlowDatabase({ file: path.join(tmpRoot, `asm-${Math.random().toString(36).slice(2)}.db`) });
  // Exactly what server.js now passes: the fleet dispatch face's resolver.
  register(
    {
      app,
      taskFlowDatabase,
      authEnabled: false,
      fleetTargetResolver: ({ targetId }) => ({ alive: targetId === "writer", label: "writer" }),
    },
    {}, // no flowExists — production passes none
  );
  const server = app.listen(0, "127.0.0.1");
  openServers.add(server);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;

  await call(base, "PUT", "/api/flows/content", {
    flowId: "content",
    name: "内容生产",
    stations: [{ stationId: "draft", target: { kind: "persona", ref: "writer" }, acceptance: [] }],
  });
  const created = await call(base, "POST", "/api/flows/content/cards", { prompt: "x", stationId: "draft" });
  const dispatch = await call(base, "POST", `/api/flows/cards/${created.body.card.id}/dispatch`, {});
  assert.equal(dispatch.status, 200, `a roster persona must resolve in production: ${JSON.stringify(dispatch.body)}`);
});

// ── assembly: a tool station resolves against the real MCP config ───────────
//
// Same shape as the persona case above: no injected checker. The tool station
// must resolve iff its MCP server is configured, because that is the question
// the tool-turn executor itself asks before it runs (add-tool-posts). A third,
// private answer here would drift from it.
test("assembly: a tool station resolves against the configured MCP servers", async () => {
  const { registerFlowRoutes: register, } = await import("../server/routes/flows.js");
  await engine.initTaskEngine({ broadcast: () => {}, isBusy: () => false, runTurn: async () => ({ ok: true }) });
  const app = express();
  app.use(express.json());
  const taskFlowDatabase = createTaskFlowDatabase({ file: path.join(tmpRoot, `tool-${Math.random().toString(36).slice(2)}.db`) });
  register({ app, taskFlowDatabase, authEnabled: false }, {});
  const server = app.listen(0, "127.0.0.1");
  openServers.add(server);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;

  await call(base, "PUT", "/api/flows/toolcheck", {
    flowId: "toolcheck",
    name: "工具流",
    stations: [
      { stationId: "real", target: { kind: "tool", ref: "library::list_library" }, acceptance: [] },
      { stationId: "fake", target: { kind: "tool", ref: "no-such-server::some_tool" }, acceptance: [] },
    ],
  });
  const mk = async (stationId) =>
    (await call(base, "POST", "/api/flows/toolcheck/cards", { prompt: "{}", stationId })).body.card;

  // `library` is a bundled server (mcp.json / bundle manifest) → resolves.
  const real = await mk("real");
  const ok = await call(base, "POST", `/api/flows/cards/${real.id}/dispatch`, {});
  assert.equal(ok.status, 200, `a configured MCP server must resolve: ${JSON.stringify(ok.body)}`);

  // An unknown server is a vacant post, not a fallback.
  const fake = await mk("fake");
  const bad = await call(base, "POST", `/api/flows/cards/${fake.id}/dispatch`, {});
  assert.equal(bad.status, 409);
  assert.equal(bad.body.error, "station_unresolved");
});
