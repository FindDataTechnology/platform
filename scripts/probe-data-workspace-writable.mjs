#!/usr/bin/env node
// ── Data-workspace writable root — local real-dsh rehearsal ─────────────────
//
// fix-agent-data-workspace-writes: a workspace-declared child must spawn with
// cwd = its data dir, because dsh's workspace-write sandbox takes its writable
// set from the session cwd (writableRoots = { session cwd, /tmp, tmpdir() }).
// The production spawn path (ChildManager → AgentChild → real
// @deepseek-ai/dsh-sdk-client → local dsh) is driven here against a scripted
// OpenAI gateway that plays the model (same pattern as e2e/chaos-llm.js):
//
//   turn 1 — bash write INSIDE the data workspace   → must land
//   turn 2 — bash write OUTSIDE it (sibling tree)   → must be refused with
//            the sandbox denial marker, and must not land
//
// No real LLM traffic, deterministic commands.
//
// The rehearsal root deliberately lives OUTSIDE /tmp & tmpdir(): the
// workspace-write policy hard-grants those, so a tmp-rooted home could not
// tell the fixed spawn cwd from the broken one (both writable). A regression
// to the old spawn cwd makes turn 1 fail here — this script is the guard.
//
//   node scripts/probe-data-workspace-writable.mjs
//   DSH_BIN=/path/to/dsh node scripts/probe-data-workspace-writable.mjs

import assert from "node:assert/strict";
import http from "node:http";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { HarnessClient } from "@deepseek-ai/dsh-sdk-client";
import { dshClientRuntime } from "../lib/dsh-client-launch.js";
import { composeDescriptor } from "../lib/agent-serving.js";
import { ChildManager } from "../agent-runner/manager.js";

const root = path.join(homedir(), `.agent-runner-rehearsal-${process.pid}`);
const appTree = path.join(root, "apptree"); // stands in for the /app the runner used to cd into
const homeRoot = path.join(root, "homes");
const outsideProbe = path.join(root, "outside-probe.txt");

const failures = [];
const check = (name, fn) => {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (e) {
    failures.push(name);
    console.error(`FAIL - ${name}\n  ${e?.message || e}`);
  }
};

// ── Scripted model: one bash tool_call, then a final text ───────────────────
const state = { cmd: null, seenToolResults: [] };

function sse(res, events) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  for (const e of events) res.write(`data: ${JSON.stringify(e)}\n\n`);
  res.end("data: [DONE]\n\n");
}
const chunk = (delta, finish = null) => ({
  id: "rehearsal-1",
  object: "chat.completion.chunk",
  model: "deepseek-v4.1-flash",
  choices: [{ index: 0, delta, finish_reason: finish }],
});

const stub = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
      res.writeHead(404).end();
      return;
    }
    let body = {};
    try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { /* keep {} */ }
    const messages = Array.isArray(body.messages) ? body.messages : [];
    for (const m of messages) {
      if (m.role === "tool" && typeof m.content === "string") state.seenToolResults.push(m.content);
    }
    const hasToolResult = messages.some((m) => m.role === "tool");
    const stream = body.stream === true;

    if (!hasToolResult) {
      const toolCall = {
        index: 0,
        id: "rehearsal-call-1",
        type: "function",
        function: { name: "bash", arguments: JSON.stringify({ command: state.cmd, description: "Run the data workspace write probe" }) },
      };
      if (stream) {
        sse(res, [
          chunk({ role: "assistant", tool_calls: [toolCall] }),
          chunk({}, "tool_calls"),
        ]);
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          id: "rehearsal-1",
          object: "chat.completion",
          model: "deepseek-v4.1-flash",
          choices: [{ index: 0, message: { role: "assistant", content: null, tool_calls: [toolCall] }, finish_reason: "tool_calls" }],
        }));
      }
      return;
    }
    const text = "probe done";
    if (stream) {
      sse(res, [chunk({ role: "assistant", content: text }), chunk({}, "stop")]);
    } else {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "rehearsal-2",
        object: "chat.completion",
        model: "deepseek-v4.1-flash",
        choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
      }));
    }
  });
});
await new Promise((r) => stub.listen(0, "127.0.0.1", r));
const stubUrl = `http://127.0.0.1:${stub.address().port}/v1`;

// The route seam: buildLlmProfile reads these at materialize time (no volces
// override present locally), so the composed settings.yaml points at the stub.
process.env.LLM_API_KEY ||= "rehearsal-key";
process.env.LLM_BASE_URL = stubUrl;

mkdirSync(appTree, { recursive: true });

const config = {
  homeRoot,
  cwd: appTree, // the production default the fix overrides for declared workspaces
  dshBin: process.env.DSH_BIN || "dsh",
  dshProfile: process.env.DSH_PROFILE || "platform",
  // The production image bakes /opt/dsh-home as the profile scaffold source;
  // locally the dev home plays that role (scaffold files + node_modules symlink).
  seedHome: process.env.DSH_SEED_HOME || path.join(homedir(), ".dsh"),
  meterFile: path.join(homeRoot, "meter.jsonl"),
  provider: "volces",
  model: "deepseek-v4.1-flash",
  turnTimeoutMs: 120_000,
  maxChildren: 2,
  registryToken: "",
  portBase: 8791,
  portSpan: 8,
};

// The production client factory (mirrors agent-runner/index.js).
const clientFactory = (spec) => ({ args, cwd, env }) => {
  const client = new HarnessClient(
    {},
    dshClientRuntime({
      command: config.dshBin,
      args,
      cwd,
      env: { ...env, DSH_HOME: spec.home },
      requestTimeoutMs: (spec.turnBudgetMs ?? config.turnTimeoutMs) + 30_000,
      shutdownTimeoutMs: 5000,
    }),
  );
  return {
    start: () => client.start(),
    initialize: (p) => client.initialize(p),
    subscribe: () => client.subscribe(),
    prompt: (sid, blocks) => client.prompt(sid, blocks),
    request: (m, p) => client.request(m, p),
    stop: () => client.stop?.(),
  };
};
const manager = new ChildManager({
  config,
  registryClient: {},
  clientFactory: (spec) => (specArg) => clientFactory(spec)(specArg),
});

const entry = {
  path: "/packs/rehearsal/analyst",
  name: "彩排分析师",
  metadata: composeDescriptor({
    packId: "rehearsal",
    version: 1,
    manifest: { name: "rehearsal-pack", agents: [] },
    agent: { id: "analyst", name: "彩排分析师", persona: "p", serving: { protocol: "a2a", workspace: { enabled: true, quotaMb: 256 } } },
    skillPaths: [],
  }),
};

let exitCode = 0;
try {
  console.log(`[rehearsal] root ${root}\n[rehearsal] model stub ${stubUrl}`);
  const dataDir = path.join(homeRoot, "packs-rehearsal-analyst", "data");

  // Turn 1 — write INSIDE the data workspace.
  state.cmd = `printf 'workspace-probe-ok' > "$AGENT_DATA_DIR/probe.txt" && cat "$AGENT_DATA_DIR/probe.txt"`;
  const inside = await manager.turn(entry, "probe-inside", "Run the data workspace write probe.");
  check("turn 1 completes (scripted model, final text)", () => assert.match(inside.text, /probe done/));
  check("write inside the data workspace lands", () => {
    assert.ok(existsSync(path.join(dataDir, "probe.txt")), `${dataDir}/probe.txt missing`);
    assert.equal(readFileSync(path.join(dataDir, "probe.txt"), "utf8"), "workspace-probe-ok");
  });

  // Turn 2 — write OUTSIDE (the rehearsal root's sibling tree: not the data
  // dir, not /tmp, not tmpdir() — must be refused by the sandbox).
  state.cmd = `printf 'should-not-land' > ${JSON.stringify(outsideProbe)}`;
  const outside = await manager.turn(entry, "probe-outside", "Run the outside write probe.");
  check("turn 2 completes (denial is a tool result, not a stuck approval)", () => assert.match(outside.text, /probe done/));
  check("write outside is refused with the sandbox denial marker", () => {
    const last = state.seenToolResults.at(-1) ?? "";
    assert.match(last, /\[sandbox: file access denied under workspace-write mode\]/, `observed: ${JSON.stringify(last.slice(0, 300))}`);
  });
  check("write outside did not land", () => assert.ok(!existsSync(outsideProbe), `${outsideProbe} exists — the sandbox let a write through`));
} catch (e) {
  failures.push("rehearsal turn");
  console.error(`FAIL - rehearsal turn\n  ${e?.stack || e}`);
} finally {
  stub.close();
  await manager.stopAll().catch(() => {});
  rmSync(root, { recursive: true, force: true });
}

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed`);
  exitCode = 1;
} else {
  console.log("\nall checks passed");
}
process.exit(exitCode);