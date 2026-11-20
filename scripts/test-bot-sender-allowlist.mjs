// Tests for the bot sender allowlist (add-staff-fleet-channels).
//
// Two layers, because they fail differently:
//   1. pure: normalization + the posture decision table (fast, no I/O)
//   2. pipeline: a real webhook through the real routes and the real bots
//      module, asserting the REJECTED sender produced NO turn at all —
//      "no prompt was called" is the only judge that counts, since the spec's
//      promise is about side effects, not about a return value.
//
// Run: node --test scripts/test-bot-sender-allowlist.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import express from "express";

// Hermetic outbound (same reason as scripts/test-bots.mjs): the telegram
// adapter still calls getMe/sendText, and with no route out those connects park
// forever — the file then never exits and the unit step times out.
const REAL_FETCH = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = typeof input === "string" ? input : (input?.url ?? String(input));
  if (url.startsWith("https://api.telegram.org")) {
    return Promise.resolve(
      new Response(JSON.stringify({ ok: false, description: "Unauthorized" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    );
  }
  return REAL_FETCH(input, init);
};

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bot-allow-"));
process.env.DB_PATH = path.join(tmpRoot, "app.db");
// The disposition ring writes next to PLATFORM_DATA_DIR (server.js sets it in
// prod). Without this the ring would land in the repo working directory.
process.env.PLATFORM_DATA_DIR = tmpRoot;
delete process.env.BOTS_ALLOW_TOOLS;
delete process.env.PUBLIC_BASE_URL;

const db = await import("../db.js");
const bots = await import("../server/bots.js");
const { recordDisposition } = await import("../server/fleet-turn-mandate.js");
const { createAppContext } = await import("../server/context.js");
const { registerAuth } = await import("../server/auth.js");
const { registerBotRoutes, WEBHOOK_PREFIX } = await import("../server/routes/bots.js");

const { normalizeAllowedSenders, isSenderAllowed, botToolPosture, TOOL_POSTURE_REASONS } = bots;

// ── 1. pure ────────────────────────────────────────────────────────────────

test("normalize: trims, drops blanks, dedupes, keeps order", () => {
  assert.deepEqual(normalizeAllowedSenders([" ada ", "", "bob", "ada"]), { ok: true, value: ["ada", "bob"] });
});

test("normalize: null/undefined/empty are 'no allowlist'", () => {
  assert.deepEqual(normalizeAllowedSenders(undefined).value, []);
  assert.deepEqual(normalizeAllowedSenders(null).value, []);
  assert.deepEqual(normalizeAllowedSenders([]).value, []);
  assert.deepEqual(normalizeAllowedSenders("").value, []);
});

test("normalize: accepts the JSON string a row carries", () => {
  assert.deepEqual(normalizeAllowedSenders('["ada","bob"]').value, ["ada", "bob"]);
});

test("normalize: refuses what it cannot honour instead of shortening it", () => {
  assert.equal(normalizeAllowedSenders("not json").ok, false);
  assert.equal(normalizeAllowedSenders([1, 2]).ok, false);
  assert.equal(normalizeAllowedSenders({ a: 1 }).ok, false);
  // >32 entries
  assert.equal(normalizeAllowedSenders(Array.from({ length: 33 }, (_, i) => `u${i}`)).ok, false);
  // >128 chars on one entry — truncating here would match nobody and look like
  // "the allowlist doesn't work", so it is a refusal.
  assert.equal(normalizeAllowedSenders(["x".repeat(129)]).ok, false);
});

test("isSenderAllowed: empty list allows (pre-change behavior)", () => {
  assert.equal(isSenderAllowed({ allowedSenders: [] }, "anyone"), true);
  assert.equal(isSenderAllowed({}, "anyone"), true);
  assert.equal(isSenderAllowed({ allowedSenders: [] }, null), true);
});

test("isSenderAllowed: listed sender passes, unlisted is refused", () => {
  const bot = { allowedSenders: ["ada"] };
  assert.equal(isSenderAllowed(bot, "ada"), true);
  assert.equal(isSenderAllowed(bot, " adam "), false);
  assert.equal(isSenderAllowed(bot, "bob"), false);
});

test("isSenderAllowed: list present but no sender id fails CLOSED", () => {
  const bot = { allowedSenders: ["ada"] };
  assert.equal(isSenderAllowed(bot, undefined), false);
  assert.equal(isSenderAllowed(bot, ""), false);
  assert.equal(isSenderAllowed(bot, "   "), false);
});

test("tool posture: four reasons, three of them refuse", () => {
  const bot = { allowTools: true, allowedSenders: ["ada"] };
  assert.deepEqual(botToolPosture(bot, { BOTS_ALLOW_TOOLS: "1" }), { toolsOn: true, reason: TOOL_POSTURE_REASONS.ON });
  assert.deepEqual(botToolPosture(bot, {}), { toolsOn: false, reason: TOOL_POSTURE_REASONS.CEILING_OFF });
  assert.deepEqual(botToolPosture({ ...bot, allowTools: false }, { BOTS_ALLOW_TOOLS: "1" }), {
    toolsOn: false,
    reason: TOOL_POSTURE_REASONS.BOT_SWITCH_OFF,
  });
  assert.deepEqual(botToolPosture({ allowTools: true, allowedSenders: [] }, { BOTS_ALLOW_TOOLS: "1" }), {
    toolsOn: false,
    reason: TOOL_POSTURE_REASONS.ALLOWLIST_EMPTY,
  });
});

// ── 2. pipeline: a rejected sender must produce NO turn ────────────────────

let server;
let base;
let ctx;

const postJson = async (p, body) => {
  const res = await fetch(`${base}${p}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
};

const patchJson = async (p, body) => {
  const res = await fetch(`${base}${p}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
};

let fixtureMessageId = 1;
const update = (chatId, text, username) => ({
  update_id: Math.floor(Math.random() * 1e6),
  message: { message_id: fixtureMessageId++, chat: { id: chatId }, from: { username }, date: 0, text },
});

async function deliver(bot, body) {
  const secret = bot.webhookUrl.split("/").pop();
  const res = await postJson(`/api/bots/webhook/${bot.id}/${secret}`, body);
  await new Promise((r) => setTimeout(r, 30)); // the route acks before the turn
  return res;
}

before(async () => {
  await db.initDb();
  const app = express();
  const jsonBodyParser = express.json();
  app.use((req, res, next) => (req.path.startsWith(WEBHOOK_PREFIX) ? next() : jsonBodyParser(req, res, next)));
  ctx = createAppContext({ AUTH_MODE: "none" });
  ctx.app = app;
  // Mirror server.js:2057. createAppContext does NOT wire this seam (it lives in
  // server.js above the app context), so a harness that skips it silently turns
  // every guard into "filtered but unrecorded" — the exact failure this change
  // exists to prevent. Wiring it here makes the countability assertion real.
  ctx.recordSignalDisposition = (botId, entry) => recordDisposition(botId, entry);
  registerAuth(ctx);
  registerBotRoutes(ctx);

  ctx.dshBridge = {
    isReady: () => true,
    prompts: [],
    async prompt(sessionId, blocks) {
      this.prompts.push({ sessionId, text: blocks.at(-1).text });
      queueMicrotask(() => {
        const collector = ctx.sessionCollectors.get(sessionId);
        if (!collector) return;
        collector({ method: "session.event", params: { sessionId, event: { type: "text", text: "ok" } } });
        collector({ method: "session.status", params: { sessionId, status: "idle" } });
      });
      return "msg-1";
    },
  };

  bots.initBots(ctx);
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  bots.stopAll();
  globalThis.fetch = REAL_FETCH;
  await new Promise((r) => server.close(r));
});

async function makeBot(name, extra = {}) {
  const out = await postJson("/api/bots", {
    type: "telegram",
    name,
    credentials: { token: "123:abc" },
    ...extra,
  });
  assert.equal(out.status, 200, JSON.stringify(out.json));
  return out.json;
}

test("allowlist refuses a stranger with zero side effects", async () => {
  const bot = await makeBot("guard", { allowedSenders: ["ada"] });
  assert.deepEqual(bot.allowedSenders, ["ada"]);
  const before = ctx.dshBridge.prompts.length;

  await deliver(bot, update(1001, "hello", "mallory"));
  assert.equal(ctx.dshBridge.prompts.length, before, "a refused sender must not start a turn");

  await deliver(bot, update(1002, "hello", "ada"));
  assert.equal(ctx.dshBridge.prompts.length, before + 1, "an allowed sender still gets a turn");
});

// Silent outward is only safe BECAUSE it is countable inward. If the count is
// unreachable, a typo in the allowlist (or a stranger probing) produces nothing
// an operator can act on — the two look identical from the admin surface.
test("the refusal is countable through the read face", async () => {
  const bot = await makeBot("counted", { allowedSenders: ["ada"] });

  await deliver(bot, update(1101, "hello", "mallory"));
  await deliver(bot, update(1102, "hello", "eve"));

  const res = await fetch(`${base}/api/bots/${bot.id}/dispositions`);
  assert.equal(res.status, 200);
  const { summary } = await res.json();
  assert.equal(summary.senderBlocked.count, 2, "two refused senders, two counted");
  assert.ok(summary.senderBlocked.lastAt, "the last refusal carries a timestamp");
  assert.equal(typeof summary.senderBlocked.lastSenderHash, "string");
  assert.notEqual(summary.senderBlocked.lastSenderHash, "mallory", "the plaintext id is never stored");
  assert.ok(summary.byReason.sender_not_allowed >= 2);

  // An allowed message must not move the count.
  await deliver(bot, update(1103, "hello", "ada"));
  const after = await (await fetch(`${base}/api/bots/${bot.id}/dispositions`)).json();
  assert.equal(after.summary.senderBlocked.count, 2);
});

test("an empty allowlist keeps the old behavior for every sender", async () => {
  const bot = await makeBot("open");
  assert.deepEqual(bot.allowedSenders, []);
  const before = ctx.dshBridge.prompts.length;
  await deliver(bot, update(2001, "hi", "mallory"));
  assert.equal(ctx.dshBridge.prompts.length, before + 1);
});

test("write face refuses an allowlist it cannot honour", async () => {
  const bad = await postJson("/api/bots", {
    type: "telegram",
    name: "bad",
    credentials: { token: "123:abc" },
    allowedSenders: [{ not: "a string" }],
  });
  assert.equal(bad.status, 400);

  const bot = await makeBot("patchme");
  const tooLong = await patchJson(`/api/bots/${bot.id}`, { allowedSenders: ["x".repeat(200)] });
  assert.equal(tooLong.status, 400);
  const cleared = await patchJson(`/api/bots/${bot.id}`, { allowedSenders: [] });
  assert.equal(cleared.status, 200);
});

test("mask carries the allowlist and the effective posture reason", async () => {
  const bot = await makeBot("posture", { allowTools: true });
  // Ceiling unset in this suite ⇒ tools off, and the reason says WHY.
  assert.deepEqual(bot.toolPosture, { toolsOn: false, reason: TOOL_POSTURE_REASONS.CEILING_OFF });

  process.env.BOTS_ALLOW_TOOLS = "1";
  try {
    const emptyList = await patchJson(`/api/bots/${bot.id}`, { allowedSenders: [] });
    assert.deepEqual(emptyList.json.toolPosture, { toolsOn: false, reason: TOOL_POSTURE_REASONS.ALLOWLIST_EMPTY });
    const listed = await patchJson(`/api/bots/${bot.id}`, { allowedSenders: ["ada"] });
    assert.deepEqual(listed.json.toolPosture, { toolsOn: true, reason: TOOL_POSTURE_REASONS.ON });
  } finally {
    delete process.env.BOTS_ALLOW_TOOLS;
  }
});

// The gate sits before the fleet-event wake and the room bridge, not just
// before the bot's own turn. That ordering is the difference between "a
// stranger gets no reply" and "a stranger can start work in my fleet / walk
// into my room". A refactor that moved the gate one block later would keep
// every other test green, so this one pins the boundary itself.
test("a refused sender cannot wake a fleet post or enter a room", async () => {
  const bot = await makeBot("boundary", { allowedSenders: ["ada"] });
  const woken = [];
  const bridged = [];
  const prevWake = ctx.triggerFleetEventWake;
  const prevBridge = ctx.zhiyuImBridge;
  ctx.triggerFleetEventWake = (botId, payload) => { woken.push(payload); return []; };
  ctx.zhiyuImBridge = {
    noteInboundChat() {},
    async handleInbound(payload) { bridged.push(payload); return true; },
  };
  try {
    await deliver(bot, update(3001, "hey team", "mallory"));
    assert.equal(woken.length, 0, "a refused sender must not wake a post");
    assert.equal(bridged.length, 0, "a refused sender must not reach the room bridge");

    await deliver(bot, update(3002, "hey team", "ada"));
    assert.equal(woken.length, 1, "an allowed sender still wakes (the ordering changed, not the wake)");
  } finally {
    ctx.triggerFleetEventWake = prevWake;
    ctx.zhiyuImBridge = prevBridge;
  }
});

// 1.3: the refusal must be readable at boot, not only inferable from a turn that
// quietly did nothing. Only bots that ASKED for tools are worth a line —
// otherwise the notice drowns in bots that never wanted them.
test("boot log names the reason when a bot asks for tools and is refused", async () => {
  process.env.BOTS_ALLOW_TOOLS = "1";
  const lines = [];
  const realWarn = console.warn;
  console.warn = (...args) => { lines.push(args.join(" ")); };
  try {
    await makeBot("logged-empty", { allowTools: true });
    await makeBot("logged-off", { allowTools: false });
    await makeBot("logged-ok", { allowTools: true, allowedSenders: ["ada"] });
  } finally {
    console.warn = realWarn;
    delete process.env.BOTS_ALLOW_TOOLS;
  }
  const notice = (name) => lines.filter((l) => l.includes(`"${name}" asks for tools but runs WITHOUT them`));

  assert.equal(notice("logged-empty").length, 1, "an empty allowlist must be announced");
  assert.match(notice("logged-empty")[0], /allowlist is empty/);
  assert.equal(notice("logged-off").length, 0, "a bot that never asked for tools must stay quiet");
  assert.equal(notice("logged-ok").length, 0, "a bot whose three conditions hold must stay quiet");
});
