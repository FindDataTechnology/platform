#!/usr/bin/env node
// ── Tool-scope bridge tests (add-mcp-tool-scoping, tasks 3.1–3.2) ────────────
//
// Exercises dsh-profile-template/platform-tool-scope.js at module level with a
// stubbed dsh surface: the guard's name matching (never throws, denies only
// mapped servers' out-of-allowlist leaves) and the best-effort restrict
// (deny computed from the live roster, throws swallowed to guard-only).
// The filter file is re-anchored through TOOL_FILTER_PATH so the repo's
// template dir is never written.
//
//   node --test scripts/test-tool-scope-bridge.mjs

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const tmpRoot = mkdtempSync(path.join(tmpdir(), "tool-scope-"));
process.env.TOOL_FILTER_PATH = path.join(tmpRoot, "tool-filter.json");

const { mcpToolGuardReason, applyMcpToolRestrict, readMcpToolFilter } = await import(
  "../dsh-profile-template/platform-tool-scope.js"
);

const writeFilter = (mcpTools) =>
  writeFileSync(process.env.TOOL_FILTER_PATH, JSON.stringify({ mcpTools }));

test.after(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

test("absent or empty filter reads as no filtering", () => {
  rmSync(process.env.TOOL_FILTER_PATH, { force: true });
  assert.equal(readMcpToolFilter(), null);
  writeFilter({});
  assert.equal(readMcpToolFilter(), null, "empty mapping = no filtering");
  writeFileSync(process.env.TOOL_FILTER_PATH, "{ not json");
  assert.equal(readMcpToolFilter(), null, "unparsable = no filtering, never a throw");
});

test("guard denies only mapped servers' out-of-allowlist leaves", () => {
  writeFilter({ "law-bench": ["read", "search.legal"] });
  assert.equal(mcpToolGuardReason("mcp__law-bench__read"), undefined, "allowlisted leaf passes");
  assert.equal(mcpToolGuardReason("mcp__law-bench__search.legal"), undefined, "dotted leaf passes");
  const reason = mcpToolGuardReason("mcp__law-bench__delete_corpus");
  assert.match(reason, /delete_corpus/);
  assert.match(reason, /law-bench/);
  assert.match(reason, /focused mode/, "the reason explains the scope and the exit");
  // Unmapped server: full surface, never denied.
  assert.equal(mcpToolGuardReason("mcp__fetch__anything"), undefined);
  // Non-MCP tools are never denied.
  assert.equal(mcpToolGuardReason("bash"), undefined);
  assert.equal(mcpToolGuardReason("run_code"), undefined);
  // Malformed names never throw.
  assert.equal(mcpToolGuardReason("mcp__"), undefined);
  assert.equal(mcpToolGuardReason(undefined), undefined);
});

test("guard re-reads the filter per invocation (HMR window stays fresh)", () => {
  writeFilter({ "law-bench": ["read"] });
  assert.equal(mcpToolGuardReason("mcp__fetch__evil"), undefined, "fetch server unmapped yet");
  writeFilter({ "law-bench": ["read"], fetch: ["fetch_url"] });
  assert.match(mcpToolGuardReason("mcp__fetch__evil"), /evil/, "newly mapped server denies");
});

test("empty allowlist denies every tool of that server (role narrowed to zero)", () => {
  writeFilter({ "law-bench": [] });
  assert.match(mcpToolGuardReason("mcp__law-bench__read"), /outside this role's tool allowlist/);
});

function stubAgentCtx({ roster, restrictShouldThrow = false } = {}) {
  const calls = { restrict: [] };
  return {
    calls,
    logger: { warn: () => {} },
    tools: {
      schemas: () => roster.map((name) => ({ name })),
      restrict: (filter) => {
        if (restrictShouldThrow) throw new Error("unknown global tool 'mcp__law-bench__ghost'");
        calls.restrict.push(filter);
      },
    },
  };
}

test("restrict computes deny from the live roster of mapped servers", () => {
  writeFilter({ "law-bench": ["read"] });
  const ctx = stubAgentCtx({
    roster: [
      "mcp__law-bench__read",
      "mcp__law-bench__search",
      "mcp__law-bench__delete",
      "mcp__fetch__fetch_url", // unmapped server — untouched
      "bash", // non-MCP — untouched
    ],
  });
  applyMcpToolRestrict(ctx);
  assert.deepEqual(ctx.calls.restrict, [{ deny: ["mcp__law-bench__search", "mcp__law-bench__delete"] }]);
});

test("restrict throws degrade to guard-only and never break composition", () => {
  writeFilter({ "law-bench": ["read"] });
  const ctx = stubAgentCtx({
    roster: ["mcp__law-bench__search"],
    restrictShouldThrow: true, // restrict() throws (drifted roster)
  });
  assert.doesNotThrow(() => applyMcpToolRestrict(ctx));
  assert.equal(ctx.calls.restrict.length, 0);
});

test("no deny needed (roster already within allowlist) skips the restrict call", () => {
  writeFilter({ "law-bench": ["read", "search"] });
  const ctx = stubAgentCtx({ roster: ["mcp__law-bench__read"] });
  applyMcpToolRestrict(ctx);
  assert.equal(ctx.calls.restrict.length, 0, "restrict({}) would throw on the empty filter");
});

test("roster read failure degrades silently", () => {
  writeFilter({ "law-bench": ["read"] });
  const ctx = {
    logger: { warn: () => {} },
    tools: {
      schemas: () => {
        throw new Error("registry unavailable");
      },
      restrict: () => assert.fail("restrict must not run without a roster"),
    },
  };
  assert.doesNotThrow(() => applyMcpToolRestrict(ctx));
});

// ── Registration-time shadow (add-tool-scope-register-shadow) ────────────────
//
// Stub-level coverage of the wrapper's decision table; the live seam itself
// (cordis proxying, receiver/scope preservation) is pinned by
// scripts/test-tool-scope-register-seam.mjs against the real runtime.

const CORDIS_ORIGINAL = Symbol.for("cordis.original");

function stubShadowHost() {
  // A minimal tools-service surface as the bridge sees it: ctx.get('tools')
  // returns a per-view PROXY over the shared raw instance (what cordis hands
  // out), whose CORDIS_ORIGINAL unwraps to that instance. `registers` records
  // what reached the ORIGINAL method.
  const registers = [];
  const proto = {
    register(...args) {
      registers.push(args);
      return () => {};
    },
  };
  const rawInst = Object.create(proto);
  const view = new Proxy(rawInst, {
    get(target, prop) {
      if (prop === CORDIS_ORIGINAL) return target;
      return Reflect.get(target, prop, target);
    },
    has(target, prop) {
      return prop === CORDIS_ORIGINAL || Reflect.has(target, prop);
    },
    getOwnPropertyDescriptor(target, prop) {
      if (prop === CORDIS_ORIGINAL) return { configurable: true, enumerable: false, value: target, writable: false };
      return Reflect.getOwnPropertyDescriptor(target, prop);
    },
  });
  const disposers = [];
  const ctx = {
    get: (name) => (name === "tools" ? view : undefined),
    effect: (fn) => {
      const dispose = fn();
      disposers.push(dispose);
      return () => dispose();
    },
  };
  return { registers, rawInst, view, ctx, disposers };
}

test("shadow drops out-of-allowlist registrations and passes the rest through", async () => {
  const { installMcpToolRegisterShadow } = await import("../dsh-profile-template/platform-tool-scope.js");
  writeFilter({ "law-bench": ["read"], "empty-srv": [] });
  const host = stubShadowHost();
  installMcpToolRegisterShadow(host.ctx);
  assert.equal(host.registers.length, 0, "installation itself registers nothing");
  // The registration call is dispatched the way cordis forwards it: the view's
  // `register` resolves to the raw instance's own prop (the shadow) and runs
  // with the CALLING view as receiver.
  const d1 = host.view.register({ name: "mcp__law-bench__read" });
  const d2 = host.view.register({ name: "mcp__law-bench__delete" });
  const d3 = host.view.register({ name: "bash" });
  const d4 = host.view.register({ name: "mcp__fetch__anything" });
  const d5 = host.view.register({ name: "mcp__empty-srv__read" });
  const reached = host.registers.map((args) => args[0]?.name);
  assert.deepEqual(reached, ["mcp__law-bench__read", "bash", "mcp__fetch__anything"]);
  // Dropped registrations hand back an inert disposer; passed ones the
  // original's return (the stub's own disposer, identity-comparable).
  assert.equal(typeof d1, "function", "pass-through keeps the original's disposer return");
  assert.equal(typeof d2, "function");
  assert.equal(typeof d5, "function");
  assert.ok(d3 !== undefined && d4 !== undefined);
});

test("shadow effect disposal restores the prototype method", async () => {
  const { installMcpToolRegisterShadow } = await import("../dsh-profile-template/platform-tool-scope.js");
  writeFilter({ "law-bench": ["read"] });
  const host = stubShadowHost();
  installMcpToolRegisterShadow(host.ctx);
  assert.ok(Object.hasOwn(host.rawInst, "register"), "own property shadows the prototype");
  for (const d of host.disposers) d();
  assert.ok(!Object.hasOwn(host.rawInst, "register"), "cleanup deletes the own property");
  assert.equal(host.rawInst.register, Object.getPrototypeOf(host.rawInst).register);
});

test("shadow never installs on an unexpected service shape", async () => {
  const { installMcpToolRegisterShadow } = await import("../dsh-profile-template/platform-tool-scope.js");
  writeFilter({ "law-bench": ["read"] });
  // Missing cordis.original
  const bare = { ctx: { get: () => ({}), effect: () => assert.fail("effect must not run") } };
  assert.doesNotThrow(() => installMcpToolRegisterShadow(bare.ctx));
  // tools service absent entirely
  const none = { ctx: { get: () => undefined, effect: () => assert.fail("effect must not run") } };
  assert.doesNotThrow(() => installMcpToolRegisterShadow(none.ctx));
  // get() itself throws
  const hostile = { ctx: { get: () => { throw new Error("no inject"); }, effect: () => assert.fail("effect must not run") } };
  assert.doesNotThrow(() => installMcpToolRegisterShadow(hostile.ctx));
  // An already-shadowed instance (someone else's wrapper) is left alone.
  const host = stubShadowHost();
  const foreign = function foreign() {};
  host.rawInst.register = foreign;
  installMcpToolRegisterShadow(host.ctx);
  assert.equal(host.rawInst.register, foreign, "an existing own register is never overwritten");
});

test("shadow wrapper failures degrade to pass-through, never lose a healthy registration", async () => {
  const { installMcpToolRegisterShadow } = await import("../dsh-profile-template/platform-tool-scope.js");
  // readMcpToolFilter swallows its own errors, so force the failure inside the
  // drop decision by passing a definition whose name access throws.
  writeFilter({ "law-bench": ["read"] });
  const host = stubShadowHost();
  installMcpToolRegisterShadow(host.ctx);
  const evil = { get name() { throw new Error("boom"); } };
  assert.doesNotThrow(() => host.view.register.call(host.view, evil));
  assert.equal(host.registers.at(-1)?.[0], evil, "the throwing definition still reached the original method");
  // No filter at all = pure pass-through.
  rmSync(process.env.TOOL_FILTER_PATH, { force: true });
  host.view.register.call(host.view, { name: "mcp__law-bench__delete" });
  assert.equal(host.registers.at(-1)?.[0]?.name, "mcp__law-bench__delete");
});
