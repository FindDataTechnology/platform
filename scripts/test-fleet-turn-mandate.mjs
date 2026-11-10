// Unit tests for the turn mandate lane (add-turn-mandate-lane).
//
// Covers the spec pins (agent-turn-mandate):
//   - the default policy IS today's behavior: edge wakes byte-identical,
//     mandate recorded (immutable), disposition rows written, non-edge
//     messages filtered with off_mode
//   - the admission table + shadow modes: observe records would_accept and
//     never wakes; auto admits through a matched rule that names the route;
//     auto without rules stays shadow (auto_missing_rules)
//   - revalidation: same stamp passes; edge-ignored / mode-no-longer-auto /
//     rule-removed / sender-delisted refusals refuse the resume
//   - the disposition ring: bounded, flips oldest, the off switch stops it
//
// Run: node --test scripts/test-fleet-turn-mandate.mjs

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

// This suite pins the ADMISSION/MANDATE layer, which is defined on the
// one-message-one-wake contract — coalescing is a separate layer with its own
// suite (test-event-wake-coalesce.mjs). The off switch keeps these assertions
// meaningful instead of timing-dependent.
process.env.EVENT_WAKE_COALESCE_MS = "0";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "turn-mandate-"));
process.env.CRON_STORAGE_PATH = tmpRoot;
process.env.DB_PATH = path.join(tmpRoot, "app.db");
process.env.PLATFORM_DATA_DIR = tmpRoot;
process.env.DSH_HOME = path.join(tmpRoot, "dsh");
fs.mkdirSync(process.env.DSH_HOME, { recursive: true });

const chatHistory = await import("../chat-history.js");
const cron = await import("../cron.js");
const { initDb } = await import("../db.js");
const engine = await import("../task-engine.js");
const { createFleetDatabase, setFleetDatabase } = await import("../server/routes/fleets-db.js");
const { triggerFleetEventWake } = await import("../server/fleet-event-wake.js");
const {
  readSignalPolicy,
  admitTrigger,
  buildMandate,
  revalidateMandate,
  policyVersionOf,
  defaultSignalPolicy,
  recordDisposition,
  resetDispositionCacheForTests,
  flushDispositionsForTests,
} = await import("../server/fleet-turn-mandate.js");

await initDb();
await chatHistory.initChatHistory();
await engine.initTaskEngine({
  broadcast: () => {},
  runTurn: async () => ({ ok: true, text: "ok" }),
  isBusy: () => false,
});

test.after(async () => {
  cron.shutdown?.();
  await engine.idle?.();
  await new Promise((r) => setTimeout(r, 250));
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

const POLICY_FILE = () => path.join(tmpRoot, "signal-sources.json");
const DISPOSITION_FILE = () => path.join(tmpRoot, "signal-dispositions.json");

function writePolicy(botId, entry) {
  let all = {};
  try {
    all = JSON.parse(fs.readFileSync(POLICY_FILE(), "utf8"));
  } catch { /* fresh */ }
  all[botId] = entry;
  fs.writeFileSync(POLICY_FILE(), JSON.stringify(all), "utf8");
}

function readDispositions(botId) {
  flushDispositionsForTests();
  try {
    return JSON.parse(fs.readFileSync(DISPOSITION_FILE(), "utf8"))[botId] ?? [];
  } catch {
    return [];
  }
}

let fleetDb;
beforeEach(() => {
  resetDispositionCacheForTests();
  try {
    fs.rmSync(POLICY_FILE(), { force: true });
    fs.rmSync(DISPOSITION_FILE(), { force: true });
  } catch { /* fresh */ }
  fleetDb = createFleetDatabase({
    file: path.join(tmpRoot, `fleets-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.db`),
  });
  setFleetDatabase(fleetDb);
});

const deps = { engine, roster: (id) => `roster:${id}` };
const wake = (botId, meta) => triggerFleetEventWake({ db: fleetDb, ...deps }, botId, meta);

function makeFleet(id, botId = null) {
  const fleet = fleetDb.createFleet({ id, name: `舰${id}`, ownerEmail: "owner@test" });
  fleetDb.createMember({ id: `${id}_m`, fleetId: id, title: "岗", targetKind: "persona", targetId: `p-${id}`, kpiSlots: [], cadence: null });
  if (botId) {
    fleetDb.updateFleet(id, { orchestration: { edges: [{ kind: "event", from: `bot:${botId}`, to: `${id}_m` }] } });
  }
  return fleet;
}

// ── Default policy = today's behavior ────────────────────────────────────────

test("default policy: edge wake byte-identical, mandate recorded, dispositions written", () => {
  makeFleet("f_def", "helper");
  const created = wake("helper", { chatKey: "tg:1", senderName: "张三", text: "订单在哪" });
  assert.equal(created.length, 1);
  const task = engine.getTaskRecord(created[0].taskId);
  // Behavior unchanged: the prompt envelope and both origin segments.
  assert.ok(task.prompt.startsWith("【事件唤醒】外部信号源 bot:helper 收到来自「张三」的消息(聊天 tg:1):\n订单在哪"));
  assert.deepEqual(task.origin.fleet, { fleetId: "f_def", memberId: "f_def_m", depth: 0 });
  assert.deepEqual(task.origin.event, { botId: "helper", chatKey: "tg:1" });
  // The NEW record: an immutable mandate.
  const mandate = task.origin.mandate;
  assert.equal(mandate.strength, "explicit");
  assert.equal(mandate.via, "edge");
  assert.equal(mandate.policyVersion, policyVersionOf(defaultSignalPolicy()));
  assert.equal(mandate.trigger.botId, "helper");
  assert.equal(mandate.trigger.sender, "张三");
  // ESM 本身即严格模式（noRedundantUseStrict）——无指令直接赋值，冻结对象
  // 在严格模式下抛 TypeError，这正是被钉的行为。
  assert.throws(() => {
    mandate.strength = "inferred";
  }, TypeError, "the mandate is frozen");

  // The dispositions: the wake admitted, and (a second call with no edge
  // change would hit the same edge, so check the no-edge case via another bot).
  const rows = readDispositions("helper");
  assert.ok(rows.some((r) => r.fate === "admitted" && r.reason === "edge_hit" && r.taskId === created[0].taskId));

  const other = wake("stranger", { chatKey: "tg:1", senderName: "李四", text: "hi" });
  assert.deepEqual(other, [], "no edge, no wake — unchanged");
  const strangerRows = readDispositions("stranger");
  assert.ok(strangerRows.some((r) => r.fate === "filtered" && r.reason === "off_mode"), "the honest nothing row");
});

// ── The gate, at unit level ──────────────────────────────────────────────────

test("gate: off evaluates only the edge; observe shadows everything new", () => {
  const base = defaultSignalPolicy();
  // off: non-edge is never evaluated.
  assert.equal(admitTrigger({ policy: base, edgeHit: false, senderName: "张三" }).reason, "off_mode");
  // off: the edge stays the owner-declared explicit lane.
  const edge = admitTrigger({ policy: base, edgeHit: true, senderName: "张三" });
  assert.equal(edge.admitted, true);
  assert.equal(edge.strength, "explicit");

  // observe: a listed sender addressing the bot (a new explicit surface)
  // needs a rule; with one it is shadow-recorded, never admitted.
  const obs = { ...base, mode: "observe", allowed: ["张三"], rules: [{ id: "r1", target: "m", keywords: ["退款"] }] };
  assert.equal(admitTrigger({ policy: obs, edgeHit: false, senderName: "张三", addressed: true, text: "我要退款" }).wouldAccept, true);
  assert.equal(admitTrigger({ policy: obs, edgeHit: false, senderName: "张三", addressed: true, text: "我要退款" }).admitted, false);
  // observe: no rule match → filtered, honest code.
  assert.equal(admitTrigger({ policy: obs, edgeHit: false, senderName: "张三", addressed: false, text: "随便聊聊" }).reason, "no_rule_match");
});

test("gate: auto admits through a matched rule; listed bots stay inferred", () => {
  const auto = { ...defaultSignalPolicy(), mode: "auto", allowed: ["张三"], bots: ["depbot"], rules: [{ id: "r1", target: "m1", keywords: ["故障"] }] };
  // auto, no rules → the honest miss.
  const noRules = { ...auto, rules: [] };
  assert.equal(admitTrigger({ policy: noRules, edgeHit: false, senderName: "张三" }).reason, "auto_missing_rules");
  // auto + rule: a listed unaddressed message is an inferred admission.
  const g1 = admitTrigger({ policy: auto, edgeHit: false, senderName: "张三", text: "线上故障了" });
  assert.equal(g1.admitted, true);
  assert.equal(g1.strength, "inferred");
  assert.equal(g1.ruleId, "r1");
  // a listed bot's candidate can never rise past inferred.
  const g2 = admitTrigger({ policy: auto, edgeHit: false, senderName: "depbot", isBot: true, text: "故障告警" });
  assert.equal(g2.admitted, true);
  assert.equal(g2.strength, "inferred");
  // an unlisted bot is not admitted at all.
  assert.equal(admitTrigger({ policy: auto, edgeHit: false, senderName: "roguebot", isBot: true, text: "故障" }).reason, "bot_not_listed");
});

// ── observe / auto end-to-end through the wake seam ──────────────────────────

test("observe: would_accept recorded, no task created", () => {
  makeFleet("f_obs"); // no edge: the shadow lane assesses the NON-edge surface
  writePolicy("ob", { mode: "observe", allowed: ["张三"], rules: [{ id: "r1", target: "f_obs_m", keywords: ["退款"] }] });
  const created = wake("ob", { chatKey: "c", senderName: "张三", text: "请处理退款", addressed: true });
  assert.deepEqual(created, [], "observe never wakes");
  const rows = readDispositions("ob");
  const row = rows.find((r) => r.fate === "would_accept");
  assert.ok(row, "the shadow acceptance is on the books");
  assert.equal(row.ruleId, "r1");
});

test("auto: a matched rule wakes the rule's target post with an admission mandate", () => {
  makeFleet("f_auto"); // no edge: routing is the rule target, not an edge
  writePolicy("au", { mode: "auto", allowed: ["张三"], rules: [{ id: "r1", target: "f_auto_m", keywords: ["故障"] }] });
  const created = wake("au", { chatKey: "c", senderName: "张三", text: "线上故障，处理一下" });
  assert.equal(created.length, 1, "the rule routed the wake");
  const task = engine.getTaskRecord(created[0].taskId);
  assert.equal(task.origin.event.rule, "r1");
  assert.equal(task.origin.mandate.via, "admission");
  assert.equal(task.origin.mandate.strength, "inferred");
  assert.equal(task.origin.mandate.ruleId, "r1");
  const rows = readDispositions("au");
  assert.ok(rows.some((r) => r.fate === "admitted" && r.reason === "rule_match" && r.ruleId === "r1"));

  // An unresolved rule target is an honest filtered row, never a wake.
  writePolicy("au", { mode: "auto", allowed: ["张三"], rules: [{ id: "r2", target: "ghost_member", keywords: ["故障"] }] });
  const ghost = wake("au", { chatKey: "c", senderName: "张三", text: "故障" });
  assert.deepEqual(ghost, []);
  assert.ok(readDispositions("au").some((r) => r.fate === "filtered" && r.reason === "rule_target_unresolved"));
});

// ── Revalidation ─────────────────────────────────────────────────────────────

test("revalidation: same stamp passes; drifts refuse by named basis", () => {
  const policy = defaultSignalPolicy();
  const mandate = buildMandate({ strength: "explicit", via: "edge", row: "edge", policy, botId: "b", chatKey: "c", senderName: "张三" });
  assert.deepEqual(revalidateMandate(mandate, policy), { ok: true, stampChanged: false });

  // Edge drift: the edge cell switched off → refuse.
  const edgeOff = { ...policy, admission: { ...policy.admission, edge: "ignore" } };
  assert.equal(revalidateMandate(mandate, edgeOff).ok, false);
  assert.equal(revalidateMandate(mandate, edgeOff).reason, "edge_now_ignored");
  // A benign policy change (e.g. a new name on the list) notifies, not revokes.
  const widened = { ...policy, allowed: ["李四"] };
  const v = revalidateMandate(mandate, widened);
  assert.equal(v.ok, true);
  assert.equal(v.stampChanged, true);

  // Inferred admission mandate: mode no longer auto → refuse.
  const inferred = buildMandate({ strength: "inferred", via: "admission", row: "listed_unaddressed", cell: "inferred", ruleId: "r1", policy: { ...policy, mode: "auto", rules: [{ id: "r1", target: "m" }] }, botId: "b", chatKey: "c", senderName: "张三" });
  assert.equal(revalidateMandate(inferred, policy).reason, "mode_no_longer_auto");
  // The matched rule removed → refuse.
  assert.equal(revalidateMandate(inferred, { ...policy, mode: "auto", rules: [{ id: "r9", target: "m" }] }).reason, "rule_no_longer_present");

  // A listed sender's explicit mandate: delisting revokes.
  const listed = buildMandate({ strength: "explicit", via: "admission", row: "listed_unaddressed", cell: "explicit", ruleId: "r1", policy: { ...policy, mode: "auto", allowed: ["张三"], rules: [{ id: "r1", target: "m" }] }, botId: "b", chatKey: "c", senderName: "张三" });
  assert.equal(revalidateMandate(listed, { ...policy, mode: "auto", allowed: [], rules: [{ id: "r1", target: "m" }] }).reason, "sender_no_longer_listed");

  // A malformed (legacy) mandate fails open.
  assert.deepEqual(revalidateMandate({}, policy), { ok: true, stampChanged: false });
});

test("revalidation refuses the resume and records the disposition", async () => {
  makeFleet("f_rev"); // no edge: the auto admission comes from the rule
  writePolicy("rv", { mode: "auto", allowed: ["张三"], rules: [{ id: "r1", target: "f_rev_m", keywords: ["故障"] }] });
  const created = wake("rv", { chatKey: "c", senderName: "张三", text: "故障了" });
  assert.equal(created.length, 1);
  const taskId = created[0].taskId;

  // The policy tightens: auto → off, rule gone. A re-execution must refuse.
  writePolicy("rv", { mode: "off" });
  const { revalidateMandate: _rm, readSignalPolicy: _rp, recordDisposition: _rd, resetDispositionCacheForTests: _rs, ...engineOnly } = await import("../task-engine.js");
  // Wire the same gate server.js wires (the test drives the engine seam).
  engine.setMandateGate((task) => {
    const policy = readSignalPolicy(task.origin?.event?.botId);
    const verdict = revalidateMandate(task.origin?.mandate, policy);
    if (!verdict.ok) {
      recordDisposition(task.origin.event.botId, { fate: "filtered", reason: `revalidate_${verdict.reason}`, taskId: task.id });
    }
    return verdict;
  });
  const r = engine.runTaskNow(taskId);
  assert.equal(r.ok, false);
  assert.match(r.error, /^mandate revoked: mode_no_longer_auto$/);
  assert.equal(r.mandateRevoked, true);
  assert.ok(readDispositions("rv").some((row) => row.fate === "filtered" && row.reason === "revalidate_mode_no_longer_auto"));
  engine.setMandateGate(null);
  void engineOnly;
});

test("cap refusal: the disposition row and the honest O1 row frame the same refusal", () => {
  makeFleet("f_cap", "capbot");
  const prev = process.env.FLEET_EVENT_WAKE_HOURLY_CAP;
  process.env.FLEET_EVENT_WAKE_HOURLY_CAP = "1";
  try {
    assert.equal(wake("capbot", { chatKey: "c", senderName: "张三", text: "第一条" }).length, 1);
    assert.equal(wake("capbot", { chatKey: "c", senderName: "张三", text: "第二条" }).length, 0, "over the cap: no task");
    const rows = readDispositions("capbot");
    assert.ok(rows.some((r) => r.fate === "cap_refused" && r.reason === "hourly_cap"), "the unified account records the refusal");
    assert.ok(rows.some((r) => r.fate === "admitted" && r.taskId), "and the admitted row before it");
  } finally {
    if (prev === undefined) delete process.env.FLEET_EVENT_WAKE_HOURLY_CAP;
    else process.env.FLEET_EVENT_WAKE_HOURLY_CAP = prev;
  }
});

// ── The disposition ring ─────────────────────────────────────────────────────

test("disposition ring: bounded, flips oldest; the off switch stops writes", () => {
  const prev = process.env.FLEET_SIGNAL_DISPOSITION_RING;
  process.env.FLEET_SIGNAL_DISPOSITION_RING = "5";
  try {
    for (let i = 0; i < 8; i++) recordDisposition("ring", { fate: "filtered", reason: `r${i}` });
    const rows = readDispositions("ring");
    assert.equal(rows.length, 5, "bounded");
    assert.deepEqual(rows.map((r) => r.reason), ["r3", "r4", "r5", "r6", "r7"], "oldest flipped");
  } finally {
    if (prev === undefined) delete process.env.FLEET_SIGNAL_DISPOSITION_RING;
    else process.env.FLEET_SIGNAL_DISPOSITION_RING = prev;
  }

  const prevOff = process.env.FLEET_SIGNAL_DISPOSITION;
  process.env.FLEET_SIGNAL_DISPOSITION = "off";
  try {
    recordDisposition("ring", { fate: "filtered", reason: "never" });
    assert.ok(!readDispositions("ring").some((r) => r.reason === "never"), "the switch stops all writes");
  } finally {
    if (prevOff === undefined) delete process.env.FLEET_SIGNAL_DISPOSITION;
    else process.env.FLEET_SIGNAL_DISPOSITION = prevOff;
  }
});
