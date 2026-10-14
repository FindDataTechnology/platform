// The per-session preset selection seam (add-dsh-pod-adapter, tasks 1.1-1.4):
// `preset/set {sessionId, presetId}` parks a persona choice for a session the
// bridge has not created yet; creation composes it (parked → initialize-time
// agentPreset → registry default); a live session is refused explicitly; an
// unknown id fails creation loudly before any agent publishes; capabilities
// report the method.
//
// The bridge CLASS itself is exercised against a minimal fake context when a
// dsh install is resolvable (its parent chain imports the SDK server package)
// — the same shape test-agent-notify-bridge.mjs uses. Without a dsh install
// every test here skips; the composed runtime is proven by contract ⑯ either
// way.
//
//   node --test scripts/test-preset-session-bridge.mjs

import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATE_DIR = path.join(REPO_ROOT, "dsh-profile-template");

// The dsh install tree the machine actually boots children from (the same
// anchor discovery test-agent-notify-bridge.mjs uses).
function findDshAnchor() {
  const candidates = [
    path.join(homedir(), ".dsh", "profiles", "node_modules", "@deepseek-ai"),
    "/opt/dsh/node_modules/@deepseek-ai",
  ];
  try {
    const bin = execSync("command -v dsh", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (bin) {
      let dir = path.dirname(realpathSync(bin));
      while (dir !== path.dirname(dir)) {
        if (path.basename(dir) === "@deepseek-ai") { candidates.push(dir); break; }
        dir = path.dirname(dir);
      }
    }
  } catch { /* no dsh on PATH — the class tests skip */ }
  for (const anchor of candidates) {
    if (existsSync(path.join(anchor, "dsh-sdk-jsonrpc-server", "package.json"))) return anchor;
  }
  return null;
}

// Load the bridge module the way the generated profile does: beside a
// node_modules where the SDK server package (and its private protocol dep)
// resolve.
async function loadBridge() {
  const anchor = findDshAnchor();
  if (!anchor) return null;
  const tmp = mkdtempSync(path.join(tmpdir(), "preset-bridge-"));
  for (const f of ["platform-preset-bridge.js", "platform-tool-scope.js"]) {
    copyFileSync(path.join(TEMPLATE_DIR, f), path.join(tmp, f));
  }
  mkdirSync(path.join(tmp, "node_modules", "@deepseek-ai"), { recursive: true });
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
    [pkgRoot("@deepseek-ai/schemastery"), "schemastery"],
    [pkgRoot("@deepseek-ai/dsh-session"), "dsh-session"],
  ];
  for (const [target, name] of links) {
    symlinkSync(target, path.join(tmp, "node_modules", "@deepseek-ai", name));
  }
  const mod = await import(pathToFileURL(path.join(tmp, "platform-preset-bridge.js")).href);
  return { mod, tmp };
}

// A minimal composed context: enough surface for initialize + createSession +
// the live-control attachment. `agents.create` records its args — the preset
// the session composed with is asserted through the recorded meta/setup.
function fakeCtx({ presets }) {
  const created = [];
  const ctx = {
    on: () => () => {},
    get: (name) => {
      if (name === "agentPresets") return presets;
      if (name === "llm") return { listProviders: () => [{ id: "test-provider" }], resolveCallConfig: async () => ({}) };
      return undefined;
    },
    inject: (_deps, _cb) => ({ dispose: () => {} }),
    agents: {
      create: async (opts) => {
        created.push(opts);
        const agentCtx = { on: () => () => {}, effect: () => () => {}, logger: undefined };
        if (opts.setup) await opts.setup(agentCtx);
        return { agent: { ctx: agentCtx, cancel: () => {}, whenIdle: async () => {} } };
      },
      resume: async (opts) => {
        created.push({ ...opts, resumed: true });
        return { agent: { ctx: { on: () => () => {}, effect: () => () => {} } } };
      },
    },
  };
  return { ctx, created };
}

function rosterPresets(rows = ["standard", "alt"]) {
  return {
    // resolve(undefined) is the registry-default semantics (the real service
    // resolves its default row when no id is given).
    resolve: async (id) => {
      const row = id === undefined || id === null || id === ""
        ? rows[0]
        : rows.find((r) => (typeof r === "string" ? r === id : r.id === id));
      if (!row) throw new Error(`unknown agent preset: ${id}`);
      return typeof row === "string" ? { id: row } : row;
    },
    mount: async () => {},
    list: async () => rows.map((r) => (typeof r === "string" ? { id: r } : r)),
  };
}

test("preset/set: a parked preset composes the session and names itself in the header", async (t) => {
  const loaded = await loadBridge();
  if (!loaded) return t.skip("no dsh install resolvable on this machine (contract ⑯ covers the composed runtime)");
  const { mod, tmp } = loaded;
  try {
    const { ctx, created } = fakeCtx({ presets: rosterPresets() });
    const server = new mod.PlatformSdkServer(ctx, { notify: () => {} }, {});
    await server.handleRequest("initialize", { cwd: tmp, provider: "test-provider", model: "m1", agentPreset: "standard" });
    // Park BEFORE the session exists — the pod host's first-touch flow.
    assert.deepEqual(await server.handleRequest("preset/set", { sessionId: "srv-a", presetId: "alt" }), { ok: true });
    await server.createSession("srv-a");
    assert.equal(created.length, 1);
    assert.equal(created[0].meta.agentPreset, "alt", "the parked preset, not the initialize-time default, composes the session");
    // The parked entry is single-shot: gone after the creation it steered.
    await server.createSession("srv-b");
    assert.equal(created[1].meta.agentPreset, "standard", "an unparked session falls back to the initialize-time agentPreset");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("preset/set: a live session is refused explicitly, never silently swapped", async (t) => {
  const loaded = await loadBridge();
  if (!loaded) return t.skip("no dsh install resolvable on this machine");
  const { mod, tmp } = loaded;
  try {
    const { ctx } = fakeCtx({ presets: rosterPresets() });
    const server = new mod.PlatformSdkServer(ctx, { notify: () => {} }, {});
    await server.handleRequest("initialize", { cwd: tmp, provider: "test-provider", model: "m1" });
    await server.createSession("srv-live");
    await assert.rejects(
      server.handleRequest("preset/set", { sessionId: "srv-live", presetId: "alt" }),
      /creation-time composition/,
      "the refusal names the rule (start a new session), so silent accept AND silent ignore both fail this seam",
    );
    // Shape validation: empty ids refuse before any state changes.
    await assert.rejects(server.handleRequest("preset/set", { sessionId: "", presetId: "alt" }), /requires/);
    await assert.rejects(server.handleRequest("preset/set", { sessionId: "srv-x", presetId: " " }), /requires/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("preset/set: an unresolvable parked id fails creation loudly, before any agent publishes", async (t) => {
  const loaded = await loadBridge();
  if (!loaded) return t.skip("no dsh install resolvable on this machine");
  const { mod, tmp } = loaded;
  try {
    const { ctx, created } = fakeCtx({ presets: rosterPresets() });
    const server = new mod.PlatformSdkServer(ctx, { notify: () => {} }, {});
    await server.handleRequest("initialize", { cwd: tmp, provider: "test-provider", model: "m1" });
    await server.handleRequest("preset/set", { sessionId: "srv-ghost", presetId: "no-such-preset" });
    await assert.rejects(server.createSession("srv-ghost"), /unknown agent preset/);
    assert.equal(created.length, 0, "the factory rolled the whole creation back — no half-composed agent");
    // And no residue: the same session id can be created cleanly afterwards.
    await server.handleRequest("preset/set", { sessionId: "srv-ghost", presetId: "standard" });
    await server.createSession("srv-ghost");
    assert.equal(created.length, 1);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("preset/set: capabilities report the method beside model/set and session/cancel", async (t) => {
  const loaded = await loadBridge();
  if (!loaded) return t.skip("no dsh install resolvable on this machine");
  const { mod, tmp } = loaded;
  try {
    const { ctx } = fakeCtx({ presets: rosterPresets() });
    const server = new mod.PlatformSdkServer(ctx, { notify: () => {} }, {});
    const caps = await server.handleRequest("platform/capabilities", {});
    for (const m of ["preset/set", "model/set", "session/cancel"]) {
      assert.ok(caps.methods.includes(m), `capabilities must report ${m}`);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
