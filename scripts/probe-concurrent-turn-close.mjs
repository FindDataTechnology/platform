#!/usr/bin/env node
// probe-concurrent-turn-close.mjs — the decisive probe for 后台续跑
// (background continuation on navigation).
//
// The archived wire-dsh-live-runtime-control design recorded this as a 0.1.1-rc.2
// known limitation: "回合收尾不与另一会话的挂起请求自由交错" — while session A's
// LLM request is parked, ANOTHER session's turn close (finish/idle) starves.
// That limitation is why the host cancels the outgoing session on navigation
// ("切走即取消") instead of letting it run in the background.
//
// This probe re-runs that exact shape on the current matrix tree (0.2.0-rc.2):
//
//   1. A prompts with the [HOLD] marker → the dummy LLM parks the request.
//   2. B prompts (answers immediately) → does B's session reach idle WHILE A
//      is still parked? (rc.2: never — close starved.)
//   3. B prompts a SECOND turn while A is still parked — the real product
//      shape (background A + active use in B).
//   4. Release A → A must close too, and A must accept a fresh prompt after.
//
// Exit 0 = the limitation is lifted (background continuation is buildable).
//
// Setup is lifted verbatim from scripts/dsh-contracts.mjs (same throwaway home,
// same dummy endpoint, same overlay order) — see that file for the rationale.

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { HarnessClient } from "@deepseek-ai/dsh-sdk-client";
import { dshClientRuntime } from "../lib/dsh-client-launch.js";
import { ensureScratchTree, pollUntil, sleep, treeDshVersion, withTimeout } from "./lib/dsh-contracts/contracts.mjs";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SCAFFOLD_FILES = ["package.json", "pnpm-workspace.yaml", "cordis.yml", "cordis.patch.yml"];
const TEMPLATE_DIR = join(REPO_ROOT, "dsh-profile-template");
const PROFILE_NAME = "platform";
const AGENT_PRESET = "standard";
const INITIAL_KEY = `sk-concurrent-probe-${Date.now()}`;
const HANDSHAKE_BUDGET_MS = 30_000;

// Same dummy endpoint as the contracts runner: [HOLD] in the FINAL message
// parks the request until release(); everything else answers immediately.
function startDummyLlm() {
  const requests = [];
  const held = [];
  const release = () => { for (const h of held.splice(0)) h(); };
  const answer = (res, json) => {
    if (json?.stream) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`${JSON.stringify({ id: "probe", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] })}\n\n`);
      res.write(`${JSON.stringify({ id: "probe", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
      res.end("data: [DONE]\n\n");
    } else {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "probe",
        object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }));
    }
  };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      let json = null;
      try { json = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { /* non-JSON */ }
      requests.push({ t: Date.now(), model: json?.model ?? null });
      if (req.method !== "POST") { res.writeHead(404); res.end(); return; }
      const msgs = Array.isArray(json?.messages) ? json.messages : [];
      const last = msgs.at(-1);
      const content = typeof last?.content === "string"
        ? last.content
        : Array.isArray(last?.content)
          ? last.content.map((p) => (typeof p?.text === "string" ? p.text : "")).join(" ")
          : "";
      if (content.includes("[HOLD]")) {
        held.push(() => answer(res, json));
        return;
      }
      answer(res, json);
    });
  });
  return new Promise((resolvePromise) => {
    server.listen(0, "127.0.0.1", () => {
      server.unref();
      resolvePromise({
        url: `http://127.0.0.1:${server.address().port}/v1`,
        requests,
        heldCount: () => held.length,
        release,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

function lastStatus(notifications, sessionId) {
  let status = null;
  for (const n of notifications) {
    if (n?.method === "session.status" && n?.params?.sessionId === sessionId) status = n.params.status;
  }
  return status;
}

function statusTrace(notifications, sessionId) {
  return notifications
    .filter((n) => n?.method === "session.status" && n?.params?.sessionId === sessionId)
    .map((n) => n.params.status)
    .join("→");
}

async function main() {
  // --tree/--bin mirror the contracts runner: probe ANY dsh install (e.g. a
  // 0.2.1-alpha.1 candidate) without touching the pinned matrix.
  const argTree = process.argv.includes("--tree") ? process.argv[process.argv.indexOf("--tree") + 1] : null;
  const argBin = process.argv.includes("--bin") ? process.argv[process.argv.indexOf("--bin") + 1] : null;
  let tree;
  if (argTree) {
    tree = resolve(argTree);
    if (!existsSync(join(tree, "node_modules", "@deepseek-ai", "dsh"))) {
      throw new Error(`${tree} has no node_modules/@deepseek-ai/dsh — pass the install root`);
    }
  } else {
    const scratch = ensureScratchTree({});
    tree = scratch.tree;
  }
  const bin = argBin || join(tree, "node_modules", ".bin", "dsh");
  if (!existsSync(bin)) throw new Error(`dsh binary not found at ${bin}`);

  const home = mkdtempSync(join(tmpdir(), "probe-close-home-"));
  const workspace = mkdtempSync(join(tmpdir(), "probe-close-ws-"));
  const dummyLlm = await startDummyLlm();
  let client = null;
  let watcher = null;
  let pump = null;
  let probeSettled = false; // true once main()'s try settles — a subscription
  // rejection after that is our own close(), not a child death.

  try {
    process.env.DSH_HOME = home;
    process.env.LLM_API_KEY = INITIAL_KEY;
    process.env.LLM_PROVIDERS_STORE = join(home, "llm-providers.json");
    process.env.LLM_DEFAULT_STORE = join(home, "llm-default.json");
    process.env.DB_PATH = join(home, "probe.db");
    process.env.MCP_CONFIG_PATH = join(home, "mcp.json");

    const profileDir = join(home, "profiles", PROFILE_NAME);
    mkdirSync(profileDir, { recursive: true });
    for (const file of SCAFFOLD_FILES) copyFileSync(join(TEMPLATE_DIR, file), join(profileDir, file));
    symlinkSync(join(tree, "node_modules"), join(profileDir, "node_modules"), "dir");
    const dshPkg = join(tree, "node_modules", "@deepseek-ai", "dsh");
    mkdirSync(join(home, "profiles", "node_modules", "@deepseek-ai"), { recursive: true });
    symlinkSync(dshPkg, join(home, "profiles", "node_modules", "@deepseek-ai", "dsh"), "dir");

    const dshProfile = await import(pathToFileURL(join(REPO_ROOT, "dsh-profile.js")).href);
    const dirs = { dshHome: home, profileName: PROFILE_NAME };
    const { providers, models } = await dshProfile.writeLlmProfile({
      dirs,
      llmApiKey: INITIAL_KEY,
      llmBaseUrl: dummyLlm.url,
    });
    await dshProfile.ensureCredentialsStore({ dirs });
    const presetsPatchPath = await dshProfile.writePresetsPatch({ dirs, requireRoster: false });
    const permissionsPatchPath = await dshProfile.writePermissionsPatch();
    const extraPatchPaths = [];
    for (const write of ["writeToolSearchPatch", "writeChartBindPatch", "writeUserQuestionsPatch", "writeSaveLibraryPatch"]) {
      if (typeof dshProfile[write] !== "function") continue;
      try {
        const p = await dshProfile[write]();
        if (typeof p === "string") extraPatchPaths.push(p);
      } catch { /* overlay optional for this probe */ }
    }
    const skillsPatchPath = join(home, "profiles", PROFILE_NAME, "skills.patch.yml");
    try { await dshProfile.writeSkillsPatch({ dirs, agentPreset: AGENT_PRESET }); } catch { /* optional */ }
    const provider = Object.keys(providers)[0];
    const model = models[0]?.id;

    console.log(`probe-concurrent-turn-close — dsh@${treeDshVersion(tree)} (${argTree ? "--tree candidate" : "matrix tree"})`);
    console.log(`  route: provider=${provider} model=${model} → ${dummyLlm.url}`);

    const childEnv = dshProfile.buildScrubbedEnv() ?? { ...process.env };
    for (const k of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) delete childEnv[k];
    const args = ["--profile", PROFILE_NAME, ...[...new Set([
      presetsPatchPath,
      existsSync(skillsPatchPath) ? skillsPatchPath : null,
      permissionsPatchPath,
      ...extraPatchPaths,
    ].filter(Boolean))].flatMap((p) => ["--patch", p])];
    client = new HarnessClient({}, dshClientRuntime({
      command: process.execPath,
      args: [bin, ...args],
      cwd: workspace,
      env: childEnv,
      requestTimeoutMs: 60_000,
      shutdownTimeoutMs: 5_000,
    }));
    client.start();

    const notifications = [];
    let childDied = null;
    watcher = client.subscribe();
    pump = (async () => {
      for (;;) {
        try {
          const notif = await watcher.next();
          if (notif) notifications.push(notif);
        } catch (e) {
          if (!probeSettled) {
            childDied = String(e?.message || e);
            console.error(`child/sub transport failed mid-probe: ${childDied}`);
          }
          return;
        }
      }
    })();

    const deadline = Date.now() + HANDSHAKE_BUDGET_MS;
    for (let attempt = 0; ; attempt++) {
      try {
        await withTimeout(client.initialize({ cwd: workspace, provider, model, agentPreset: AGENT_PRESET }), Math.max(1_000, deadline - Date.now()), "initialize");
        break;
      } catch (e) {
        if (!/no adapter registered for provider/.test(String(e?.message || e)) || Date.now() >= deadline - 500) throw e;
        if (attempt === 0) console.log("  (adapter registration race; retrying handshake…)");
        await sleep(500);
      }
    }
    console.log("  handshake ok");

    const A = "probe-close-a";
    const B = "probe-close-b";

    // ── 1. A parks at the dummy ───────────────────────────────────────────────
    await client.prompt(A, [{ type: "text", text: "park me [HOLD]" }]);
    const parked = await pollUntil(() => (dummyLlm.heldCount() >= 1 ? true : null), { timeoutMs: 15_000, intervalMs: 300 });
    if (!parked) {
      // Distinguish "no request at all" (dispatch-level failure) from "request
      // arrived but the [HOLD] marker missed" (message-shape drift — answered
      // immediately, so A likely already closed).
      throw new Error(
        `A's prompt never parked at the dummy endpoint (requests seen: ${JSON.stringify(dummyLlm.requests.map((r) => r.model))}; A trace: ${statusTrace(notifications, A)})`,
      );
    }
    console.log("1. A parked (request held, no response)");

    // ── 2. THE DECISIVE CHECK: B's turn closes while A is parked ─────────────
    await client.prompt(B, [{ type: "text", text: "quick one" }]);
    await pollUntil(() => (dummyLlm.requests.length >= 2 ? true : null), { timeoutMs: 15_000, intervalMs: 300 });
    const t0 = Date.now();
    const bIdleMs = await (async () => {
      const hit = await pollUntil(() => (lastStatus(notifications, B) === "idle" ? true : null), { timeoutMs: 15_000, intervalMs: 200 });
      return hit ? Date.now() - t0 : null;
    })();
    const bClosedUnderPark = bIdleMs !== null && !childDied;
    console.log(
      bClosedUnderPark
        ? `2. ★ B closed its turn WHILE A still parked (${bIdleMs}ms; B trace: ${statusTrace(notifications, B)})`
        : `2. ✗ B did NOT close while A parked (15s window${childDied ? "; child transport failed: " + childDied : ""}; B trace: ${statusTrace(notifications, B)})`,
    );

    // ── 3. Product shape (only meaningful if 2 passed): a SECOND B turn ──────
    let secondTurnOk = false;
    if (bClosedUnderPark) {
      const reqBefore = dummyLlm.requests.length;
      const idleCount = () => statusTrace(notifications, B).split("idle").length - 1;
      const firstIdleCount = idleCount();
      await client.prompt(B, [{ type: "text", text: "quick two" }]);
      const dispatched = await pollUntil(() => (dummyLlm.requests.length > reqBefore ? true : null), { timeoutMs: 15_000, intervalMs: 300 });
      const closed = await pollUntil(
        () => (lastStatus(notifications, B) === "idle" && idleCount() > firstIdleCount ? true : null),
        { timeoutMs: 15_000, intervalMs: 200 },
      );
      secondTurnOk = Boolean(dispatched && closed && !childDied);
      console.log(
        secondTurnOk
          ? `3. ★ B ran a SECOND full turn while A still parked (B trace: ${statusTrace(notifications, B)})`
          : `3. ✗ B's second turn failed under park (dispatched=${dispatched}; B trace: ${statusTrace(notifications, B)})`,
      );
    } else {
      console.log("3. skipped (2 failed)");
    }

    // ── 4. Release A: does everything converge once the park drains? ─────────
    dummyLlm.release();
    const aIdle = await pollUntil(() => (lastStatus(notifications, A) === "idle" ? true : null), { timeoutMs: 15_000, intervalMs: 300 });
    const bIdleAfterRelease = await pollUntil(() => (lastStatus(notifications, B) === "idle" ? true : null), { timeoutMs: 15_000, intervalMs: 300 });
    console.log(
      `4. after releasing A: A idle=${aIdle ? "yes" : "NO"} (trace ${statusTrace(notifications, A)}), B idle=${bIdleAfterRelease ? "yes" : "NO"} (trace ${statusTrace(notifications, B)})`,
    );

    probeSettled = true;
    if (bClosedUnderPark && secondTurnOk && aIdle) {
      console.log("\nVERDICT: LIFTED — turn close freely interleaves with another session's parked request. Background continuation (切走不取消) is buildable on this tree.");
      return 0;
    }
    console.log(
      "\nVERDICT: STILL PRESENT — another session's turn close does not converge while a sibling request is parked (starvation"
        + (aIdle && bIdleAfterRelease ? " recovers after release" : " does NOT recover after release")
        + "). Background continuation remains blocked on this tree.",
    );
    return 1;
  } finally {
    probeSettled = true;
    try { await watcher?.close(); } catch { /* best effort */ }
    pump?.catch(() => {});
    try { await client?.close(); } catch { /* best effort */ }
    await dummyLlm.close();
    rmSync(home, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
}

try {
  process.exitCode = await main();
} catch (e) {
  console.error(`\nPROBE FAILED: ${String(e?.message || e)}`);
  process.exitCode = 1;
}
