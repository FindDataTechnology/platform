#!/usr/bin/env node
// ── Pack bot units (openspec: add-mixed-fleet-packs-and-market-consolidation,
//    spec pack-bot-units, tasks 2.1–2.4 + 2.6) ───────────────────────────────
//
// Covers the spec's first three requirements end to end:
//
//   1. bots 段是 pack 第三内容原语 — manifest validation: legal section passes,
//      a skill mount referencing a missing pack skill is rejected naming the
//      bot id + the missing skill, credential/endpoint-shaped forbidden keys
//      are rejected listing them, ids follow the agent-id rules (incl. the
//      reserved "user." namespace), the PACK_MAX_BOTS ceiling is env-tunable
//      and read at validation time.
//   2. 通用 bot 类型面 — the registry is v1=[channel], the read-only list
//      endpoint serves the very same objects (same source as the validator),
//      an unknown generic type is rejected naming the type.
//   3. 安装物化与冲突策略 — install materializes awaiting-connection disabled
//      bots into the real bot storage; foreign ids (another pack / a local
//      bot) skip with a reported reason while the rest of the pack installs;
//      the pack's own id replaces on upgrade keeping the operator's channel
//      credentials/secret/enabled state; uninstall deletes only pack-owned
//      bot rows and keeps the operator's channel credentials (detach ledger,
//      reattached on reinstall).
//   4. channel 类型实现 (to the "mounted skill injected into the session
//      context" layer — the full dsh runtime is out of unit-test reach and is
//      exercised by the fast e2e in task 2.4): an inbound message on a
//      skill-mounted channel bot carries the skill body as the session's
//      opening context block and the reply rides the existing adapter
//      sendText; without a mount the prompt blocks stay byte-identical to the
//      pre-pack-bot form; a born (unbound) pack bot has no runtime entry and
//      its webhook refuses — installing a pack widens no attack surface.
//
// The spec's fourth requirement (舰队衔接) is task 2.5 and lives with the
// fleet tests (scripts/test-fleet-*.mjs), not here.
//
//   node --test --test-concurrency=1 scripts/test-pack-bot-units.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import express from "express";

// Set the isolation env BEFORE importing anything that resolves paths/db.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pack-bot-units-"));
process.env.DB_PATH = path.join(tmpRoot, "app.db");
process.env.PLATFORM_DATA_DIR = path.join(tmpRoot, "data");
// A public URL keeps the telegram adapter's polling fallback OFF in tests
// (polling starts only when no PUBLIC_BASE_URL is set).
process.env.PUBLIC_BASE_URL = "http://127.0.0.1:1";
delete process.env.PACK_MAX_BOTS;
delete process.env.BOTS_ALLOW_TOOLS;

const db = await import("../db.js");
const packStore = await import("../pack-store.js");
const bots = await import("../server/bots.js");
const { GENERIC_BOT_TYPES, GENERIC_BOT_TYPE_NAMES } = await import("../lib/generic-bot-types.js");
const { validatePackManifest } = await import("../lib/pack-manifest.js");
const { createAppContext } = await import("../server/context.js");
const { registerAuth } = await import("../server/auth.js");
const { registerBotRoutes, WEBHOOK_PREFIX } = await import("../server/routes/bots.js");

// The channel credential detach ledger lives under the same storeDir("data")
// the pack store uses — isolated with everything else.
const { storeDir } = await import("../paths.js");
const ledgerPath = path.join(storeDir("data"), "kept-bot-credentials.json");
const readLedger = () => (fs.existsSync(ledgerPath) ? JSON.parse(fs.readFileSync(ledgerPath, "utf8")) : {});

// Turn harness (mirrors scripts/test-bots.mjs): every sendText captured, the
// scripted notification stream replayed when prompt() is called, prompt
// blocks captured in full so the skill-injection layer is assertable.
const sent = [];
let scriptedTurn = [];
let server;
let base;
let ctx;

before(async () => {
  await db.initDb();

  const app = express();
  const jsonBodyParser = express.json();
  app.use((req, res, next) =>
    req.path.startsWith(WEBHOOK_PREFIX) ? next() : jsonBodyParser(req, res, next),
  );
  ctx = createAppContext({ AUTH_MODE: "none" });
  ctx.app = app;
  registerAuth(ctx);
  registerBotRoutes(ctx);
  ctx.dshBridge = {
    isReady: () => true,
    prompts: [],
    async prompt(sessionId, blocks) {
      this.prompts.push({ sessionId, blocks });
      queueMicrotask(() => {
        const collector = ctx.sessionCollectors.get(sessionId);
        if (!collector) return;
        for (const ev of scriptedTurn) collector({ method: "session.event", params: { sessionId, event: ev } });
        collector({ method: "session.status", params: { sessionId, status: "idle" } });
      });
      return "msg-1";
    },
  };
  bots.initBots(ctx);
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  bots.stopAll();
  server?.close();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

const api = (p, init) => fetch(`${base}${p}`, init);
const postJson = (p, body, method = "POST") =>
  api(p, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const patchJson = (p, body) => postJson(p, body, "PATCH");

const assistantText = (text) => ({ type: "assistant/message", data: { message: { content: [{ type: "text", text }] } } });

// A minimal legal manifest carrying one skill and (optionally) bots.
const manifestWith = (botsSection) => ({
  name: "前台套件",
  description: "带 bot 单元的包",
  skills: [
    { name: "desk-greeting", description: "前台问候流程", content: "# 前台问候\n先确认来意，再按流程作答，不知道就说不知道。" },
  ],
  mcpServers: [],
  agents: [],
  ...(botsSection ? { bots: botsSection } : {}),
});

// ── Requirement 1: bots 段是 pack 第三内容原语 ────────────────────────────────

test("legal bots section passes validation (mount references a pack skill)", () => {
  const errors = validatePackManifest(
    manifestWith([
      { id: "desk-greeter", name: "前台应答", generic: "channel", description: "在前台通道应答来客", skill: "desk-greeting" },
    ]),
  );
  assert.deepEqual(errors, []);
});

test("a skill mount referencing a skill outside the pack is rejected naming the bot id and the missing skill", () => {
  const errors = validatePackManifest(
    manifestWith([{ id: "desk-greeter", name: "前台应答", generic: "channel", description: "d", skill: "not-in-pack" }]),
  );
  assert.equal(errors.length, 1);
  assert.match(errors[0].error, /desk-greeter/);
  assert.match(errors[0].error, /not-in-pack/);
  assert.equal(errors[0].entry, "bots[0]");
});

test("credential/endpoint-shaped keys on a bots entry are rejected listing every forbidden key", () => {
  for (const key of ["token", "secret", "apiKey", "apiKeyEnv", "endpoint", "url", "baseUrl", "credentials", "auth", "command", "args", "env"]) {
    const errors = validatePackManifest(
      manifestWith([{ id: "b1", name: "n", generic: "channel", description: "d", [key]: "x" }]),
    );
    assert.equal(errors.length, 1, `key ${key} must be rejected on its own`);
    assert.match(errors[0].error, new RegExp(`\\b${key}\\b`));
  }
});

test("unknown keys, bad ids, the reserved user. namespace, and duplicate ids are rejected", () => {
  const unknown = validatePackManifest(
    manifestWith([{ id: "b1", name: "n", generic: "channel", description: "d", persona: "x" }]),
  );
  assert.match(unknown[0].error, /unknown key 'persona'/);

  const badId = validatePackManifest(manifestWith([{ id: "bad id!", name: "n", generic: "channel", description: "d" }]));
  assert.match(badId[0].error, /bot id must match/);

  const reserved = validatePackManifest(manifestWith([{ id: "user.bot", name: "n", generic: "channel", description: "d" }]));
  assert.match(reserved[0].error, /reserved "user\." namespace/);

  const dup = validatePackManifest(
    manifestWith([
      { id: "b1", name: "n", generic: "channel", description: "d" },
      { id: "b1", name: "n2", generic: "channel", description: "d" },
    ]),
  );
  assert.match(dup[0].error, /duplicate bot id 'b1'/);
});

test("PACK_MAX_BOTS caps the section and is read at validation time (env, no restart)", () => {
  const four = [1, 2, 3, 4].map((n) => ({ id: `b${n}`, name: "n", generic: "channel", description: "d" }));
  // The default ceiling is 3 (design D2): two pass…
  assert.deepEqual(
    validatePackManifest(manifestWith([four[0], four[1]])),
    [],
    "two bots sit inside the default ceiling of 3",
  );
  // …but a tightened env ceiling rejects them — read per call, like
  // PACK_MAX_SKILLS (no restart).
  process.env.PACK_MAX_BOTS = "1";
  try {
    const errors = validatePackManifest(manifestWith([four[0], four[1]]));
    assert.match(errors[0].error, /at most 1 entries/);
    // A garbage override must never silently disable the ceiling: a
    // non-integer falls back to the default, which four bots still exceed.
    process.env.PACK_MAX_BOTS = "zero";
    assert.match(validatePackManifest(manifestWith(four))[0].error, /at most 3 entries/);
  } finally {
    delete process.env.PACK_MAX_BOTS;
  }
});

// ── Requirement 2: 通用 bot 类型面 ────────────────────────────────────────────

test("the generic type registry is v1=[channel] with the documented semantics", () => {
  assert.deepEqual(GENERIC_BOT_TYPE_NAMES, ["channel"]);
  const channel = GENERIC_BOT_TYPES[0];
  assert.equal(channel.supportsSkillMount, true);
  assert.ok(channel.description.includes("出站投递"), "the type's description documents outbound delivery");
  assert.ok(channel.description.includes("入站"), "…and the inbound event-source role");
});

test("an unknown generic type is rejected naming the type and the registry set", () => {
  const errors = validatePackManifest(
    manifestWith([{ id: "b1", name: "n", generic: "scheduler-x", description: "d" }]),
  );
  assert.equal(errors.length, 1);
  assert.match(errors[0].error, /'scheduler-x'/);
  assert.match(errors[0].error, /not in the generic bot type set/);
});

test("the read-only list endpoint serves the same registry objects the validator checks against", async () => {
  const res = await api("/api/bots/generic-types");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.genericTypes, GENERIC_BOT_TYPES);
  // The install/catalog face (/api/bots) carries the same source.
  const list = await (await api("/api/bots")).json();
  assert.deepEqual(list.genericTypes, GENERIC_BOT_TYPES);
});

// ── Requirement 3: 安装物化与冲突策略 ────────────────────────────────────────

test("installing a pack materializes its bots as disabled, awaiting-connection rows (装包出 bot)", async () => {
  const { report, installed } = await packStore.installPack({
    packId: "pack-greeter",
    version: 1,
    manifest: manifestWith([
      { id: "desk-greeter", name: "前台应答", generic: "channel", description: "d", skill: "desk-greeting" },
    ]),
    user: null,
    hooks: {},
  });

  // Report: installed + awaiting the operator's channel credentials — and the
  // pack itself did NOT fail.
  assert.equal(report.skills[0].status, "installed");
  assert.equal(report.bots.length, 1);
  assert.equal(report.bots[0].id, "desk-greeter");
  assert.equal(report.bots[0].status, "installed");
  assert.equal(report.bots[0].awaitingCredential, true);

  // The row: in the real bot storage (the bots face lists it), born disabled,
  // typed as the GENERIC type (platform binding comes from the operator).
  const row = db.getBot("desk-greeter");
  assert.ok(row, "the bot materialized into the cell's bot storage");
  assert.equal(row.enabled, false, "born disabled — enabling is the operator's explicit action");
  assert.equal(row.type, "channel");
  assert.equal(row.credentials._pack.packId, "pack-greeter");
  assert.equal(row.credentials._pack.skill, "desk-greeting");

  // The stored snapshot's report keeps the bots array for the detail face.
  assert.equal(installed.report.bots.length, 1);

  // No runtime entry exists while unbound: nothing is reachable.
  assert.equal(bots.getEntry("desk-greeter"), null);

  // The bots face masks the pack bookkeeping key out of the browser shape.
  const list = await (await api("/api/bots")).json();
  const masked = list.bots.find((b) => b.id === "desk-greeter");
  assert.ok(masked, "the pack bot appears in the catalog bot face");
  assert.equal(masked.enabled, false);
  assert.equal(masked.awaitingConnection, true);
  assert.deepEqual(masked.configuredCredentials, [], "no channel credentials are configured");
  assert.equal(masked.pack.packId, "pack-greeter");
  assert.ok(!JSON.stringify(masked).includes('"_pack"'));
});

test("installing a pack never widens the webhook surface: the born bot's webhook refuses (403)", async () => {
  const secret = db.getBot("desk-greeter").secret;
  const res = await postJson(`/api/bots/webhook/desk-greeter/${secret}`, { update_id: 1 });
  assert.equal(res.status, 403);
  // …and a wrong secret behaves identically (nothing leaks about bot ids).
  assert.equal((await postJson(`/api/bots/webhook/desk-greeter/wrong`, {})).status, 403);
});

test("a bot id owned by another installed pack skips with the owner named; the rest installs (id 冲突跳过)", async () => {
  const { report } = await packStore.installPack({
    packId: "pack-rival",
    version: 1,
    manifest: {
      name: "竞争包",
      description: "同名 bot",
      skills: [{ name: "rival-skill", description: "d", content: "# c" }],
      mcpServers: [],
      agents: [],
      bots: [{ id: "desk-greeter", name: "同名 bot", generic: "channel", description: "d" }],
    },
    user: null,
    hooks: {},
  });
  assert.equal(report.skills[0].status, "installed", "the rest of the pack installs");
  assert.equal(report.bots[0].status, "skipped");
  assert.match(report.bots[0].reason, /installed pack "前台套件"/);
  // The first pack's row is untouched (still the owner's mount).
  assert.equal(db.getBot("desk-greeter").credentials._pack.packId, "pack-greeter");
});

test("a bot id held by a local (operator-created) bot skips naming the local bot", async () => {
  db.addBot({
    id: "local-desk",
    type: "telegram",
    name: "运营者自建",
    credentials: { token: "LOCAL-TOKEN" },
    secret: "local-secret",
    enabled: false,
  });
  const { report } = await packStore.installPack({
    packId: "pack-local-clash",
    version: 1,
    manifest: {
      name: "撞本地包",
      description: "d",
      skills: [{ name: "clash-skill", description: "d", content: "# c" }],
      mcpServers: [],
      agents: [],
      bots: [{ id: "local-desk", name: "撞名", generic: "channel", description: "d" }],
    },
    user: null,
    hooks: {},
  });
  assert.equal(report.bots[0].status, "skipped");
  assert.match(report.bots[0].reason, /local bot "运营者自建"/);
  // The local row keeps its own type/credentials — never overwritten.
  const row = db.getBot("local-desk");
  assert.equal(row.type, "telegram");
  assert.equal(row.credentials.token, "LOCAL-TOKEN");
  assert.equal(row.credentials._pack, undefined);
});

test("upgrade replaces the pack's own bot while keeping the operator's channel credentials, secret, and enabled state", async () => {
  // Operator configures the channel on the v1 bot (platform binding + token),
  // then enables it — both through the real admin route.
  const bound = await patchJson("/api/bots/desk-greeter", { credentials: { platform: "telegram", token: "OPERATOR-TOKEN" } });
  assert.equal(bound.status, 200);
  const enabled = await patchJson("/api/bots/desk-greeter", { enabled: true });
  assert.equal(enabled.status, 200);
  const v1Row = db.getBot("desk-greeter");
  assert.equal(v1Row.enabled, true);

  // The pack upgrades: new display name, mount dropped.
  const { report } = await packStore.installPack({
    packId: "pack-greeter",
    version: 2,
    manifest: manifestWith([{ id: "desk-greeter", name: "前台应答 v2", generic: "channel", description: "d2" }]),
    user: null,
    hooks: {},
  });
  assert.equal(report.bots[0].status, "replaced");
  assert.equal(report.bots[0].awaitingCredential, false, "the operator's binding survives the upgrade");
  const row = db.getBot("desk-greeter");
  assert.equal(row.name, "前台应答 v2");
  assert.equal(row.credentials._pack.packId, "pack-greeter");
  assert.equal(row.credentials._pack.skill, null);
  assert.equal(row.credentials.platform, "telegram");
  assert.equal(row.credentials.token, "OPERATOR-TOKEN");
  assert.equal(row.enabled, true, "an upgrade never resets the operator's explicit enable");
  assert.equal(row.secret, v1Row.secret, "the webhook path secret is stable across upgrades");
});

test("enabling a channel bot without a platform binding is refused; configuring credentials validates the binding", async () => {
  await packStore.installPack({
    packId: "pack-await",
    version: 1,
    manifest: manifestWith([{ id: "await-bot", name: "待连接", generic: "channel", description: "d" }]),
    user: null,
    hooks: {},
  });
  // Enable without a binding: refused — the operator must wire a platform first.
  const refused = await patchJson("/api/bots/await-bot", { enabled: true });
  assert.equal(refused.status, 400);
  assert.match((await refused.json()).error, /platform binding/);
  // A partial binding (platform but missing its required token) is refused too.
  const partial = await patchJson("/api/bots/await-bot", { credentials: { platform: "telegram" } });
  assert.equal(partial.status, 400);
  assert.match((await partial.json()).error, /Missing credentials: token/);
  // A complete binding validates and flips the awaiting flag.
  const ok = await patchJson("/api/bots/await-bot", { credentials: { platform: "telegram", token: "T2" } });
  assert.equal(ok.status, 200);
  const masked = await ok.json();
  assert.equal(masked.awaitingConnection, false);
});

// ── Requirement 3 (uninstall) + credential ledger ────────────────────────────

test("uninstall removes pack-owned bot rows only, keeping the operator's channel credentials for reuse (卸载边界)", async () => {
  const preview = packStore.uninstallPreview("pack-greeter");
  assert.deepEqual(preview.bots.map((b) => b.id), ["desk-greeter"]);
  assert.deepEqual(preview.botsCredentialsKept, ["desk-greeter"], "the operator's configured credentials are reported as kept");

  const result = packStore.uninstallPack({ packId: "pack-greeter", hooks: {} });
  assert.deepEqual(result.removedBots, ["desk-greeter"]);
  assert.deepEqual(result.botsCredentialsKept, ["desk-greeter"]);
  assert.equal(db.getBot("desk-greeter"), null, "the pack-owned bot row is deleted");
  assert.equal(db.getBot("local-desk").type, "telegram", "a local bot is never touched");
  assert.equal(db.getBot("await-bot").credentials._pack.packId, "pack-await", "another pack's bot is never touched");

  // The operator's channel credentials survived the deletion — in the detach
  // ledger, ready for the next bot of this id.
  const ledger = readLedger();
  assert.deepEqual(ledger["desk-greeter"], { platform: "telegram", token: "OPERATOR-TOKEN" });

  // While a rival pack's CLAIM on the id stays installed, a reinstall skips
  // (the agentOwner mirror: another installed pack declaring the id occupies
  // it even though its own install skipped materializing).
  const claimed = await packStore.installPack({
    packId: "pack-greeter",
    version: 3,
    manifest: manifestWith([
      { id: "desk-greeter", name: "前台应答", generic: "channel", description: "d", skill: "desk-greeting" },
    ]),
    user: null,
    hooks: {},
  });
  assert.equal(claimed.report.bots[0].status, "skipped");
  assert.match(claimed.report.bots[0].reason, /installed pack "竞争包"/);
  assert.equal(db.getBot("desk-greeter"), null, "nothing materialized under a rival claim");

  // With the rival gone, reinstall reattaches the kept credentials: still
  // born disabled (never auto-enabled), but no longer awaiting credentials.
  packStore.uninstallPack({ packId: "pack-rival", hooks: {} });
  const { report } = await packStore.installPack({
    packId: "pack-greeter",
    version: 4,
    manifest: manifestWith([
      { id: "desk-greeter", name: "前台应答", generic: "channel", description: "d", skill: "desk-greeting" },
    ]),
    user: null,
    hooks: {},
  });
  assert.equal(report.bots[0].status, "installed");
  assert.equal(report.bots[0].awaitingCredential, false);
  assert.match(report.bots[0].reason, /restored/);
  const row = db.getBot("desk-greeter");
  assert.equal(row.enabled, false, "restored credentials never auto-enable the bot");
  assert.equal(row.credentials.platform, "telegram");
  assert.equal(row.credentials.token, "OPERATOR-TOKEN");
  assert.equal(row.credentials._pack.skill, "desk-greeting");
  assert.deepEqual(readLedger(), {}, "the ledger entry is consumed by the row");
});

// ── Requirement: channel 类型实现 — mounted skill injected into the session ──
//
// Unit-tested to the "mounted skill enters the turn's session context" layer
// (the design's injection point); the full LLM turn is the runtime's, covered
// by the fast e2e in task 2.4.

test("an inbound message on a skill-mounted channel bot is answered through the skill's session context", async () => {
  // The reinstalled desk-greeter carries the mount + restored telegram
  // binding. Enable it and stub the adapter's send (the platform call is not
  // under test).
  await patchJson("/api/bots/desk-greeter", { enabled: true });
  const entry = bots.getEntry("desk-greeter");
  assert.ok(entry, "with a complete binding the runtime entry exists");
  sent.length = 0;
  scriptedTurn = [assistantText("您好，请问有什么可以帮您？")];
  entry.adapter = { ...entry.adapter, sendText: async (_cred, chatKey, text) => { sent.push({ chatKey, text }); } };

  await bots.handleMessage("desk-greeter", { chatKey: "chat-9", senderName: "来客", text: "你好" });
  await new Promise((r) => setTimeout(r, 30));

  // The reply rode the existing adapter delivery path.
  assert.deepEqual(sent, [{ chatKey: "chat-9", text: "您好，请问有什么可以帮您？" }]);

  // The turn ran on the bot's own session; the block order is identity →
  // mounted skill → user text (harden-bot-reply-lane D2: the identity block
  // always leads, so a bot never speaks as the cell's default persona).
  const turn = ctx.dshBridge.prompts.at(-1);
  assert.equal(turn.sessionId, bots.sessionIdFor("desk-greeter", "chat-9"));
  assert.equal(turn.blocks.length, 3);
  assert.match(turn.blocks[0].text, /你是「前台应答」/, "the identity block leads");
  assert.match(turn.blocks[1].text, /desk-greeting/);
  assert.match(turn.blocks[1].text, /先确认来意/);
  assert.match(turn.blocks[2].text, /你好$/);
  assert.match(turn.blocks[2].text, /Do not call any tools/, "the answer-only posture still governs the turn");
});

test("a channel bot without a mount carries exactly the identity block plus the prompt", async () => {
  // await-bot has a complete telegram binding from the earlier test; enable
  // it for a runtime entry.
  await patchJson("/api/bots/await-bot", { enabled: true });
  const live = bots.getEntry("await-bot");
  assert.ok(live);
  const before = ctx.dshBridge.prompts.length;
  sent.length = 0;
  scriptedTurn = [assistantText("plain")];
  live.adapter = { ...live.adapter, sendText: async (_cred, chatKey, text) => { sent.push({ chatKey, text }); } };

  await bots.handleMessage("await-bot", { chatKey: "c1", senderName: "u", text: "hi" });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(ctx.dshBridge.prompts.length, before + 1);
  const turn = ctx.dshBridge.prompts.at(-1);
  assert.equal(turn.blocks.length, 2, "identity block + prompt, no skill block");
  assert.match(turn.blocks[0].text, /你是「/, "an unconfigured bot still gets the neutral identity");
});

test("a mounted skill that has since disappeared degrades to the plain turn", async () => {
  // desk-greeter's mount names desk-greeting; remove the skill row without
  // uninstalling the pack (the degraded-degradation path).
  db.deleteCustomSkill("desk-greeting");
  const before = ctx.dshBridge.prompts.length;
  sent.length = 0;
  scriptedTurn = [assistantText("fallback")];
  await bots.handleMessage("desk-greeter", { chatKey: "chat-9", senderName: "来客", text: "再次你好" });
  await new Promise((r) => setTimeout(r, 30));
  const turn = ctx.dshBridge.prompts.at(-1);
  assert.equal(turn.blocks.length, 2, "the missing mount costs the skill block, not the turn");
  assert.match(turn.blocks[0].text, /你是「/, "the identity block survives a missing mount");
  assert.deepEqual(sent, [{ chatKey: "chat-9", text: "fallback" }]);
  assert.equal(ctx.dshBridge.prompts.length, before + 1);
});
