// Tests for resume-dsh-session-after-restart (design D1/D5):
//
//   A. the create-vs-resume input: the profile's persistence probe
//      (`sessionPersistence.loadStored`) distinguishes a persisted session id
//      from one this home has never seen.
//   B. after a child restart (the model-switch / crash case), prompting the
//      same session RESUMES its log instead of failing with the id-collision
//      error, and the prompt is actually appended (the conversation grew).
//   C. a log torn by a SIGKILL mid-turn still resumes.
//   D. a never-persisted id still creates a fresh session.
//
// No real model is needed: the turn appends its user message to the log BEFORE
// the LLM call, and every test points the route at a local fake that answers
// 500 after a configurable delay — short (fast failure) except in C, where the
// long delay is what keeps the turn in flight for the kill.
//
// Run: node --test scripts/test-session-resume.mjs

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HarnessClient } from "@deepseek-ai/dsh-sdk-client";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Hermetic dsh home + stores (before dsh-profile.js is imported: it reads
//    DSH_HOME / the store paths at module scope) ─────────────────────────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "paas-resume-"));
process.env.DSH_HOME = path.join(TMP, "dsh-home");
process.env.DSH_SHARED_HOME = process.env.DSH_SHARED_HOME || path.join(os.homedir(), ".dsh");
process.env.LLM_PROVIDERS_STORE = path.join(TMP, "llm-providers.json");
process.env.LLM_DEFAULT_STORE = path.join(TMP, "llm-default.json");
process.env.LLM_API_KEY = "sk-resume-test";

// The fake LLM: 500 after `delayMs`, so a turn fails fast by default and can
// be held in flight when a test needs to kill the child mid-turn.
let delayMs = 150;
const fakeLlm = http.createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    setTimeout(() => {
      if (res.writableEnded || res.socket?.destroyed) return;
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "fake llm is down (test)" } }));
    }, delayMs);
  });
});
await new Promise((r) => fakeLlm.listen(0, "127.0.0.1", r));
const FAKE_LLM_URL = `http://127.0.0.1:${fakeLlm.address().port}/v1`;
// The route the child resolves must be the fake: without this the profile
// would point at the real gateway and the tests would spend real requests.
process.env.LLM_BASE_URL = FAKE_LLM_URL;

const profile = await import("../dsh-profile.js");
profile.ensureDshHome();
const { models } = await profile.writeLlmProfile();
const presetsPatch = await profile.writePresetsPatch();
const permissionsPatch = await profile.writePermissionsPatch();
profile.ensureCredentialsStore();
const PROVIDER = "volces";
const MODEL = models[0].id;
const basePatches = [presetsPatch, permissionsPatch];
const PROFILE_DIR = path.join(process.env.DSH_HOME, "profiles", "platform");

// ── Child lifecycle ────────────────────────────────────────────────────────
function childEnv(extra = {}) {
  return { ...process.env, LLM_API_KEY: undefined, LITELLM_API_KEY: undefined, ...extra };
}

const booted = new Set();

async function boot(extraPatches = [], extraEnv = {}) {
  const client = new HarnessClient({
    command: "dsh",
    args: ["--profile", "platform", ...basePatches.flatMap((p) => ["--patch", p]), ...extraPatches.flatMap((p) => ["--patch", p])],
    cwd: ROOT,
    env: childEnv(extraEnv),
    requestTimeoutMs: 60_000,
  });
  booted.add(client);
  client.start();
  for (let attempt = 0; ; attempt++) {
    try {
      await client.initialize({ cwd: ROOT, provider: PROVIDER, model: MODEL });
      break;
    } catch (e) {
      if (!/no adapter registered for provider/.test(e?.message || "") || attempt >= 10) throw e;
      await sleep(500);
    }
  }
  return client;
}

// Send one prompt and resolve with the turn's outcome. `timedOut` marks a turn
// that never ended (only expected while a test kills the child mid-turn).
function runTurn(client, sessionId, text, timeoutMs = 20_000) {
  return new Promise((resolve) => {
    const events = [];
    let settled = false;
    const sub = client.subscribe();
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      // close() rejects the pending wait with a TransportClosedError, which
      // the consumer below swallows — that rejection IS the loop's exit.
      try { sub.close(); } catch { /* already closed */ }
      resolve(outcome);
    };
    (async () => {
      try {
        for await (const n of sub) {
          const ev = n?.params?.event;
          if (!ev || n?.params?.sessionId !== sessionId) continue;
          events.push(ev);
          if (ev.type === "turn/end") {
            finish({ events, reason: ev.data?.reason, timedOut: false });
            return;
          }
        }
      } catch { /* subscription closed by finish() */ }
    })();
    client.prompt(sessionId, [{ type: "text", text }]).catch((e) => finish({ events, error: e, timedOut: false }));
    setTimeout(() => finish({ events, timedOut: true }), timeoutMs);
  });
}

const errorMessage = (turn) => turn.reason?.error?.message || turn.error?.message || "";

async function promptAndAssertResumed(client, sessionId, text) {
  const turn = await runTurn(client, sessionId, text);
  assert.equal(turn.timedOut, false, "turn never ended");
  const message = errorMessage(turn);
  assert.doesNotMatch(message, /id collision/, `turn hit the id-collision error: ${message}`);
  // Every step past session creation depends on the append having worked; the
  // fake LLM's failure is the expected terminal error here.
  assert.match(message, /fake llm is down|LLM|llm/i, `expected the fake-LLM failure, got: ${message}`);
  return turn;
}

// ── Tests ──────────────────────────────────────────────────────────────────
after(async () => {
  // A test that fails an assertion before its own close() would leak its
  // child; reaping every booted client here keeps the file exits prompt and
  // the suite free of orphaned runtimes.
  for (const client of booted) {
    try { await client.close(); } catch { /* already gone */ }
  }
  // close() alone waits on live keep-alive sockets from the killed children.
  fakeLlm.closeAllConnections();
  fakeLlm.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

if (!(await import("./lib/dsh-available.mjs")).dshRuntimeAvailable()) {
  console.warn("[skip] shared dsh install unavailable — dsh runtime integration skipped (see scripts/lib/dsh-available.mjs)");
  process.exit(0);
}

test("A. the persistence probe separates persisted ids from unseen ones", async () => {
  delayMs = 150;
  const seen = `platform-resume-seen-${Date.now()}`;
  const fresh = `platform-resume-fresh-${Date.now()}`;

  const first = await boot();
  await runTurn(first, seen, "hello");
  await first.close();

  // A standalone probe plugin reports what the service answers inside a
  // freshly booted child — the exact input create-vs-resume keys on.
  const probeOut = path.join(TMP, "probe.json");
  fs.writeFileSync(
    path.join(PROFILE_DIR, "resume-probe.js"),
    `import { writeFileSync } from "node:fs";
const name = "resume-probe";
const inject = ["sessionPersistence"];
function apply(ctx) {
  (async () => {
    const out = {};
    for (const id of String(process.env.PROBE_IDS || "").split(",").filter(Boolean)) {
      try { out[id] = (await ctx.sessionPersistence.loadStored(id)) !== undefined; }
      catch (e) { out[id] = "ERR:" + (e?.message || e); }
    }
    writeFileSync(process.env.PROBE_OUT, JSON.stringify(out));
  })();
}
export { name, inject, apply };
`,
  );
  const probePatch = path.join(PROFILE_DIR, "probe.patch.yml");
  fs.writeFileSync(probePatch, `- insert:\n    - id: resume-probe\n      name: ./resume-probe.js\n`);

  const probe = await boot([probePatch], { PROBE_OUT: probeOut, PROBE_IDS: `${seen},${fresh}` });
  for (let i = 0; i < 60 && !fs.existsSync(probeOut); i++) await sleep(250);
  await probe.close();

  assert.ok(fs.existsSync(probeOut), "probe plugin never reported");
  const report = JSON.parse(fs.readFileSync(probeOut, "utf8"));
  assert.equal(report[seen], true, `persisted session not detected: ${JSON.stringify(report)}`);
  assert.equal(report[fresh], false, `unseen session reported as persisted: ${JSON.stringify(report)}`);
});

test("B. a prompt after a restart resumes the session instead of colliding", async () => {
  delayMs = 150;
  const sessionId = `platform-resume-restart-${Date.now()}`;

  const first = await boot();
  await runTurn(first, sessionId, "first turn");
  await first.close();

  const second = await boot();
  const turn = await promptAndAssertResumed(second, sessionId, "second turn after restart");
  const userMessages = turn.events.filter((e) => e.type === "agent/inbox/spliced");
  assert.ok(userMessages.length >= 1, "the resumed turn never admitted its prompt");
  await second.close();
});

test("C. a log torn by a kill mid-turn still resumes", async () => {
  const sessionId = `platform-resume-torn-${Date.now()}`;
  delayMs = 30_000; // hold the turn open so the kill lands mid-turn

  const first = await boot();
  const pending = runTurn(first, sessionId, "turn that never finishes", 5_000);
  await sleep(3_000); // let the append persist, then kill the child hard
  first.child.kill("SIGKILL");
  await pending;

  delayMs = 150;
  const second = await boot();
  await promptAndAssertResumed(second, sessionId, "turn after the torn tail");
  await second.close();
});

test("D. an unseen session id still creates a fresh session", async () => {
  delayMs = 150;
  const sessionId = `platform-resume-new-${Date.now()}`;

  const first = await boot();
  await runTurn(first, sessionId, "establishing a log");
  await first.close();

  const second = await boot();
  const fresh = `platform-resume-created-${Date.now()}`;
  const turn = await promptAndAssertResumed(second, fresh, "brand new conversation");
  assert.equal(turn.events.filter((e) => e.type === "turn/start").length, 1);
  await second.close();
});
