// The `chart_bind` dsh plugin (dsh-profile-template/platform-chart-bind-bridge.js)
// and its profile patch, against a FAKE registry and a FAKE loopback bridge
// (openspec: add-chart-data-binding, tasks 3.1-3.2).
//
// The two properties that matter most are asserted directly: the plugin never
// executes the declared tool (the only request it makes is the declaration
// itself), and every refusal carries a reason the model can relay to the user.

import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const TEMPLATE_DIR = path.resolve(new URL(".", import.meta.url).pathname, "../dsh-profile-template");
const REPO_ROOT = path.resolve(TEMPLATE_DIR, "..");

// Load the plugin the way the generated profile does: the file, its matcher
// module and the deployment's allowlist side by side, with @deepseek-ai/dsh-tools
// resolvable from beside the plugin.
async function loadPlugin({ allowlist = null } = {}) {
  const tmp = mkdtempSync(path.join(tmpdir(), "chart-bind-bridge-"));
  copyFileSync(
    path.join(TEMPLATE_DIR, "platform-chart-bind-bridge.js"),
    path.join(tmp, "platform-chart-bind-bridge.js"),
  );
  copyFileSync(path.join(REPO_ROOT, "server", "tool-discovery.js"), path.join(tmp, "tool-discovery.js"));
  if (allowlist) {
    copyFileSync(allowlist, path.join(tmp, "chart-replay-allowlist.json"));
  }
  mkdirSync(path.join(tmp, "node_modules", "@deepseek-ai"), { recursive: true });
  symlinkSync(
    path.dirname(require.resolve("@deepseek-ai/dsh-tools")),
    path.join(tmp, "node_modules", "@deepseek-ai", "dsh-tools"),
  );
  const mod = await import(pathToFileURL(path.join(tmp, "platform-chart-bind-bridge.js")).href);
  return { mod, tmp };
}

// A loopback stand-in for the platform's declaration route.
function fakeBridge({ respond = null } = {}) {
  const received = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString();
      received.push({ method: req.method, url: req.url, body: JSON.parse(body || "{}") });
      const answer = respond
        ? respond(received[received.length - 1])
        : {
            ok: true,
            binding: {
              id: "binding-1",
              server: "fd-open-data-mcp",
              tool: "read_series",
              args: { concept_id: "M0_YOY" },
              frequency: "monthly",
              unit: "%",
            },
          };
      res.writeHead(answer.status ?? 200, { "content-type": "application/json" });
      res.end(JSON.stringify(answer.body ?? answer));
    });
  });
  return {
    received,
    async listen() {
      await new Promise((r) => server.listen(0, "127.0.0.1", r));
      this.url = `http://127.0.0.1:${server.address().port}`;
      return this.url;
    },
    close() {
      return new Promise((r) => server.close(r));
    },
  };
}

const ROSTER = [
  {
    name: "mcp__fd-open-data-mcp__read_series",
    description: "Read a cached time series for a concept.",
    parameters: { type: "object", properties: { concept_id: { type: "string" } }, required: ["concept_id"] },
  },
  {
    name: "mcp__fd-open-data-mcp__policy_delete",
    description: "Delete a policy.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "mcp__fd-daas-mcp__dashboard_list",
    description: "List dashboards.",
    parameters: { type: "object", properties: {} },
  },
];

function register(mod, { schemas = ROSTER, scope = "agent-scope-1" } = {}) {
  let registered = null;
  const fakeCtx = {
    tools: {
      register: (def) => {
        registered = def;
      },
      schemas: (agentScope) => {
        assert.equal(agentScope, scope);
        return schemas;
      },
    },
  };
  mod.apply(fakeCtx);
  assert.ok(registered, "chart_bind was not registered");
  return registered;
}

function textOf(blocks) {
  return (blocks ?? []).map((b) => (typeof b === "string" ? b : b?.text)).join("\n");
}

test("chart_bind registers as a read-only declaration tool", async () => {
  const { mod, tmp } = await loadPlugin({ allowlist: path.join(REPO_ROOT, "chart-replay-allowlist.json") });
  try {
    assert.equal(mod.name, "chart-bind-bridge");
    assert.deepEqual(mod.inject, ["tools"]);
    const tool = register(mod);
    assert.equal(tool.name, "chart_bind");
    assert.deepEqual(tool.parameters.required.sort(), ["args", "tool"]);
    assert.match(tool.description, /never executes the call/i);
    assert.match(tool.description, /same turn/i);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("a declaration lands: the ONLY request it makes is the declaration itself", async () => {
  const bridge = fakeBridge();
  const url = await bridge.listen();
  const previous = process.env.CHART_BRIDGE_URL;
  process.env.CHART_BRIDGE_URL = url;
  const { mod, tmp } = await loadPlugin({ allowlist: path.join(REPO_ROOT, "chart-replay-allowlist.json") });
  try {
    const tool = register(mod);
    const value = await tool.execute(
      {
        tool: "mcp__fd-open-data-mcp__read_series",
        args: '{"concept_id":"M0_YOY","entity_type":"country","entity_id":"CN"}',
        note: "M0 同比趋势",
      },
      { agent: "agent-scope-1" },
    );
    assert.equal(value.ok, true);
    assert.equal(bridge.received.length, 1, "exactly one outbound request — the declaration");
    const [call] = bridge.received;
    assert.equal(call.method, "POST");
    assert.equal(call.url, "/api/resources/bind-declared");
    assert.deepEqual(call.body.args, { concept_id: "M0_YOY", entity_type: "country", entity_id: "CN" });
    assert.equal(call.body.map, null, "the standard map needs no declaration");
    assert.equal(call.body.note, "M0 同比趋势");

    const text = textOf(tool.output.render({}, value));
    assert.match(text, /Data source bound/);
    assert.match(text, /fd-open-data-mcp · read_series/);
    assert.match(text, /was NOT executed here/);
  } finally {
    if (previous === undefined) delete process.env.CHART_BRIDGE_URL;
    else process.env.CHART_BRIDGE_URL = previous;
    await bridge.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("a tool outside the agent's roster is refused with a relayable reason", async () => {
  const bridge = fakeBridge();
  const url = await bridge.listen();
  const previous = process.env.CHART_BRIDGE_URL;
  process.env.CHART_BRIDGE_URL = url;
  const { mod, tmp } = await loadPlugin({ allowlist: path.join(REPO_ROOT, "chart-replay-allowlist.json") });
  try {
    const tool = register(mod);
    const value = await tool.execute({ tool: "mcp__fd-open-data-mcp__reaad_series", args: "{}" }, { agent: "agent-scope-1" });
    assert.equal(value.ok, false);
    assert.match(value.message, /not in this session's tool roster/);
    assert.match(value.message, /Closest callable names: mcp__fd-open-data-mcp__read_series/);
    assert.equal(bridge.received.length, 0, "nothing was declared and nothing was called");
    const text = textOf(tool.output.render({}, value));
    assert.match(text, /not recorded/);
  } finally {
    if (previous === undefined) delete process.env.CHART_BRIDGE_URL;
    else process.env.CHART_BRIDGE_URL = previous;
    await bridge.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("an off-allowlist tool is refused before anything is posted", async () => {
  const bridge = fakeBridge();
  const url = await bridge.listen();
  const previous = process.env.CHART_BRIDGE_URL;
  process.env.CHART_BRIDGE_URL = url;
  // The shipped default allowlist: read_series only.
  const { mod, tmp } = await loadPlugin({ allowlist: path.join(REPO_ROOT, "chart-replay-allowlist.json") });
  try {
    const tool = register(mod, {
      schemas: [...ROSTER, { name: "mcp__fd-open-data-mcp__read", description: "read-through", parameters: { type: "object", properties: {} } }],
    });
    const value = await tool.execute({ tool: "mcp__fd-open-data-mcp__read", args: "{}" }, { agent: "agent-scope-1" });
    assert.equal(value.ok, false);
    assert.match(value.message, /replay allowlist/);
    assert.match(value.message, /fd-open-data-mcp allows: read_series/);
    assert.equal(bridge.received.length, 0);

    // A server the deployment does not list at all is not a data source.
    const other = await tool.execute({ tool: "mcp__fd-daas-mcp__dashboard_list", args: "{}" }, { agent: "agent-scope-1" });
    assert.equal(other.ok, false);
    assert.match(other.message, /not a supported data source/);
    assert.equal(bridge.received.length, 0);
  } finally {
    if (previous === undefined) delete process.env.CHART_BRIDGE_URL;
    else process.env.CHART_BRIDGE_URL = previous;
    await bridge.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("a deployment with no allowlist file still refuses off-allowlist tools", async () => {
  // The prod shape this test exists for (2026-09-28): the image shipped the
  // plugin but not `chart-replay-allowlist.json`, so the file was unreadable at
  // runtime. The contract stays default-deny — the fallback is the same
  // documented default the server's replay gate uses, never "allow everything".
  const bridge = fakeBridge();
  const url = await bridge.listen();
  const previous = process.env.CHART_BRIDGE_URL;
  process.env.CHART_BRIDGE_URL = url;
  const { mod, tmp } = await loadPlugin(); // nothing copied into the plugin's own dir
  try {
    const tool = register(mod, {
      schemas: [...ROSTER, { name: "mcp__fd-open-data-mcp__read", description: "read-through", parameters: { type: "object", properties: {} } }],
    });
    const refused = await tool.execute({ tool: "mcp__fd-open-data-mcp__read", args: "{}" }, { agent: "agent-scope-1" });
    assert.equal(refused.ok, false);
    assert.match(refused.message, /replay allowlist/);
    assert.equal(bridge.received.length, 0);

    // The fallback's one listed tool still declares normally.
    const allowed = await tool.execute(
      { tool: "mcp__fd-open-data-mcp__read_series", args: '{"concept_id":228}' },
      { agent: "agent-scope-1" },
    );
    assert.equal(allowed.ok, true, allowed.message);
    assert.equal(bridge.received.length, 1);
  } finally {
    if (previous === undefined) delete process.env.CHART_BRIDGE_URL;
    else process.env.CHART_BRIDGE_URL = previous;
    await bridge.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("malformed declarations are refused with the reason, and an operator allowlist edit is honoured", async () => {
  const { mod, tmp } = await loadPlugin({ allowlist: path.join(REPO_ROOT, "chart-replay-allowlist.json") });
  try {
    const tool = register(mod);
    // The declarative parameter map is enforced by the runtime before execute
    // runs (defineTool raises ToolArgsError) — the model gets a typed refusal
    // for a missing argument without the plugin being involved.
    await assert.rejects(() => tool.execute({ args: "{}" }, { agent: "agent-scope-1" }), /missing required property "tool"/);
    await assert.rejects(
      () => tool.execute({ tool: "mcp__fd-open-data-mcp__read_series" }, { agent: "agent-scope-1" }),
      /missing required property "args"/,
    );
    assert.match(
      (await tool.execute({ tool: "read_series", args: "{}" }, { agent: "agent-scope-1" })).message,
      /not an MCP tool name/,
    );
    assert.match(
      (await tool.execute({ tool: "mcp__fd-open-data-mcp__read_series", args: "not json" }, { agent: "agent-scope-1" })).message,
      /`args` must be a JSON object/,
    );
    // An array or a scalar is not an object: refusing beats coercing, because a
    // binding with the wrong arguments would replay the wrong data forever.
    assert.match(
      (await tool.execute({ tool: "mcp__fd-open-data-mcp__read_series", args: "[1,2]" }, { agent: "agent-scope-1" })).message,
      /`args` must be a JSON object/,
    );
    assert.match(
      (
        await tool.execute(
          { tool: "mcp__fd-open-data-mcp__read_series", args: "{}", map: "[1,2]" },
          { agent: "agent-scope-1" },
        )
      ).message,
      /`map` must be a JSON object/,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  // ...and the deployment's own file is what decides: add `read`, and the same
  // declaration is accepted.
  const custom = path.join(mkdtempSync(path.join(tmpdir(), "allowlist-")), "chart-replay-allowlist.json");
  require("node:fs").writeFileSync(
    custom,
    JSON.stringify({ servers: { "fd-open-data-mcp": ["read_series", "read"] } }),
  );
  const bridge = fakeBridge();
  const url = await bridge.listen();
  const previous = process.env.CHART_BRIDGE_URL;
  process.env.CHART_BRIDGE_URL = url;
  const second = await loadPlugin({ allowlist: custom });
  try {
    const tool = register(second.mod, {
      schemas: [...ROSTER, { name: "mcp__fd-open-data-mcp__read", description: "read-through", parameters: { type: "object", properties: {} } }],
    });
    const value = await tool.execute({ tool: "mcp__fd-open-data-mcp__read", args: '{"concept_id":"M0_YOY"}' }, { agent: "agent-scope-1" });
    assert.equal(value.ok, true, JSON.stringify(value));
    assert.equal(bridge.received.length, 1);
  } finally {
    if (previous === undefined) delete process.env.CHART_BRIDGE_URL;
    else process.env.CHART_BRIDGE_URL = previous;
    await bridge.close();
    rmSync(second.tmp, { recursive: true, force: true });
  }
});

test("a platform refusal reaches the model as a reason", async () => {
  const bridge = fakeBridge({
    respond: () => ({ status: 404, body: { error: "本轮还没有捕获到图表：先画出 ```echarts 图表，再声明它的数据来源", code: "no_chart_in_turn" } }),
  });
  const url = await bridge.listen();
  const previous = process.env.CHART_BRIDGE_URL;
  process.env.CHART_BRIDGE_URL = url;
  const { mod, tmp } = await loadPlugin({ allowlist: path.join(REPO_ROOT, "chart-replay-allowlist.json") });
  try {
    const tool = register(mod);
    const value = await tool.execute({ tool: "mcp__fd-open-data-mcp__read_series", args: '{"concept_id":"M0_YOY"}' }, { agent: "agent-scope-1" });
    assert.equal(value.ok, false);
    const text = textOf(tool.output.render({}, value));
    assert.match(text, /echarts/);
    assert.match(text, /not recorded/);
  } finally {
    if (previous === undefined) delete process.env.CHART_BRIDGE_URL;
    else process.env.CHART_BRIDGE_URL = previous;
    await bridge.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("writeChartBindPatch lands the plugin, the matcher, the allowlist and the overlay row", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "dsh-home-"));
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    // Re-import with the scratch home so the profile paths resolve there.
    const profile = await import(`../dsh-profile.js?home=${encodeURIComponent(home)}`);
    const patchPath = profile.writeChartBindPatch();
    const patchText = readFileSync(patchPath, "utf8");
    assert.match(patchText, /chart-bind-bridge/);
    assert.match(patchText, /\.\/platform-chart-bind-bridge\.js/);
    const dir = path.dirname(patchPath);
    assert.ok(readFileSync(path.join(dir, "platform-chart-bind-bridge.js"), "utf8").includes("chart_bind"));
    assert.ok(readFileSync(path.join(dir, "tool-discovery.js"), "utf8").length > 0);
    assert.ok(readFileSync(path.join(dir, "chart-replay-allowlist.json"), "utf8").includes("read_series"));
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("the bridge omits the chart-bind flag when no patch exists (a profile without it boots unchanged)", async () => {
  const { patchArgs } = await import("../dsh-bridge.js");
  // A profile without the overlay: the child is spawned with exactly the flags
  // it had before this capability existed.
  assert.deepEqual(patchArgs({ mcpPatchPath: "/tmp/mcp.patch.yml", toolSearchPatchPath: "/tmp/tool-search.patch.yml" }), [
    "--patch",
    "/tmp/mcp.patch.yml",
    "--patch",
    "/tmp/tool-search.patch.yml",
  ]);
  assert.deepEqual(patchArgs({}), []);
  // With it: one more repeatable flag, last in the load order.
  assert.deepEqual(patchArgs({ toolSearchPatchPath: "/tmp/t.patch.yml", chartBindPatchPath: "/tmp/chart-bind.patch.yml" }), [
    "--patch",
    "/tmp/t.patch.yml",
    "--patch",
    "/tmp/chart-bind.patch.yml",
  ]);
  // The load order that matters: permissions after presets (it swaps the preset
  // bridge's row), both bridges last.
  const ordered = patchArgs({
    mcpPatchPath: "m",
    skillsPatchPath: "s",
    presetsPatchPath: "p",
    permissionsPatchPath: "perm",
    toolSearchPatchPath: "ts",
    chartBindPatchPath: "cb",
  });
  assert.deepEqual(ordered.filter((v) => v.startsWith("/") === false), ["--patch", "m", "--patch", "s", "--patch", "p", "--patch", "perm", "--patch", "ts", "--patch", "cb"]);
});