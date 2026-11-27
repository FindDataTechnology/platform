// Broadcast routes, gateway side (add-broadcast-and-notification-inbox 1.5/2.1).
//
// The properties that matter, each a failure this file exists to prevent:
//   · a non-admin gets 403 and NOTHING is written (a broadcast is not a side
//     effect of a rejected request);
//   · a zero-hit audience refuses and leaves no ledger row;
//   · the issuer reports hit/ok/fail honestly (ok starts at 0 — a send is not
//     a delivery);
//   · a machine without the gateway secret cannot pull, and a cell that pulls
//     receives the RESOLVED recipient list rather than the selector.
//
// Boots the real Express app on an ephemeral port (no supertest in this repo).
//
//   node --test scripts/test-broadcast-routes.mjs

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import express from "express";
import Database from "better-sqlite3";
import { cellCredential } from "../gateway/cell-credential.js";
import { createBroadcastLedger, BROADCAST_LEDGER_DDL } from "../lib/broadcast-store.js";
import { openBroadcastCenter } from "../gateway/broadcast-center.js";
import { registerBroadcastRoutes } from "../gateway/routes-broadcast.js";

// 心跳（2026-11-27 诊断）：CI 上本文件在第 10 条与第 11 条之间挂住 180s。
// 若心跳照常打印 ⇒ 事件循环活着、runner 在等某个异步；若心跳也不打印 ⇒ 同步阻塞。
let __beat = 0;
setInterval(() => console.error(`[broadcast-routes] heartbeat ${++__beat}`), 10_000).unref?.();
process.on("exit", (code) => console.error(`[broadcast-routes] exit ${code}`));
process.on("uncaughtException", (e) => console.error(`[broadcast-routes] uncaught ${e?.stack ?? e}`));

const SECRET = "test-gateway-secret";
const CELL_ID = "0123456789abcdef";
// The door verifies a per-cell credential (harden-cell-isolation 1.1), not the
// master — mint the token the gateway would present.
const TOKEN = cellCredential(SECRET, CELL_ID);

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "broadcast-test-"));
}

/**
 * A center with a stubbed identity source: org → three emails, role → one, all
 * → four. `empty-org` hits nobody, which is how the zero-hit refusal is
 * exercised without inventing a new selector kind.
 */
function stubCenter({ dataRoot = tmpRoot() } = {}) {
  const db = new Database(path.join(dataRoot, "broadcasts.db"));
  db.exec(BROADCAST_LEDGER_DDL);
  const ledger = createBroadcastLedger({ db });
  return {
    db,
    ledger,
    resolveAudience: async (selector) => {
      const { resolveAudience } = await import("../lib/broadcast-audience.js");
      return resolveAudience(selector, {
        usersInOrg: async (id) =>
          id === "lex-customers" ? ["u1@x", "u2@x", "u3@x"] : [],
        usersWithRole: async (r) => (r === "legal" ? ["u1@x"] : []),
        allEmails: async () => ["u1@x", "u2@x", "u3@x", "u4@x"],
      });
    },
    describeAudience: (s) => `受众 ${s?.kind}`,
    pendingSince: (since, limit) => ledger.pendingSince(since, limit),
  };
}

/** A user resolver over a header: `x-test-user: <email>` (admin when `x-test-admin: 1`). */
const resolveUser = (req) => {
  const email = req.headers["x-test-user"];
  return email ? { email: String(email), groups: [] } : null;
};
const isAdminUser = (user) => Boolean(user?.email) && user.email === "admin@x";

async function boot(t, center, { imInbox = null } = {}) {
  const app = express();
  registerBroadcastRoutes(app, {
    center,
    isAdminUser,
    resolveUser,
    rejectUnauthenticated: (_req, res) => res.status(401).json({ error: "Authentication required" }),
    secret: SECRET,
    imInbox,
  });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  // `server.close()` leaves keep-alive sockets from `fetch()` alive, so the
  // listener keeps the event loop open and the process never exits — the file
  // TIMEOUT'd at 240s under the per-file runner (2026-11-25). Drop idle
  // connections first.
  t.after(() => {
    server.closeAllConnections?.();
    server.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  // 无连接池的请求（agent: false ⇒ 每次新连接、用完即关）+ 每请求超时。
  // 为什么不用全局 fetch：fetch 的 keep-alive 池会在「上一条用例的服务器已关」
  // 之后复用它留下的 socket，2026-11-27 CI 上表现为某条用例静默挂满 180s
  // （本地任何 Node 版本都复现不了）。这条测的是路由行为，不是连接复用；
  // 把它从池子里移出去，挂起就无从而来，真要挂也会 5s 后以明确错误失败。
  const call = (method, url, { user, body, headers = {} } = {}) =>
    new Promise((resolve, reject) => {
      const req = http.request(
        `${base}${url}`,
        {
          method,
          agent: false,
          timeout: 5000,
          headers: {
            "content-type": "application/json",
            ...(user ? { "x-test-user": user } : {}),
            ...headers,
          },
        },
        (res) => {
          let data = "";
          res.setEncoding("utf8");
          res.on("data", (c) => (data += c));
          res.on("end", () =>
            resolve({
              status: res.statusCode,
              headers: res.headers,
              json: async () => JSON.parse(data),
              text: async () => data,
            }),
          );
        },
      );
      req.on("timeout", () => req.destroy(new Error(`request ${method} ${url} timed out after 5s`)));
      req.on("error", reject);
      if (body !== undefined) req.write(JSON.stringify(body));
      req.end();
    });
  return { base, call };
}

const BROADCAST = { audience: { kind: "org", id: "lex-customers" }, title: "变更通知", body: "请查看" };

test("non-admin: 403 and no ledger row is written", async (t) => {
  const center = stubCenter();
  const { call } = await boot(t, center);
  const res = await call("POST", "/api/broadcast", { user: "someone@x", body: BROADCAST });
  assert.equal(res.status, 403);
  assert.equal(center.ledger.pendingSince(0).length, 0, "a rejected request must not record a broadcast");
});

test("unauthenticated: 401, not 403", async (t) => {
  const center = stubCenter();
  const { call } = await boot(t, center);
  assert.equal((await call("POST", "/api/broadcast", { body: BROADCAST })).status, 401);
});

test("admin: records the broadcast and reports hit with ok/fail at zero", async (t) => {
  const center = stubCenter();
  const { call } = await boot(t, center);
  const res = await call("POST", "/api/broadcast", { user: "admin@x", body: BROADCAST });
  assert.equal(res.status, 201);
  const out = await res.json();
  assert.equal(out.hitCount, 3);
  assert.equal(out.okCount, 0, "a send is not a delivery");
  assert.equal(out.failCount, 0);
  assert.ok(out.id);
  assert.equal(center.ledger.getById(out.id).actor, "admin@x");
});

test("zero hits: 400 with the reason, and no ledger row", async (t) => {
  const center = stubCenter();
  const { call } = await boot(t, center);
  const res = await call("POST", "/api/broadcast", {
    user: "admin@x",
    body: { audience: { kind: "org", id: "empty-org" }, body: "x" },
  });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, "zero-hits");
  assert.equal(center.ledger.pendingSince(0).length, 0);
});

test("unknown audience kind: 400, no row", async (t) => {
  const center = stubCenter();
  const { call } = await boot(t, center);
  const res = await call("POST", "/api/broadcast", {
    user: "admin@x",
    body: { audience: { kind: "everyone-in-lex" }, body: "x" },
  });
  assert.equal(res.status, 400);
  assert.equal(center.ledger.pendingSince(0).length, 0);
});

test("control: an empty body is refused before any identity work", async (t) => {
  const center = stubCenter();
  const { call } = await boot(t, center);
  const res = await call("POST", "/api/broadcast", { user: "admin@x", body: { audience: { kind: "all" } } });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /body is required/);
});

test("pull: no gateway secret → 401; with it → the resolved recipient list, not the selector", async (t) => {
  const center = stubCenter();
  const { call } = await boot(t, center);
  await call("POST", "/api/broadcast", { user: "admin@x", body: BROADCAST });

  assert.equal((await call("GET", "/api/broadcast/pending?since=0&cell=c1")).status, 401);

  const res = await call("GET", "/api/broadcast/pending?since=0&cell=c1", {
    headers: { "x-cloud-gateway-secret": TOKEN },
  });
  assert.equal(res.status, 200);
  const { broadcasts } = await res.json();
  assert.equal(broadcasts.length, 1);
  assert.deepEqual(broadcasts[0].recipients, ["u1@x", "u2@x", "u3@x"]);
  assert.deepEqual(broadcasts[0].audience, { kind: "org", id: "lex-customers" });
});

test("receipt: totals come from reports, and a cell retry does not double-count", async (t) => {
  const center = stubCenter();
  const { call } = await boot(t, center);
  const created = await (await call("POST", "/api/broadcast", { user: "admin@x", body: BROADCAST })).json();
  const headers = { "x-cloud-gateway-secret": TOKEN };

  const r1 = await call("POST", `/api/broadcast/${created.id}/receipt`, {
    headers,
    body: { cellId: "c1", ok: 2, fail: 0 },
  });
  assert.equal(r1.status, 200);
  assert.equal((await r1.json()).okCount, 2);

  // Same cell reports again (a retry after a network blip) — replaces, not adds.
  const r2 = await call("POST", `/api/broadcast/${created.id}/receipt`, {
    headers,
    body: { cellId: "c1", ok: 2, fail: 0 },
  });
  assert.equal((await r2.json()).okCount, 2);

  const r3 = await call("POST", `/api/broadcast/${created.id}/receipt`, {
    headers,
    body: { cellId: "c2", ok: 1, fail: 0 },
  });
  assert.equal((await r3.json()).okCount, 3);
});

test("receipt for an unknown broadcast: 404", async (t) => {
  const center = stubCenter();
  const { call } = await boot(t, center);
  const res = await call("POST", "/api/broadcast/nope/receipt", {
    headers: { "x-cloud-gateway-secret": TOKEN },
    body: { cellId: "c1", ok: 1, fail: 0 },
  });
  assert.equal(res.status, 404);
});

test("receipt without a cell id: 400 (totals would otherwise be unattributable)", async (t) => {
  const center = stubCenter();
  const { call } = await boot(t, center);
  const created = await (await call("POST", "/api/broadcast", { user: "admin@x", body: BROADCAST })).json();
  const res = await call("POST", `/api/broadcast/${created.id}/receipt`, {
    headers: { "x-cloud-gateway-secret": TOKEN },
    body: { ok: 1, fail: 0 },
  });
  assert.equal(res.status, 400);
});

test("a null center (ledger unavailable) answers 503, not 500 or a fake success", async (t) => {
  const { call } = await boot(t, null);
  assert.equal((await call("POST", "/api/broadcast", { user: "admin@x", body: BROADCAST })).status, 503);
});

test("openBroadcastCenter with an unwritable root returns null rather than throwing", () => {
  assert.equal(openBroadcastCenter({ dataRoot: "/proc/nope/nope", roleStore: null }), null);
});

// ── IM face (broadcast-reaches-zhiyu) ───────────────────────────────────────
//
// The rule these pin: the IM write is a SECOND delivery, never a precondition.
// A broadcast is recorded and its inbox lane filled whether or not any IM row
// lands; one recipient's IM failure is that recipient's result.

test("im: every recipient gets one IM write, and the response reports the split", async (t) => {
  const center = stubCenter();
  const calls = [];
  const { call } = await boot(t, center, {
    imInbox: async ({ email, broadcast }) => {
      calls.push({ email, title: broadcast.title });
      return { sent: true };
    },
  });
  const res = await call("POST", "/api/broadcast", { user: "admin@x", body: BROADCAST });
  assert.equal(res.status, 201);
  const out = await res.json();
  assert.deepEqual(calls.map((c) => c.email).sort(), ["u1@x", "u2@x", "u3@x"]);
  assert.equal(out.im.sent, 3);
  assert.equal(out.im.failed, 0);
});

test("im: one recipient failing does not stop the others, and is counted", async (t) => {
  const center = stubCenter();
  const seen = [];
  const { call } = await boot(t, center, {
    imInbox: async ({ email }) => {
      seen.push(email);
      if (email === "u2@x") throw new Error("zhiyu store closed");
      return { sent: true };
    },
  });
  const out = await (await call("POST", "/api/broadcast", { user: "admin@x", body: BROADCAST })).json();
  assert.equal(out.hitCount, 3, "the audience is unchanged by an IM failure");
  assert.equal(out.im.sent, 2);
  assert.equal(out.im.failed, 1);
  assert.equal(seen.length, 3, "the loop reaches every recipient regardless of order");
});

test("im: a broadcast with no IM face configured still records and reports hit", async (t) => {
  const center = stubCenter();
  const { call } = await boot(t, center); // imInbox omitted — the dev/desktop shape
  const out = await (await call("POST", "/api/broadcast", { user: "admin@x", body: BROADCAST })).json();
  assert.equal(out.hitCount, 3);
  assert.equal(out.im, undefined, "no IM face means no IM counters — not a zero that reads as failure");
  assert.equal(center.ledger.pendingSince(0).length, 1, "the broadcast is still recorded");
});

test("im: the notice carries the optional action through to the IM write", async (t) => {
  const center = stubCenter();
  let got = null;
  const { call } = await boot(t, center, { imInbox: async ({ broadcast }) => { got = broadcast; return { sent: true }; } });
  const body = { ...BROADCAST, action: { actionId: "facet.pack.visibility", args: { packId: "p1" } } };
  const res = await call("POST", "/api/broadcast", { user: "admin@x", body });
  assert.equal(res.status, 201);
  assert.deepEqual(got.action, { actionId: "facet.pack.visibility", args: { packId: "p1" } });
});

test("im: an action without an actionId is refused before anything is recorded", async (t) => {
  const center = stubCenter();
  const { call } = await boot(t, center, { imInbox: async () => ({ sent: true }) });
  const res = await call("POST", "/api/broadcast", {
    user: "admin@x",
    body: { ...BROADCAST, action: { args: { x: 1 } } },
  });
  assert.equal(res.status, 400);
  assert.equal(center.ledger.pendingSince(0).length, 0, "a malformed action must not leave a ledger row");
});
