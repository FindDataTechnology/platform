// The `bot_notify` face (dsh-profile-template/bot-notify.js + its bridge
// platform-notify-bridge.js) and the notify overlay writer (openspec:
// add-agent-notifications, tasks 2.1).
//
// Two layers are exercised:
//   1. the PURE module the bridge wires to the transport — loaded the way the
//      generated profile loads it (@deepseek-ai/dsh-tools resolvable beside
//      it), driving the wire with a recording `notify` function;
//   2. the BRIDGE CLASS itself, when a dsh install is resolvable on this
//      machine (its parent chain imports the SDK server packages) — the class
//      chart, the deferred tool registration and the botNotify/result route.
//      Without a dsh install the class test skips; the runtime composition is
//      proven by the staging probe (task 3.1) either way.
//
//   node --test scripts/test-agent-notify-bridge.mjs

import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { execSync } from "node:child_process";
import { createRequire } from "node:module";
import yaml from "js-yaml";

const require = createRequire(import.meta.url);
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");
const TEMPLATE_DIR = path.join(REPO_ROOT, "dsh-profile-template");

// Load bot-notify.js the way the generated profile does: the file in a dir
// where @deepseek-ai/dsh-tools resolves (repo dependency, symlinked in).
async function loadPureModule() {
  const tmp = mkdtempSync(path.join(tmpdir(), "notify-bridge-"));
  copyFileSync(path.join(TEMPLATE_DIR, "bot-notify.js"), path.join(tmp, "bot-notify.js"));
  mkdirSync(path.join(tmp, "node_modules", "@deepseek-ai"), { recursive: true });
  symlinkSync(
    path.dirname(require.resolve("@deepseek-ai/dsh-tools")),
    path.join(tmp, "node_modules", "@deepseek-ai", "dsh-tools"),
  );
  const mod = await import(pathToFileURL(path.join(tmp, "bot-notify.js")).href);
  return { mod, tmp };
}

// The dsh install tree the machine actually boots children from (the same
// layout resolveShippedPresetRoot knows: $DSH_HOME/profiles/node_modules).
function findDshAnchor() {
  const candidates = [
    path.join(homedir(), ".dsh", "profiles", "node_modules", "@deepseek-ai"),
    "/opt/dsh/node_modules/@deepseek-ai",
  ];
  // A globally installed dsh: the SDK server sits under the SAME @deepseek-ai
  // scope dir as the `dsh` binary's real location (npm -g / homebrew layouts
  // put the scope outside the profile tree).
  try {
    const bin = execSync("command -v dsh", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (bin) {
      let dir = path.dirname(realpathSync(bin));
      while (dir !== path.dirname(dir)) {
        if (path.basename(dir) === "@deepseek-ai") { candidates.push(dir); break; }
        dir = path.dirname(dir);
      }
    }
  } catch { /* no dsh on PATH — the class test skips */ }
  for (const anchor of candidates) {
    if (existsSync(path.join(anchor, "dsh-sdk-jsonrpc-server", "package.json"))) return anchor;
  }
  return null;
}

// ── the pure wire + tool ────────────────────────────────────────────────────

test("wire: a call rides botNotify/send up and settles on botNotify/result", async () => {
  const { mod } = await loadPureModule();
  const sent = [];
  const wire = new mod.BotNotifyWire({ notify: (method, params) => sent.push({ method, params }), uuid: () => "n-fixed" });
  const promise = wire.request({ event: "ticket_done", text: "closed", channel: "ops" });
  assert.deepEqual(sent, [
    { method: "botNotify/send", params: { notifyId: "n-fixed", event: "ticket_done", text: "closed", channel: "ops" } },
  ]);
  // The host's result request resolves the parked call, notifyId stripped.
  assert.deepEqual(wire.settle({ notifyId: "n-fixed", ok: false, reason: "unbound", message: "no binding" }), { accepted: true });
  assert.deepEqual(await promise, { ok: false, reason: "unbound", message: "no binding" });
  // First settlement wins: a duplicate is answered without touching anything.
  assert.equal(wire.settle({ notifyId: "n-fixed", ok: true }).accepted, false);
  // An id this wire never issued changes nothing.
  assert.equal(wire.settle({ notifyId: "never-sent", ok: true }).accepted, false);
});

test("wire: no channel argument → no channel field on the wire", async () => {
  const { mod } = await loadPureModule();
  const sent = [];
  const wire = new mod.BotNotifyWire({ notify: (_m, params) => sent.push(params), uuid: () => "n-2" });
  const p = wire.request({ event: "e", text: "t" });
  wire.settle({ notifyId: "n-2", ok: true });
  await p;
  assert.deepEqual(sent, [{ notifyId: "n-2", event: "e", text: "t" }]);
});

test("wire: an unanswered call times out as a structured result, and shutdown settles the rest", async () => {
  const { mod } = await loadPureModule();
  const wire = new mod.BotNotifyWire({ notify: () => {}, timeoutMs: 25, uuid: () => "n-3" });
  const timedOut = await wire.request({ event: "e", text: "t" });
  assert.equal(timedOut.ok, false);
  assert.equal(timedOut.reason, "timeout");

  const wire2 = new mod.BotNotifyWire({ notify: () => {}, timeoutMs: 60_000, uuid: () => "n-4" });
  const parked = wire2.request({ event: "e", text: "t" });
  wire2.shutdown();
  const afterShutdown = await parked;
  assert.equal(afterShutdown.ok, false);
  assert.equal(afterShutdown.reason, "shutdown");
});

test("tool: bot_notify declares event/text (required) and channel (optional), and returns the wire's answer", async () => {
  const { mod } = await loadPureModule();
  const calls = [];
  const fakeWire = {
    request: async (args) => {
      calls.push(args);
      return { ok: true };
    },
  };
  const tool = mod.createBotNotifyTool({ wire: fakeWire });
  assert.equal(tool.name, "bot_notify");
  // defineTool normalizes the spec into a JSON schema: event/text required,
  // channel optional.
  assert.deepEqual(tool.parameters.required, ["event", "text"]);
  assert.ok(tool.parameters.properties.event);
  assert.ok(tool.parameters.properties.channel);
  const value = await tool.execute({ event: "pr_opened", text: "PR #1", channel: "ops" });
  assert.deepEqual(value, { ok: true });
  assert.deepEqual(calls, [{ event: "pr_opened", text: "PR #1", channel: "ops" }]);
  // Rendering: success and refusal both produce model-readable text.
  const okBlocks = tool.output.render({ event: "pr_opened" }, { ok: true });
  assert.match(okBlocks[0].text, /delivered/i);
  const failBlocks = tool.output.render({ event: "pr_opened" }, { ok: false, reason: "unbound", message: "no binding" });
  assert.match(failBlocks[0].text, /not delivered/i);
  assert.match(failBlocks[0].text, /no binding/);
});

// ── the bridge class (skips without a dsh install) ──────────────────────────

test("bridge: subclasses the preset bridge, registers the tool and routes botNotify/result", async (t) => {
  const anchor = findDshAnchor();
  if (!anchor) {
    t.skip("no dsh install resolvable on this machine (the staging probe covers the composed runtime)");
    return;
  }
  const tmp = mkdtempSync(path.join(tmpdir(), "notify-class-"));
  try {
    for (const f of ["bot-notify.js", "platform-notify-bridge.js", "platform-preset-bridge.js"]) {
      copyFileSync(path.join(TEMPLATE_DIR, f), path.join(tmp, f));
    }
    mkdirSync(path.join(tmp, "node_modules", "@deepseek-ai"), { recursive: true });
    // Symlink PACKAGE ROOTS (not resolved entry files): the ESM resolver walks
    // a package's own directory for its entry.
    const pkgRoot = (name) => {
      try {
        return path.dirname(require.resolve(`${name}/package.json`));
      } catch {
        let dir = path.dirname(require.resolve(name));
        while (!existsSync(path.join(dir, "package.json"))) dir = path.dirname(dir);
        return dir;
      }
    };
    const links = [
      [path.join(anchor, "dsh-sdk-jsonrpc-server"), "dsh-sdk-jsonrpc-server"],
      [pkgRoot("@deepseek-ai/dsh-tools"), "dsh-tools"],
      [pkgRoot("@deepseek-ai/schemastery"), "schemastery"],
      [pkgRoot("@deepseek-ai/dsh-session"), "dsh-session"],
    ];
    for (const [target, name] of links) {
      symlinkSync(target, path.join(tmp, "node_modules", "@deepseek-ai", name));
    }
    const mod = await import(pathToFileURL(path.join(tmp, "platform-notify-bridge.js")).href);
    assert.equal(mod.name, "platform-notify-server");
    assert.deepEqual(mod.inject, ["agents"]);

    // A minimal composed context: the constructor's session/event subscription
    // and the deferred tools injection are the only reachable surfaces here.
    const sent = [];
    const injected = [];
    const ctx = {
      on: () => () => {},
      get: () => undefined,
      inject: (_deps, cb) => {
        injected.push(cb);
        return { dispose: () => {} };
      },
    };
    const transportPeer = { notify: (method, params) => sent.push({ method, params }) };
    const server = new mod.NotifySdkServer(ctx, transportPeer, {});
    // Deferred tool registration: the callback lands the tool on the tools svc.
    assert.equal(injected.length, 1);
    let tool = null;
    injected[0]({ tools: { register: (t) => { tool = t; } } });
    assert.ok(tool, "the bot_notify tool is registered when tools composes");
    assert.equal(tool.name, "bot_notify");

    // Driving a tool call emits the notification; the result request resolves it.
    const pending = tool.execute({ event: "gate_changed", text: "闸门切换" });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].method, "botNotify/send");
    assert.equal(sent[0].params.event, "gate_changed");
    const accepted = await server.handleRequest("botNotify/result", { notifyId: sent[0].params.notifyId, ok: true });
    assert.deepEqual(accepted, { accepted: true });
    assert.deepEqual(await pending, { ok: true });

    // The parent chain is intact: an unknown method still goes through the
    // stock SDK server's error.
    await assert.rejects(() => server.handleRequest("no/such-method", {}), /unknown DeepSeek Harness SDK runtime method/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ── the overlay writer ──────────────────────────────────────────────────────

test("writeNotifyPatch lands both bridge files and the row-swap overlay", async () => {
  const { writeNotifyPatch } = await import("../dsh-profile.js");
  const home = mkdtempSync(path.join(tmpdir(), "notify-patch-"));
  try {
    const patchPath = writeNotifyPatch({ dirs: { dshHome: home, profileName: "platform" } });
    assert.equal(patchPath, path.join(home, "profiles", "platform", "notify.patch.yml"));
    const patch = yaml.load(readFileSync(patchPath, "utf8"));
    // The swap: disable the row the presets overlay inserted, insert the
    // subclass under a fresh id (a patch cannot rewrite a row's plugin name).
    assert.deepEqual(patch[0], { id: "platform-sdk-server", disabled: true });
    assert.deepEqual(patch[1], { insert: [{ id: "platform-notify-server", name: "./platform-notify-bridge.js" }] });
    for (const f of ["platform-notify-bridge.js", "bot-notify.js", "platform-preset-bridge.js"]) {
      assert.ok(existsSync(path.join(home, "profiles", "platform", f)), `${f} copied beside the profile`);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});