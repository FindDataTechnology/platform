// Unit tests for the LLM retry resilience layer (add-llm-retry-resilience):
//
//   1. Every generated provider profile carries the bounded transient-error
//      retry policy with the unrecognized-error fallback bucket included —
//      both the env (volces) route and Models-page user routes.
//   2. `llm/retry` / `llm/retry-started` session events forward to viewers
//      as retry_scheduled / retry_started WS events (budget + failure code).
//   3. Retry events reach the trace store (capture happens before the
//      session-routing drop).
//   4. A subagent child's terminal turn/end error is captured en route, and
//      the parent's bare "subagent run failed" tool result is enriched with
//      the real reason (message + code) in the WS event AND the persisted
//      block. Already-diagnostic results, foreign errors, and non-subagent
//      failures pass through untouched.
//
// Run: node --test scripts/test-llm-retry.mjs   (also in npm run test:unit)

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llm-retry-"));
process.env.LLM_PROVIDERS_STORE = path.join(tmpRoot, "llm-providers.json");
process.env.LLM_DEFAULT_STORE = path.join(tmpRoot, "llm-default.json");
process.env.LLM_API_KEY = "sk-retry-unit";
process.env.DB_PATH = path.join(tmpRoot, "unit.db");

const dshProfile = await import("../dsh-profile.js");
const llmProviders = await import("../llm-providers.js");
const { createAppContext } = await import("../server/context.js");
const { attachDshEvents } = await import("../server/dsh-events.js");
const db = await import("../db.js");

const SESSION = "platform-web-1";
const CHILD = "subagent-child-9";

function sessionEvent(type, data, sessionId = SESSION) {
  return { method: "session.event", params: { sessionId, event: { type, seq: 1, time: 1, data } } };
}

let ctx;
let seen;

beforeEach(() => {
  ctx = createAppContext({});
  attachDshEvents(ctx);
  ctx.dshSessionId = SESSION;
  seen = [];
  ctx.broadcast = (m) => seen.push(m);
  ctx.sendToViewers = (sid, m) => seen.push(m);
});

// ── 1. Policy attach ─────────────────────────────────────────────────────────

test("volces profile carries the bounded retry policy with the fallback bucket", async () => {
  const { providers } = await dshProfile.buildLlmProfile({
    llmApiKey: "sk-x",
    llmBaseUrl: "http://127.0.0.1:9/v1",
  });
  const policy = providers.volces?.retryPolicy;
  assert.ok(policy, "volces route lacks retryPolicy");
  assert.equal(policy.mode, "normal");
  assert.equal(policy.maxRetries, 5);
  assert.deepEqual(policy.retryableCodes, [
    "EMPTY_RESPONSE",
    "RATE_LIMIT",
    "SERVER",
    "TIMEOUT",
    "TRANSPORT",
    "PI_AI_ERROR",
  ]);
  assert.equal(policy.backoff.initialDelayMs, 1000);
  assert.equal(policy.backoff.maxDelayMs, 15000);
  assert.equal(policy.backoff.jitterRatio, 0.2);
});

test("user-added routes carry the same policy", async () => {
  // Seed one user provider into the temp store, then build entries.
  fs.mkdirSync(path.dirname(process.env.LLM_PROVIDERS_STORE), { recursive: true });
  const doc = {
    version: 1,
    providers: [
      { id: "gw1", name: "GW1", baseUrl: "http://127.0.0.1:6001/v1", models: [{ id: "m1", name: "M1" }] },
    ],
  };
  fs.writeFileSync(process.env.LLM_PROVIDERS_STORE, JSON.stringify(doc));
  const { providers } = llmProviders.buildUserProviderEntries();
  assert.ok(providers.gw1?.retryPolicy, "user route lacks retryPolicy");
  assert.deepEqual(providers.gw1.retryPolicy.retryableCodes, dshProfile.RETRY_POLICY.retryableCodes);
  assert.equal(providers.gw1.retryPolicy.mode, "normal");
});

test("shared constant is frozen and single-sourced", () => {
  assert.ok(Object.isFrozen(dshProfile.RETRY_POLICY));
  assert.equal(typeof dshProfile.RETRY_POLICY.maxRetries, "number");
});

// ── 2. Retry event forwarding ────────────────────────────────────────────────

test("llm/retry forwards as retry_scheduled with budget and failure", () => {
  ctx.handleDshEvent(
    sessionEvent("llm/retry", {
      retryId: "r1",
      turn: 3,
      step: 4,
      provider: "volces",
      mode: "normal",
      policyKey: "k",
      retry: 2,
      maxRetries: 5,
      delayMs: 2000,
      failure: { code: "PI_AI_ERROR", message: "Concurrency limit exceeded for user, please retry later" },
    }),
  );
  const fwd = seen.find((m) => m.type === "retry_scheduled");
  assert.ok(fwd, "no retry_scheduled forwarded");
  assert.equal(fwd.retry, 2);
  assert.equal(fwd.maxRetries, 5);
  assert.equal(fwd.delayMs, 2000);
  assert.equal(fwd.failure.code, "PI_AI_ERROR");
  assert.match(fwd.failure.message, /Concurrency limit exceeded/);
  // No assistant content leaked: nothing else was emitted.
  assert.equal(seen.filter((m) => m.type === "retry_scheduled").length, 1);
});

test("llm/retry-started forwards as retry_started", () => {
  ctx.handleDshEvent(sessionEvent("llm/retry-started", { retryId: "r1", turn: 3, step: 4, retry: 2 }));
  const fwd = seen.find((m) => m.type === "retry_started");
  assert.ok(fwd);
  assert.equal(fwd.retryId, "r1");
  assert.equal(fwd.retry, 2);
});

// ── 3. Trace capture ─────────────────────────────────────────────────────────

test("retry events land in the trace store", async () => {
  await db.initDb();
  ctx.handleDshEvent(
    sessionEvent("llm/retry", {
      retryId: "r2",
      provider: "volces",
      mode: "normal",
      retry: 1,
      maxRetries: 5,
      delayMs: 1000,
      failure: { code: "PI_AI_ERROR", message: "boom" },
    }),
  );
  // Batched flush is 500ms; give it room, then read raw.
  await new Promise((r) => setTimeout(r, 800));
  const rows = db
    .getDb()
    .prepare(`SELECT event_type, payload FROM trace_events WHERE event_type = 'llm/retry'`)
    .all();
  assert.ok(rows.length >= 1, "llm/retry not captured by the trace tap");
  assert.match(rows[0].payload, /Concurrency|boom/);
});

// ── 4. Subagent terminal-reason enrichment ───────────────────────────────────

function subagentResult(callId, text) {
  return sessionEvent("tool/result", {
    message: {
      source: { callId },
      content: [{ toolCallId: callId, isError: true, content: [{ type: "text", text }] }],
    },
  });
}

test("child turn/end error enriches the bare subagent failure card", () => {
  ctx.handleDshEvent(
    sessionEvent(
      "turn/end",
      { reason: { kind: "error", error: { message: "Concurrency limit exceeded for user, please retry later", code: "PI_AI_ERROR" } } },
      CHILD,
    ),
  );
  ctx.dshToolNames.set("call-1", "subagent");
  ctx.dshTurnBlocks.push({ kind: "tool", id: "call-1", name: "subagent", args: {} });
  ctx.handleDshEvent(subagentResult("call-1", "subagent run failed"));
  const end = seen.find((m) => m.type === "tool_end" && m.toolCallId === "call-1");
  assert.ok(end, "tool_end not forwarded");
  assert.match(end.result, /^subagent run failed/);
  assert.match(end.result, /Diagnostic: \[PI_AI_ERROR\] Concurrency limit exceeded for user/);
  // The persisted block carries the same enriched text (model-visible).
  const acc = ctx.dshTurnBlocks.find((b) => b.id === "call-1");
  assert.match(acc.result, /Diagnostic: \[PI_AI_ERROR\]/);
});

test("the Error:-prefixed shape (a thrown tool error) is enriched too", () => {
  ctx.handleDshEvent(
    sessionEvent(
      "turn/end",
      { reason: { kind: "error", error: { message: "Concurrency limit exceeded for user, please retry later", code: "PI_AI_ERROR" } } },
      CHILD,
    ),
  );
  ctx.dshToolNames.set("call-5", "subagent");
  ctx.handleDshEvent(subagentResult("call-5", "Error: subagent run failed"));
  const end = seen.find((m) => m.type === "tool_end" && m.toolCallId === "call-5");
  assert.match(end.result, /^Error: subagent run failed/);
  assert.match(end.result, /Diagnostic: \[PI_AI_ERROR\]/);
});

test("already-diagnostic results pass through untouched", () => {
  ctx.handleDshEvent(
    sessionEvent(
      "turn/end",
      { reason: { kind: "error", error: { message: "later error", code: "X" } } },
      CHILD,
    ),
  );
  ctx.dshToolNames.set("call-2", "subagent");
  const rich = "subagent run failed\nDiagnostic: provider boom";
  ctx.handleDshEvent(subagentResult("call-2", rich));
  const end = seen.find((m) => m.type === "tool_end" && m.toolCallId === "call-2");
  assert.equal(end.result, rich);
});

test("no captured child error leaves the bare headline (legacy shape)", () => {
  ctx.dshToolNames.set("call-3", "subagent");
  ctx.handleDshEvent(subagentResult("call-3", "subagent run failed"));
  const end = seen.find((m) => m.type === "tool_end" && m.toolCallId === "call-3");
  assert.equal(end.result, "subagent run failed");
});

test("non-subagent tool failures are never rewritten", () => {
  ctx.handleDshEvent(
    sessionEvent(
      "turn/end",
      { reason: { kind: "error", error: { message: "noise", code: "X" } } },
      CHILD,
    ),
  );
  ctx.dshToolNames.set("call-4", "bash");
  ctx.handleDshEvent(subagentResult("call-4", "command failed"));
  const end = seen.find((m) => m.type === "tool_end" && m.toolCallId === "call-4");
  assert.equal(end.result, "command failed");
});
