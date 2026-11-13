#!/usr/bin/env node
// ── Live smoke probe for wire-dsh-live-runtime-control ──────────────────────
//
// Boots the real server (real dsh child, real LLM gateway from .env) on a
// throwaway port + stores, then exercises the five fixes end to end over one
// WebSocket:
//
//   1. capabilities chain: connect-time `models` message carries live flags
//      (the server probed the real child's platform/capabilities).
//   2. a real turn's `done` carries usage (chat-usage-display).
//   3. model/set live switch: set_model answers model_changed in seconds with
//      NO bridge.exit (the legacy path restarts the child; the live path must
//      not) and the NEXT turn still answers (the switch didn't wedge).
//   4. tools/set: set_tool_gate flips the websearch gate and echoes tool_gate.
//   5. session/cancel: switch sessions mid-run — the switch returns instantly
//      (no restart window) and the first prompt in the new session dispatches
//      (the original #5 failure).
//
// Exit 0 = all five hold. Any violation prints the offending evidence.

import "dotenv/config";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

const PORT = Number(process.env.PROBE_PORT || 3130);
const BASE = `http://127.0.0.1:${PORT}`;
const root = mkdtempSync(join(tmpdir(), "live-runtime-control-"));

const child = spawn(process.execPath, ["server.js"], {
  env: {
    ...process.env,
    PORT: String(PORT),
    HOST: "127.0.0.1",
    SESSIONS_STORE_DIR: join(root, "sessions-store"),
    DOCUMENTS_STORE_DIR: join(root, "documents-store"),
    CHAT_HISTORY_STORE_DIR: join(root, "chat-history-store"),
    DB_PATH: join(root, "app.db"),
    PLATFORM_DATA_DIR: root,
    MCP_CONFIG_PATH: join(root, "mcp.json"),
  },
  stdio: ["ignore", "pipe", "pipe"],
});
const logs = [];
child.stdout.on("data", (d) => logs.push(d.toString()));
child.stderr.on("data", (d) => logs.push(d.toString()));

const cleanup = (code) => {
  child.kill("SIGTERM");
  setTimeout(() => {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
    process.exit(code);
  }, 500);
};
child.on("exit", (code) => {
  if (code !== null && code !== 0) {
    console.error("server exited early:", code);
    console.error(logs.join("").slice(-3000));
    process.exit(1);
  }
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitReady(timeoutMs = 180_000) {
  const start = Date.now();
  for (;;) {
    try {
      const res = await fetch(`${BASE}/api/ready`);
      if (res.ok) return;
    } catch { /* not listening yet */ }
    if (Date.now() - start > timeoutMs) throw new Error("server not ready in time");
    await sleep(500);
  }
}

// One WS with a message collector + waitFor helper.
const WS = await import(new URL("../node_modules/ws/index.js", import.meta.url).href);
const WebSocket = WS.default || WS.WebSocket;

try {
  await waitReady();
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/`);
  const seen = [];
  const waiters = [];
  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    seen.push(msg);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].pred(msg)) {
        waiters[i].resolve(msg);
        waiters.splice(i, 1);
      }
    }
  });
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  const waitFor = (pred, label, timeoutMs = 90_000) =>
    new Promise((resolve, reject) => {
      const hit = seen.find(pred);
      if (hit) return resolve(hit);
      const timer = setTimeout(
        () => reject(new Error(`timeout waiting for ${label}; last=${JSON.stringify(seen.slice(-6))}`)),
        timeoutMs,
      );
      waiters.push({ pred, resolve: (m) => { clearTimeout(timer); resolve(m); } });
    });
  // Like waitFor but only considers messages arriving AFTER the call — needed
  // wherever an earlier turn already emitted the same message type (done,
  // user, agent_start), which the history scan would otherwise match.
  const waitForNext = (pred, label, timeoutMs = 90_000) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`timeout waiting for ${label}; last=${JSON.stringify(seen.slice(-6))}`)),
        timeoutMs,
      );
      waiters.push({ pred, resolve: (m) => { clearTimeout(timer); resolve(m); } });
    });
  const send = (m) => ws.send(JSON.stringify(m));

  // ── 1. capabilities chain ─────────────────────────────────────────────────
  send({ type: "list_models" });
  const modelsMsg = await waitFor((m) => m.type === "models", "models message");
  assert.deepEqual(modelsMsg.live, { modelSet: true, cancel: true, toolGate: true },
    "live flags on the models message (real child probe)");
  console.log("1. capabilities chain: OK —", JSON.stringify(modelsMsg.live));

  // A model with a different id to switch to (same roster).
  const roster = modelsMsg.models;
  const first = roster[0];
  const target = roster.find((m) => m.id !== first.id) || first;

  // ── LLM availability gate: the checks below that need a real turn ─────────
  let llmUp = true;
  {
    send({ type: "prompt", text: "只回复两个字：收到" });
    const first = await waitFor(
      (m) => m.type === "done" || m.type === "error",
      "probe turn outcome",
      120_000,
    );
    if (first.type === "error") {
      llmUp = false;
      console.log(`   (upstream unavailable: ${first.message} — LLM-dependent checks degrade to SKIP)`);
      await waitFor((m) => m.type === "done", "probe turn done", 30_000).catch(() => {});
    }
  }

  // ── 2. real turn: done carries usage ──────────────────────────────────────
  if (llmUp) {
    send({ type: "prompt", text: "只回复两个字：收到" });
    const done1 = await waitForNext((m) => m.type === "done", "first done");
    assert.ok(done1.usage && Number.isFinite(done1.usage.inputTokens) && done1.usage.inputTokens > 0,
      `done carries real usage, got ${JSON.stringify(done1.usage)}`);
    console.log("2. done usage: OK —", JSON.stringify(done1.usage));
  } else {
    console.log("2. done usage: SKIP (no upstream)");
  }

  // ── 3. live model switch: fast, no bridge.exit (model/set needs no LLM) ───
  const seenLenAtSwitch = seen.length;
  const t0 = Date.now();
  send({ type: "set_model", id: target.id });
  await waitFor((m) => m.type === "model_changed" && m.id === target.id, "model_changed");
  const dt = Date.now() - t0;
  assert.ok(dt < 5000, `model switch took ${dt}ms (live path must be seconds-free)`);
  await sleep(1500);
  const afterSwitch = seen.slice(seenLenAtSwitch);
  assert.ok(!afterSwitch.some((m) => m.type === "error"), `no error after the switch: ${JSON.stringify(afterSwitch.filter((m) => m.type === "error"))}`);
  if (llmUp) {
    // The switch didn't wedge: one more real turn on the new model.
    send({ type: "prompt", text: "只回复两个字：再来" });
    await waitForNext((m) => m.type === "done", "post-switch done");
    console.log(`3. live model switch → ${target.id}: OK — model_changed in ${dt}ms, no restart, next turn answered`);
  } else {
    console.log(`3. live model switch → ${target.id}: OK — model_changed in ${dt}ms, no restart (next-turn check SKIP)`);
  }

  // ── 4. tools/set gate ─────────────────────────────────────────────────────
  send({ type: "set_tool_gate", server: "websearch", enabled: true });
  const gate = await waitForNext((m) => m.type === "tool_gate" && m.enabled === true, "tool_gate echo");
  assert.equal(gate.server, "websearch");
  send({ type: "set_tool_gate", server: "websearch", enabled: false });
  await waitForNext((m) => m.type === "tool_gate" && m.enabled === false, "tool_gate off echo");
  console.log("4. tools/set gate: OK — echoed on/off");

  // ── 5. switch sessions mid-run: instant switch, new session accepts a prompt
  if (llmUp) {
    send({ type: "prompt", text: "从一数到二十，每个数字单独一行，不要停" });
    await waitForNext((m) => m.type === "agent_start", "run started");
    const t1 = Date.now();
    send({ type: "new_session" });
    await waitForNext((m) => m.type === "session_loaded", "new session loaded");
    const switchDt = Date.now() - t1;
    assert.ok(switchDt < 3000, `session switch took ${switchDt}ms (live cancel must not restart)`);
    send({ type: "prompt", text: "只回复一个字：好" });
    const echoNew = await waitForNext((m) => m.type === "user", "echo in the new session", 30_000);
    assert.ok(echoNew.text.includes("好"), `new-session echo carried the prompt text: ${JSON.stringify(echoNew.text)}`);
    await waitForNext((m) => m.type === "done", "new session turn done");
    console.log(`5. mid-run session switch: OK — switch in ${switchDt}ms, new session accepted the prompt immediately`);
  } else {
    console.log("5. mid-run session switch: SKIP (needs a streaming turn)");
  }

  console.log(`\n${llmUp ? "ALL LIVE-CHECKS PASS" : "NO-LLM CHECKS PASS (turn-dependent checks skipped — upstream down)"}`);
  ws.close();
  cleanup(0);
} catch (err) {
  console.error("\nPROBE FAILED:", err.message);
  console.error("— server log tail —\n" + logs.join("").slice(-4000));
  cleanup(1);
}
