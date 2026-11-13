// The mobile→web boundary (openspec: add-zhiyu-mobile-clients, 5.1 / 5.2).
//
// Two failures are being pinned, and neither is hypothetical:
//   • the phone grows a simplified private window / invite sheet, and the two
//     permission models drift until the phone grants a history scope the web
//     refuses;
//   • the hand-off link is a standing token, so a URL pasted into a group chat
//     becomes a permanent way into somebody's room.
//
// So: the actions that leave the app are a closed list, the link is spent by the
// first redeem (the UPDATE's WHERE clause, not a read-then-write), and the token
// carries no room, no user, no session.
//
//   node --test scripts/test-mobile-handoff.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { registerZhiyuRoutes } from "../gateway/zhiyu/index.js";
import { mintDeeplink, verifyDeeplink, redeemDeeplink, handoffPathFor, DEEPLINK_PURPOSES, DEEPLINK_TTL_SEC } from "../gateway/zhiyu/deeplink.js";

const CORE = await import("../packages/core/src/mobile-handoff.ts");
const {
  MOBILE_LOCAL_CAPABILITIES,
  MOBILE_HANDOFF_ACTIONS,
  isHandoffAction,
  mobileMayDo,
  handoffRequest,
  handoffLinkFrom,
  handoffIsExpired,
} = CORE;

const OPEN = [];
test.after(() => Promise.all(OPEN.map((srv) => new Promise((r) => srv.close(r)))));

async function boot() {
  const express = (await import("express")).default;
  const app = express();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-"));
  const webDist = path.join(tmp, "dist");
  fs.mkdirSync(webDist, { recursive: true });
  fs.writeFileSync(path.join(webDist, "index.html"), "<!doctype html><title>shell</title>");
  const zhiyu = registerZhiyuRoutes(app, {
    dataRoot: path.join(tmp, "data"),
    resolveUser: (req) => (req.headers["x-user"] ? { email: req.headers["x-user"], groups: [] } : null),
    rejectUnauthenticated: (_req, res) => res.status(401).json({ error: "auth" }),
    env: { PAAS_BASE_URL: "https://x.test" },
    webDist,
    callAgent: async (member) => ({ text: `（${member.display}的回答）` }),
    ssePollMs: 60,
    startTimers: false,
  });
  const srv = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  OPEN.push(srv);
  const base = `http://127.0.0.1:${srv.address().port}`;
  const cli = (email) => {
    const call = async (method, p, body) => {
      const r = await fetch(`${base}${p}`, {
        method,
        headers: { "x-user": email, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      const text = await r.text();
      let parsed = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { raw: text };
      }
      return { status: r.status, body: parsed, headers: r.headers };
    };
    return { get: (p) => call("GET", p), post: (p, b) => call("POST", p, b ?? {}), store: zhiyu.store };
  };
  return { cli, zhiyu, base, close: () => srv.close() };
}

/** Room owned by a@x with b@x as an accepted member; c@x is a stranger. */
async function seedRoom(cli) {
  const created = await cli("a@x").post("/api/zhiyu/rooms", { title: "交接房" });
  const roomId = created.body.room.id;
  const invited = await cli("a@x").post(`/api/zhiyu/rooms/${roomId}/invites`, { kind: "user", ref: "b@x" });
  await cli("b@x").post(`/api/zhiyu/invites/${invited.body.invite.id}/accept`, {});
  return roomId;
}

const mint = (client, roomId, purpose) => client.post(`/api/zhiyu/rooms/${roomId}/deeplink`, { purpose });
const spend = (client, token) => client.post(`/api/zhiyu/deeplink/${token}`, {});

// ── 5.1 the boundary is a closed list ─────────────────────────────────────

test("5.1 the local capability list is exactly list/stream/presence/send", () => {
  assert.deepEqual([...MOBILE_LOCAL_CAPABILITIES], ["rooms.list", "room.stream", "room.presence.read", "room.message.send"]);
  // The three interactions the change names as web-only, plus room settings.
  assert.deepEqual(
    MOBILE_HANDOFF_ACTIONS.map((a) => a.action),
    ["private_window", "invite", "subscription", "room_settings"],
  );
  for (const action of MOBILE_HANDOFF_ACTIONS) {
    assert.match(action.target, /^web\./, `${action.action} must name a web surface`);
    assert.equal(action.ownerOnly, action.action === "invite" || action.action === "room_settings");
  }
  assert.equal(mobileMayDo("room.private"), false, "the private window is not a local capability");
  assert.equal(mobileMayDo("room.message.send"), true);
  assert.equal(isHandoffAction("private_window"), true);
  assert.equal(isHandoffAction("export_everything"), false, "an unknown action is not a hand-off");
});

test("5.1 every hand-off action mints a link, and the request shape is shared by both clients", async () => {
  const { cli, close } = await boot();
  const roomId = await seedRoom(cli);
  for (const { action } of MOBILE_HANDOFF_ACTIONS) {
    const req = handoffRequest(action, roomId);
    assert.deepEqual(req, { path: `/api/zhiyu/rooms/${roomId}/deeplink`, method: "POST", body: { purpose: action } });
    const out = await mint(cli("a@x"), roomId, action);
    assert.equal(out.status, 200, `${action} must mint`);
    const link = handoffLinkFrom(out.body);
    assert.ok(link, `${action}: the response must normalize into a link`);
    assert.match(link.url, /^https:\/\/x\.test\/zhiyu\/deeplink\/zdl_[0-9a-f]{12}\.[0-9a-f]{32}$/);
    assert.equal(handoffIsExpired(link), false);
    assert.equal(handoffIsExpired(link, link.expiresAt + 1000), true);
  }
  assert.equal(handoffRequest("private_window", ""), null, "no room, no link");
  assert.equal(handoffRequest("nope", roomId), null);
  assert.equal(handoffLinkFrom({ url: "" }), null, "a response without a URL is not a link");
  close();
});

test("5.1 an unknown purpose is refused, and the refusal lists the real ones", async () => {
  const { cli, close } = await boot();
  const roomId = await seedRoom(cli);
  const out = await mint(cli("a@x"), roomId, "delete_the_room");
  assert.equal(out.status, 400);
  assert.deepEqual(out.body.purposes, [...DEEPLINK_PURPOSES]);
  close();
});

test("5.1 owner-only surfaces are refused to a plain member", async () => {
  const { cli, close } = await boot();
  const roomId = await seedRoom(cli);
  assert.equal((await mint(cli("b@x"), roomId, "invite")).status, 403);
  assert.equal((await mint(cli("b@x"), roomId, "room_settings")).status, 403);
  // Their own private window and their own subscription are theirs to open.
  assert.equal((await mint(cli("b@x"), roomId, "private_window")).status, 200);
  assert.equal((await mint(cli("b@x"), roomId, "subscription")).status, 200);
  close();
});

// ── 5.2 one-time, and worth nothing to a stranger ─────────────────────────

test("5.2 the link is spent on the first redeem and refused on the second", async () => {
  const { cli, close } = await boot();
  const roomId = await seedRoom(cli);
  const token = (await mint(cli("a@x"), roomId, "private_window")).body.path.split("/").pop();

  const first = await spend(cli("a@x"), token);
  assert.equal(first.status, 200);
  assert.equal(first.body.roomId, roomId);
  assert.equal(first.body.purpose, "private_window");
  assert.equal(first.body.path, handoffPathFor(roomId, "private_window"));

  const second = await spend(cli("a@x"), token);
  assert.equal(second.status, 404, "second use must be refused");
  close();
});

test("5.2 two opens racing the same link produce exactly one winner", async () => {
  const { cli, close } = await boot();
  const roomId = await seedRoom(cli);
  const token = (await mint(cli("a@x"), roomId, "subscription")).body.path.split("/").pop();
  const [one, two] = await Promise.all([spend(cli("a@x"), token), spend(cli("a@x"), token)]);
  const statuses = [one.status, two.status].sort();
  assert.deepEqual(statuses, [200, 404], `exactly one spend wins, got ${statuses.join("/")}`);
  close();
});

test("5.2 opening the page shell does not spend the link (WeChat unfurls every pasted URL)", async () => {
  const { cli, base, close } = await boot();
  const roomId = await seedRoom(cli);
  const token = (await mint(cli("a@x"), roomId, "invite")).body.path.split("/").pop();

  const shell = await fetch(`${base}/zhiyu/deeplink/${token}`);
  assert.equal(shell.status, 200);
  assert.match(await shell.text(), /<title>shell<\/title>/);
  const again = await fetch(`${base}/zhiyu/deeplink/${token}`);
  assert.equal(again.status, 200, "a preview crawler must not eat the link");

  const spent = await spend(cli("a@x"), token);
  assert.equal(spent.status, 200, "the user's own tap still works after the unfurl");
  const dead = await fetch(`${base}/zhiyu/deeplink/${token}`);
  assert.equal(dead.status, 404, "and once spent, the shell 404s");
  close();
});

test("5.2 an expired link is refused", async () => {
  const { cli, zhiyu, close } = await boot();
  const roomId = await seedRoom(cli);
  const minted = mintDeeplink(zhiyu.store, { roomId, purpose: "private_window", createdBy: "a@x" });
  assert.ok(verifyDeeplink(zhiyu.store, minted.token), "valid right now");
  const later = Date.now() + (DEEPLINK_TTL_SEC + 5) * 1000;
  assert.equal(verifyDeeplink(zhiyu.store, minted.token, { now: () => later }), null, "past its expiry it verifies as nothing");
  assert.equal(redeemDeeplink(zhiyu.store, minted.token, { now: () => later }), null);
  close();
});

test("5.2 a stranger cannot spend a link, even with the exact token", async () => {
  const { cli, close } = await boot();
  const roomId = await seedRoom(cli);
  const token = (await mint(cli("a@x"), roomId, "invite")).body.path.split("/").pop();
  const out = await spend(cli("c@x"), token);
  assert.equal(out.status, 404, "the link carries intent, not authority");
  // …and it was NOT burned by the stranger's attempt: the owner can still use it.
  const owner = await spend(cli("a@x"), token);
  assert.equal(owner.status, 200);
  close();
});

test("5.2 the URL carries no credential-shaped parameter and no identifier", async () => {
  const { cli, close } = await boot();
  const roomId = await seedRoom(cli);
  const out = await mint(cli("a@x"), roomId, "private_window");
  const url = out.body.url;
  const parsed = new URL(url);
  assert.equal([...parsed.searchParams.keys()].length, 0, `no query parameters at all, found ${url}`);
  assert.equal(url.includes(roomId), false, "the room id is not in the URL");
  assert.equal(url.includes("a@x") && !url.includes("a%40x"), false, "no user identity in the URL");
  assert.equal(/cookie|session|jwt|sid|sk_|wtr_/i.test(url), false, "no long-term credential of any shape");
  // Two mints for the same room and the same user are unrelated tokens.
  const other = (await mint(cli("a@x"), roomId, "private_window")).body.url;
  assert.notEqual(url, other);
  close();
});

// ── 5.1 the mobile trees implement none of it ─────────────────────────────
//
// The scanner is a real function with an injectable root, and it is proven red
// against a synthetic violation: a gate that cannot fail is not a gate, and
// today's trees are empty of zhiyu code precisely because the pages are the
// last thing built.

const MOBILE_ROOTS = ["miniapp/src", "app/src"];
const FORBIDDEN = [/\/private\b/, /\/invites\b/, /\/fleet-subs\b/, /share-link/, /widget\/rotate/];

function scanForHandoffImplementations(root) {
  const hits = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (["node_modules", "dist", ".expo", ".taro"].includes(e.name)) continue;
        walk(p);
        continue;
      }
      if (!/\.(ts|tsx|js|jsx|mjs)$/.test(e.name)) continue;
      const src = fs.readFileSync(p, "utf8");
      for (const re of FORBIDDEN) if (re.test(src)) hits.push(`${path.relative(root, p)} matches ${re}`);
    }
  };
  walk(root);
  return hits;
}

test("5.1 the scanner catches a violation (proven red before trusting green)", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mobile-scan-"));
  fs.mkdirSync(path.join(tmp, "pages"), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, "pages", "room.tsx"),
    `const r = await request("POST", \`/api/zhiyu/rooms/\${id}/private\`, { content });\n`,
  );
  const hits = scanForHandoffImplementations(tmp);
  assert.equal(hits.length, 1, `the scanner must flag a private-window call, got ${JSON.stringify(hits)}`);
  assert.match(hits[0], /private/);
});

test("5.1 the mini-program and app trees implement none of the hand-off surfaces", () => {
  const root = path.resolve(import.meta.dirname, "..");
  for (const rel of MOBILE_ROOTS) {
    const dir = path.join(root, rel);
    if (!fs.existsSync(dir)) continue;
    assert.deepEqual(scanForHandoffImplementations(dir), [], `${rel} must not implement a hand-off surface`);
  }
});
