// Bounded live test for the isStreaming concurrency fix (Cluster B).
//
// Two WS clients fire prompts near-simultaneously. After the fix, client B's
// prompt arrives while isStreaming is already true (set synchronously before
// the first await), so B steers into A's in-flight turn -> exactly ONE
// agent_start and ONE done. A race (the old behavior) would start a second
// turn -> TWO agent_starts / TWO dones.
//
// Run from the project root so `ws` resolves.

import { WebSocket } from "ws";

const PORT = 3999;
const URL = `ws://localhost:${PORT}/`;

let agentStart = 0;
let doneCount = 0;
let errors = [];
let texts = 0;

function mkClient(name) {
  const ws = new WebSocket(URL);
  ws.on("open", () => console.log(`[${name}] open`));
  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type === "agent_start") { agentStart++; console.log(`[${name}] agent_start (#${agentStart})`); }
    else if (msg.type === "done") { doneCount++; console.log(`[${name}] done (#${doneCount})`); }
    else if (msg.type === "error") { errors.push(msg.message); console.log(`[${name}] error: ${msg.message}`); }
    else if (msg.type === "text") { texts++; }
  });
  ws.on("error", (e) => console.log(`[${name}] socket error: ${e.message}`));
  return ws;
}

const a = mkClient("A");
a.on("open", () => {
  // Long streaming prompt so the turn is still in flight when B fires.
  a.send(JSON.stringify({ type: "prompt", text: "Write a detailed step-by-step guide to making sourdough bread from scratch. At least 400 words, be thorough." }));
  // Fire B on the next tick — within the race window (A's session.prompt has
  // yielded at its first await; isStreaming must already be true).
  setImmediate(() => {
    const b = mkClient("B");
    b.on("open", () => {
      b.send(JSON.stringify({ type: "prompt", text: "Actually, just say hello." }));
    });
  });
});

// Collect for 40s, then report.
setTimeout(() => {
  console.log("\n=== RESULT ===");
  console.log(`agent_start events: ${agentStart}`);
  console.log(`done events:        ${doneCount}`);
  console.log(`text deltas:        ${texts}`);
  console.log(`errors:             ${errors.length}`);
  const ok = agentStart === 1 && doneCount === 1;
  console.log(`\nverdict: ${ok ? "PASS — single turn (B steered, no race)" : "FAIL — expected 1 agent_start / 1 done"}`);
  process.exit(ok ? 0 : 1);
}, 40000);
