#!/usr/bin/env node
// ── Real-runtime seam sentinel (add-tool-scope-register-shadow, task 3.1) ────
//
// Pins the cordis instance-shadow seam the bridge's registration-time layer
// relies on, against the REAL runtime pinned in package.json
// (@deepseek-ai/cordis 4.0.4 + dsh-system-prompt + dsh-tools 0.1.1-rc.2) and
// the bridge's OWN installMcpToolRegisterShadow — not a hand-rolled replica.
// An upstream upgrade that changes the seam (service views stop sharing the
// instance, receiver/scope attribution moves, `register` stops being a
// prototype method) turns this suite red before anything ships.
//
//   node --test scripts/test-tool-scope-register-seam.mjs

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { Context } from "@deepseek-ai/cordis";
import { createScope, scopeOf } from "@deepseek-ai/dsh-scope";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";

const tmpRoot = mkdtempSync(path.join(tmpdir(), "tool-scope-seam-"));
process.env.TOOL_FILTER_PATH = path.join(tmpRoot, "tool-filter.json");

const { installMcpToolRegisterShadow } = await import("../dsh-profile-template/platform-tool-scope.js");

const writeFilter = (mcpTools) =>
  writeFileSync(process.env.TOOL_FILTER_PATH, JSON.stringify({ mcpTools }));

test.after(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

const mkTool = (name) => ({
  name,
  description: `seam probe ${name}`,
  parameters: { type: "object", properties: {}, required: [] },
  output: { schema: { type: "object" }, render: async () => ({ content: [{ type: "text", text: "ok" }] }) },
  async exec() {
    return { content: [{ type: "text", text: "ok" }] };
  },
});

async function bootTools() {
  const app = new Context();
  await app.plugin(SystemPrompt);
  await app.plugin((await import("@deepseek-ai/dsh-tools")).default);
  const inst = Reflect.get(app.get("tools"), Symbol.for("cordis.original"));
  assert.ok(inst, "the service view unwraps to a shared raw instance via cordis.original");
  return { app, inst };
}

// A plugin that injects tools and captures its ctx, so registrations can be
// made from inside a scope the way real preset trees do.
function toolsUserPlugin(capture) {
  return { inject: ["tools"], apply(ctx) { capture.ctx = ctx; } };
}

test("shadow drops out-of-allowlist registrations at every generation; the rest pass through", async () => {
  writeFilter({ alpha: ["lookup"] });
  const { app, inst } = await bootTools();
  try {
    // The bridge installs through ctx.effect on its own plugin context; the
    // root context stands in for it here.
    installMcpToolRegisterShadow(app);
    assert.ok(Object.hasOwn(inst, "register"), "the shadow lands as an own property");

    const view = app.extend({});
    const d1 = view.tools.register(mkTool("mcp__alpha__lookup"));
    const d2 = view.tools.register(mkTool("mcp__alpha__secret"));
    const d3 = view.tools.register(mkTool("bash"));
    const d4 = view.tools.register(mkTool("mcp__unmapped__anything"));
    const names = () => inst.schemas().map((s) => s.name);

    assert.ok(names().includes("mcp__alpha__lookup"), "allowlisted leaf registers");
    assert.ok(!names().includes("mcp__alpha__secret"), "out-of-allowlist leaf never registers");
    assert.ok(names().includes("bash"), "non-MCP tool passes through");
    assert.ok(names().includes("mcp__unmapped__anything"), "unmapped server keeps its full surface");
    assert.equal(typeof d2, "function", "a dropped registration hands back an inert disposer");

    // "Every generation": a SECOND registration wave (resync shape) is filtered too.
    const d5 = view.tools.register(mkTool("mcp__alpha__secret_v2"));
    assert.ok(!names().includes("mcp__alpha__secret_v2"), "resync-registered out-of-allowlist tool stays out");

    // Fresh filter governs subsequent generations without reinstall (HMR window).
    writeFilter({});
    rmSync(process.env.TOOL_FILTER_PATH, { force: true });
    view.tools.register(mkTool("mcp__alpha__secret_v3"));
    assert.ok(names().includes("mcp__alpha__secret_v3"), "filter removed = pure pass-through again");

    for (const d of [d1, d3, d4, d5]) d?.();
  } finally {
    delete inst.register;
  }
});

test("shadow records the 0.2.0 scope-attribution contract (isolation moved upstream)", async () => {
  writeFilter({ alpha: ["lookup"] });
  const { app, inst } = await bootTools();
  try {
    installMcpToolRegisterShadow(app);
    const capture = {};
    const scope = createScope(app, { seam: "agent-one" });
    const handle = scope.ctx.plugin(toolsUserPlugin(capture));
    await handle.await?.();

    const disp = capture.ctx.tools.register(mkTool("mcp__beta__scoped_tool"));
    const scopedNames = inst.schemas(scopeOf(capture.ctx)).map((s) => s.name);
    assert.ok(scopedNames.includes("mcp__beta__scoped_tool"), "the scoped registration stays visible in its scope");

    // ── DECISION RECORD (2026-11-10, openspec fix-tool-scope-scope-attribution) ──
    // dsh-tools 0.1.1-rc.2 → 0.2.0-rc.2 moved receiver/scope attribution: a
    // service view's method now runs with the RAW instance as `this`, so
    // `this.ctx` is the root context. Two consequences, both asserted below so
    // that ANY upstream change (isolation restored, or restrict usable again)
    // turns this test red and forces the decision to be revisited:
    //
    //   1. a scoped registration lands in the shared/global layer and is visible
    //      from another agent's roster (measured: scope B sees scope A's tool);
    //   2. `tools.restrict({ deny })` — the roster-narrowing escape hatch — is
    //      unusable from an agent scope: it throws "requires a scoped context
    //      (agent.ctx)" because it cannot see the caller's scope (measured).
    //
    // Mitigations still standing (and NOT weakened by this record): the
    // registration-time allowlist filter (case 1 of this file) and the
    // pre-execute guard, which deny *calls* even when a name is visible.
    const second = createScope(app, { seam: "agent-two" });
    const other = {};
    const h2 = second.ctx.plugin(toolsUserPlugin(other));
    await h2.await?.();
    assert.ok(
      other.ctx.tools.schemas().map((s) => s.name).includes("mcp__beta__scoped_tool"),
      "as of 0.2.0-rc.2 a scoped registration IS visible to another agent's roster (isolation moved upstream)",
    );
    assert.throws(
      () => other.ctx.tools.restrict({ deny: ["mcp__beta__scoped_tool"] }),
      /requires a scoped context/,
      "as of 0.2.0-rc.2 tools.restrict() cannot be called from an agent scope, so roster narrowing is unavailable",
    );

    disp();
    h2.dispose?.();
    handle.dispose?.();
    await second.dispose();
    await scope.dispose();
  } finally {
    delete inst.register;
  }
});

test("shadow effect disposal restores the prototype method; a foreign wrapper is never overwritten", async () => {
  writeFilter({ alpha: ["lookup"] });
  const { app, inst } = await bootTools();
  const protoRegister = Object.getPrototypeOf(inst).register;

  // Foreign own property (another plugin's wrapper): the bridge stands down.
  const foreign = function foreign() {};
  inst.register = foreign;
  installMcpToolRegisterShadow(app);
  assert.equal(inst.register, foreign, "an existing own register is left alone");
  delete inst.register;

  // Clean install + effect teardown restores the prototype.
  const disposers = [];
  const scopedHost = app.extend({});
  const origEffect = scopedHost.effect.bind(scopedHost);
  scopedHost.effect = (fn, label) => {
    const d = origEffect(fn, label);
    disposers.push(d);
    return d;
  };
  installMcpToolRegisterShadow(scopedHost);
  assert.ok(Object.hasOwn(inst, "register"));
  for (const d of disposers) d();
  assert.ok(!Object.hasOwn(inst, "register"), "cleanup deletes the own property");
  assert.equal(inst.register, protoRegister, "the prototype method is back");
});
