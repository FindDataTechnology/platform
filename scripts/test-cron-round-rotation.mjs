// Unit tests — fleet round rotation (fix-fleet-round-discipline).
//
// Pins the seam contracts the spec deltas define:
//   - cron-module ADDED (D4/D5/D7): fleet member rounds prompt the dsh child
//     under a per-round rotated conversation id (`cron-<id>#r<startedAt>`)
//     while the mirror keeps the stable `cron-<id>` session; the round's
//     child conversation is disposed best-effort at settle; non-fleet jobs
//     keep the byte-for-byte pre-change shape; cluster fan-outs propagate
//     sourceTag/startedAt so members rotate under the same rule.
//   - agent-fleet-core swap clause (D6): even with a runtime that REJECTS
//     session/delete, a freshSession swap guarantees the next round runs on
//     a brand-new child conversation (never replays pre-swap state), and the
//     mirror session is cleared then rebuilt by the next round.
//
// Run: node --test scripts/test-cron-round-rotation.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cron-round-rotation-"));
process.env.CRON_STORAGE_PATH = tmpRoot;
process.env.DB_PATH = path.join(tmpRoot, "app.db");
process.env.PLATFORM_DATA_DIR = tmpRoot;
process.env.DSH_HOME = path.join(tmpRoot, "dsh");
fs.mkdirSync(process.env.DSH_HOME, { recursive: true });
// Persona preset defs the fake cluster member resolves against (same shape
// test-cluster-tasks.mjs uses).
fs.writeFileSync(
  path.join(process.env.DSH_HOME, ".agent-presets.defs.json"),
  JSON.stringify([{ id: "pack-alpha-analyst", entryId: "pack-alpha-analyst", name: "Alpha Analyst" }]),
);

const chatHistory = await import("../chat-history.js");
const { initDb } = await import("../db.js");
const { attachCronRunner } = await import("../server/cron-runner.js");
const { createClusterDatabase, setClusterDatabase } = await import("../server/routes/clusters-db.js");

await initDb();
await chatHistory.initChatHistory();

const fleetJob = (over = {}) => ({
  id: "job_f1",
  sessionId: "cron-9",
  prompt: "巡逻",
  preset: "persona-a",
  targetType: "persona",
  sessionTitle: "营销舰 · 巡逻岗",
  sourceTag: { fleetId: "fleet-1", memberId: "m-1" },
  ...over,
});

// Stub ctx: prompt records the child conversation id it was prompted with and
// emits one assistant message + idle so the collector persists a mirror row —
// that is what proves the collector key (child id) and the mirror id (stable)
// are decoupled.
function roundCtx({ failChildDelete = false } = {}) {
  const ctx = {
    currentPreset: "persona-a",
    isStreaming: false,
    sessionCollectors: new Map(),
    sessionVersion: 1,
    broadcast: () => {},
    onRuntimeIdle: () => {},
    reserveRuntime: () => () => {},
    // Both jobs below carry `sourceTag.fleetId`, so a round goes through
    // normalizeModelForJob — and a fleet-attributed round with no model plan is
    // now refused before it runs ("post model resolution unavailable …", ledger
    // E28). Without these the round returns ok:false for a reason that has
    // nothing to do with rotation, and the assertions here read it as "the
    // child id did not rotate".
    resolveFleetModel: async (preset) => ({
      memberId: "m-1",
      preset,
      candidates: [{ model: "harness-model" }],
      notices: [],
      explicitChain: false,
    }),
    switchModelTo: async () => ({ ok: true }),
    recordFleetModelNotices: () => {},
    switchPresetTo: async (p) => {
      ctx.currentPreset = p;
      return { ok: true };
    },
    prompts: [], // { sessionId, text } — sessionId is the CHILD conversation id
    childDeletes: [],
    dshBridge: {
      isReady: () => true,
      prompt: async (sessionId, blocks) => {
        ctx.prompts.push({ sessionId, text: blocks[0].text });
        const collector = ctx.sessionCollectors.get(sessionId);
        collector?.({
          method: "session.event",
          params: { event: { type: "assistant/message", data: { message: { content: [{ type: "text", text: `回合输出 ${sessionId}` }] } } } },
        });
        collector?.({ method: "session.status", params: { status: "idle" } });
      },
      deleteSession: async (sessionId) => {
        ctx.childDeletes.push(sessionId);
        if (failChildDelete) return false; // old runtimes: no session/delete RPC
        return true;
      },
    },
  };
  attachCronRunner(ctx);
  return ctx;
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

test("fleet rounds rotate the child conversation id per round; the mirror stays one stable session", async () => {
  const ctx = roundCtx();

  const t1 = await ctx.runCronJobTurn(fleetJob(), { turnTimeoutMs: 2000 });
  assert.equal(t1.ok, true);
  const first = ctx.prompts[0].sessionId;
  assert.ok(first.startsWith("cron-9#r"), `child id rotates: ${first}`);
  assert.notEqual(first, "cron-9", "the child is never prompted under the mirror id");

  await pause(3); // a round takes wall-clock time; the next stamp must differ
  const t2 = await ctx.runCronJobTurn(fleetJob(), { turnTimeoutMs: 2000 });
  assert.equal(t2.ok, true);
  const second = ctx.prompts[1].sessionId;
  assert.ok(second.startsWith("cron-9#r"));
  assert.notEqual(second, first, "round N+1 never resumes round N's child conversation");

  // Mirror: rows accumulate under the stable id (user + assistant), and no
  // rotated id ever becomes a session of its own.
  const mirror = await chatHistory.getSession("cron-9");
  assert.ok(JSON.stringify(mirror).includes(`回合输出 ${first}`), "assistant row mirrored under the stable id");
  assert.ok(JSON.stringify(mirror).includes("巡逻"), "user row mirrored under the stable id");
  const sessions = await chatHistory.listSessions();
  assert.ok(sessions.some((s) => s.id === "cron-9"), "exactly the stable session exists");
  assert.ok(!sessions.some((s) => s.id.includes("#r")), "no per-round session rows leak into the list");
});

test("the round's child conversation is disposed at settle; a rejected delete never blocks the next round", async () => {
  const ctx = roundCtx({ failChildDelete: true }); // old runtime: session/delete unsupported
  await ctx.runCronJobTurn(fleetJob(), { turnTimeoutMs: 2000 });
  assert.equal(ctx.childDeletes.length, 1, "best-effort dispose fired for the rotated id");
  assert.ok(ctx.childDeletes[0].startsWith("cron-9#r"));
  assert.notEqual(ctx.childDeletes[0], "cron-9", "the mirror session is never disposed");

  const t2 = await ctx.runCronJobTurn(fleetJob(), { turnTimeoutMs: 2000 });
  assert.equal(t2.ok, true, "the next round runs fresh regardless of the failed delete");
  assert.notEqual(ctx.prompts[1].sessionId, ctx.prompts[0].sessionId);
});

test("non-fleet jobs keep the byte-for-byte pre-change shape (no rotation, no dispose)", async () => {
  const ctx = roundCtx();
  const plain = fleetJob({ id: "job_p1", sessionId: "cron-8", sourceTag: undefined });

  const out = await ctx.runCronJobTurn(plain, { turnTimeoutMs: 2000 });
  assert.equal(out.ok, true);
  assert.equal(ctx.prompts[0].sessionId, "cron-8", "prompted under the bound session id as before");
  assert.deepEqual(ctx.childDeletes, [], "nothing disposed");
});

test("cluster fan-out propagates sourceTag and startedAt so members rotate under the same rule (D7)", async () => {
  const db = createClusterDatabase({ file: path.join(tmpRoot, `clusters-${Date.now()}.db`) });
  setClusterDatabase(db);
  db.create({
    id: "cluster_rot",
    name: "轮换集群",
    description: "",
    tags: [],
    agents: [{ packId: "packA", agentId: "pack-alpha-analyst", status: "active" }],
    createdAt: Date.now(),
  });

  const personaJobs = [];
  const runPersona = async (_c, job, _timeout, _turns, options) => {
    personaJobs.push({ job, options });
    chatHistory.recordMessage(job.sessionId, "user", job.prompt);
    return { ok: true, text: "成员输出", usage: { input: 1, output: 1 } };
  };
  const ctx = roundCtx();
  // Re-attach with the injected persona executor + a catalog fixture (the
  // default attach already ran; attachCronRunner overwrites ctx.runCronJobTurn).
  attachCronRunner(ctx, {
    runPersona,
    runA2a: async () => ({ ok: true, text: "" }),
    listAgents: () => [{ id: "pack-alpha-analyst", packId: "packA", mode: "chat", name: "Alpha 分析师" }],
  });

  const fleetClusterJob = {
    id: "job_c1",
    prompt: "各自分析",
    preset: "cluster_rot",
    targetType: "cluster",
    sessionId: "cron-c1",
    executionPolicy: {},
    sourceTag: { fleetId: "fleet-1", memberId: "m-c1" },
  };
  const out = await ctx.runCronJobTurn(fleetClusterJob, { turnTimeoutMs: 2000 });
  assert.equal(out.ok, true);
  assert.equal(personaJobs.length, 1);
  assert.equal(personaJobs[0].job.sourceTag?.fleetId, "fleet-1", "sourceTag rides down to the member");
  assert.equal(personaJobs[0].job.sessionId, "cron-c1--pack-alpha-analyst", "member mirror id stays stable");
  assert.equal(typeof personaJobs[0].options?.startedAt, "number", "the round stamp rides down");

  // Non-fleet cluster task: no sourceTag propagation (pre-change shape).
  personaJobs.length = 0;
  await ctx.runCronJobTurn({ ...fleetClusterJob, id: "job_c2", sessionId: "cron-c2", sourceTag: undefined }, { turnTimeoutMs: 2000 });
  assert.equal(personaJobs[0].job.sourceTag, undefined);
});

test("swap freshSession with a session/delete-REJECTING runtime: the next round never replays pre-swap state (D6)", async () => {
  // The chat-history module's own dsh bridge is what chatHistory.deleteSession
  // asks to forget the child-side state — make it reject like an old runtime.
  const realBridge = await import("../chat-history.js");
  realBridge.setDshBridge({ deleteSession: async () => { throw new Error("method not found"); } });

  const ctx = roundCtx();
  const job = fleetJob({ id: "job_s1", sessionId: "cron-swap" });

  await ctx.runCronJobTurn(job, { turnTimeoutMs: 2000 });
  const preSwapChild = ctx.prompts[0].sessionId;

  // The swap route's freshSession branch: clear the dedicated session. The
  // child-side delete is swallowed (logged) — the mirror is the winning
  // delete, and the rotation contract does the rest.
  await chatHistory.deleteSession("cron-swap");
  const cleared = await chatHistory.getSession("cron-swap");
  assert.equal(cleared, null, "freshSession cleared the mirror session");

  await pause(3);
  await ctx.runCronJobTurn(job, { turnTimeoutMs: 2000 });
  const postSwapChild = ctx.prompts[1].sessionId;
  assert.ok(postSwapChild.startsWith("cron-swap#r"), "next round still rotates");
  assert.notEqual(postSwapChild, preSwapChild, "the new incumbent never inherits the old child conversation");
  assert.ok(!postSwapChild.includes(preSwapChild.slice("cron-swap".length + 1)), "different round stamp entirely");

  // The mirror session is rebuilt by the next round's rows.
  const rebuilt = await chatHistory.getSession("cron-swap");
  assert.ok(rebuilt && JSON.stringify(rebuilt).includes("巡逻"), "mirror session rebuilt by the next round");

  realBridge.setDshBridge(null);
});
