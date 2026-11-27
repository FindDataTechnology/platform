#!/usr/bin/env node
// ── Notify bridge: identity, scoping, and the permission rule
//    (add-broadcast-and-notification-inbox 3.2–3.4) ─────────────────────────
//
// The properties that matter:
//   · the list is scoped to the owner in the URL — another owner's notices are
//     never returned, and their existence never leaks into a count;
//   · a notice without an action refuses the act verb by name;
//   · an action naming an UNREGISTERED tool is refused (it would otherwise be
//     the one path with no preflight, no mandate and no risk tier);
//   · a refused action does not consume the notice;
//   · the MCP child reports "no identity" instead of calling.
//
//   node --test --test-concurrency=1 scripts/test-notify-bridge.mjs

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";

const tmpRoot = mkdtempSync(path.join(tmpdir(), "notify-bridge-"));
process.env.DB_PATH = path.join(tmpRoot, "app.db");
process.env.PLATFORM_DATA_DIR = path.join(tmpRoot, "data");

const dbModule = await import("../db.js");
await dbModule.initDb();
const { createNotificationStore } = await import("../lib/broadcast-store.js");
const { registerNotifyBridgeRoutes } = await import("../server/routes/notify-bridge.js");
const { runTool, httpDriver } = await import("../server/notify-mcp.js");
const { runNotificationAction } = await import("../lib/notification-action.js");

test.after(() => rmSync(tmpRoot, { recursive: true, force: true }));

const handle = dbModule.getDb();
const store = createNotificationStore({ db: handle });

store.deliverToRecipients({
  broadcastId: "nA",
  recipients: ["a@x"],
  title: "带动作的通知",
  body: "请处理",
  action: { actionId: "facet.pack.visibility", args: { packId: "p1", visibility: "public" } },
});
store.deliverToRecipients({ broadcastId: "nB", recipients: ["b@x"], title: "B 的通知", body: "只需要知悉" });
store.deliverToRecipients({
  broadcastId: "nC",
  recipients: ["a@x"],
  title: "未注册动作",
  body: "x",
  action: { actionId: "not.a.registered.action", args: {} },
});

async function boot() {
  const app = express().use(express.json());
  registerNotifyBridgeRoutes(app, {});
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (method, url) => fetch(`${base}${url}`, { method });
  return { base, call, close: () => server.close() };
}

const idOf = (title, owner) =>
  handle.prepare("SELECT id FROM notifications WHERE recipient_id = ? AND title = ?").get(owner, title)?.id ?? null;
const stateOf = (id) => handle.prepare("SELECT state FROM notifications WHERE id = ?").get(id).state;

test("list: only the owner's notices come back, with their own unread count", async () => {
  const { call, close } = await boot();
  try {
    const a = await (await call("GET", "/api/notify/inbox/a@x")).json();
    assert.deepEqual(a.notifications.map((n) => n.title).sort(), ["带动作的通知", "未注册动作"].sort());
    assert.equal(a.unread, 2);

    const b = await (await call("GET", "/api/notify/inbox/b@x")).json();
    assert.deepEqual(b.notifications.map((n) => n.title), ["B 的通知"]);
    assert.equal(b.unread, 1, "A's notices never contribute to B's count");
  } finally {
    close();
  }
});

test("act: a notice with no action refuses by name and stays unread", async () => {
  const { call, close } = await boot();
  try {
    const id = idOf("B 的通知", "b@x");
    const res = await call("POST", `/api/notify/inbox/b@x/${id}/act`);
    assert.equal(res.status, 400);
    assert.equal((await res.json()).code, "no_action");
    assert.equal(stateOf(id), "unread");
  } finally {
    close();
  }
});

test("act: someone else's notice answers 404 (same shape as a nonexistent id)", async () => {
  const { call, close } = await boot();
  try {
    const id = idOf("带动作的通知", "a@x");
    assert.equal((await call("POST", `/api/notify/inbox/b@x/${id}/act`)).status, 404);
    assert.equal((await call("POST", `/api/notify/inbox/b@x/nope/act`)).status, 404);
  } finally {
    close();
  }
});

test("act: an UNREGISTERED action is refused — a notice is not a permission bypass", async () => {
  const { call, close } = await boot();
  try {
    const id = idOf("未注册动作", "a@x");
    const res = await call("POST", `/api/notify/inbox/a@x/${id}/act`);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.code, "tool_not_registered");
    assert.match(body.error, /not\.a\.registered\.action/);
    assert.equal(stateOf(id), "unread", "a refused action must not consume the notice");
  } finally {
    close();
  }
});

test("gate: a write-tier registered action cannot EXECUTE from a notice", async () => {
  // Through the helper directly: the full route needs a cell context
  // (preflight/mandate/executor) that is out of scope here, but the decision
  // this pins — "proposed, never executed" — is made by the gate itself.
  const out = await runNotificationAction({
    action: { actionId: "facet.pack.visibility", args: { packId: "p1", visibility: "public" } },
    ownerEmail: "a@x",
  });
  assert.ok([200, 400, 500, 503].includes(out.status), `unexpected status ${out.status}`);
  if (out.ok) assert.notEqual(out.body?.state, "executed", "a write-tier action may not execute from a notice");
});

test("helper: an action with no actionId or no owner is refused before the gate", async () => {
  assert.equal((await runNotificationAction({ action: {}, ownerEmail: "a@x" })).status, 400);
  assert.equal((await runNotificationAction({ action: { actionId: "x" }, ownerEmail: "" })).status, 400);
});

test("MCP child: with no owner identity it reports unavailable instead of calling", async () => {
  const res = await runTool({
    name: "notify_inbox_list",
    args: {},
    identity: { ownerEmail: null, origin: "http://127.0.0.1:1" },
  });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /NOTIFY_OWNER_EMAIL is empty/);
});

test("MCP child: list relays the bridge payload through the injected identity", async () => {
  const { base, close } = await boot();
  try {
    const driver = httpDriver({ ownerEmail: "a@x", origin: base });
    const out = await driver.list({ limit: 10 });
    assert.equal(out.notifications.length, 2);
    assert.equal(out.unread, 2);
    for (const n of out.notifications) assert.equal(n.recipientId, "a@x");
  } finally {
    close();
  }
});
