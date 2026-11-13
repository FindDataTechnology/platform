// ── Per-cell MCP satellite host (share-mcp-satellites-per-cell 2.1/2.2/2.3) ──
//
// The host owns ONE copy of the cell's shareable satellites and re-exposes each
// as its own streamable-http endpoint. What these tests pin:
//   - endpoints are per-satellite (server identity must not collapse),
//   - tools/list and tools/call really reach that satellite,
//   - a broken satellite fails open without taking the others down,
//   - stop() leaves no child process behind (the leak class that bit the
//     browser lane).
//
// Run: node --test scripts/test-mcp-satellite-host.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createMcpSatelliteHost } from "../server/mcp-satellite-host.js";

// A minimal stdio MCP satellite: one tool named after SATELLITE_NAME.
function writeSatellite(dir, name) {
  const file = join(dir, `${name}.mjs`);
  writeFileSync(
    file,
    `import { Server } from "${new URL("../node_modules/@modelcontextprotocol/sdk/dist/esm/server/index.js", import.meta.url).href}";
import { StdioServerTransport } from "${new URL("../node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js", import.meta.url).href}";
import { ListToolsRequestSchema, CallToolRequestSchema } from "${new URL("../node_modules/@modelcontextprotocol/sdk/dist/esm/types.js", import.meta.url).href}";
const NAME = ${JSON.stringify(name)};
const s = new Server({ name: NAME, version: "0" }, { capabilities: { tools: {} } });
s.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: NAME + "_tool", description: "from " + NAME, inputSchema: { type: "object" } }] }));
s.setRequestHandler(CallToolRequestSchema, async (r) => ({ content: [{ type: "text", text: NAME + ":" + (r.params.arguments?.x ?? "") }] }));
await s.connect(new StdioServerTransport());
`,
  );
  return { name, command: process.execPath, args: [file], env: process.env };
}

function tmp() {
  return mkdtempSync(join(tmpdir(), "satellite-host-"));
}

async function connect(url) {
  const client = new Client({ name: "probe", version: "0" }, { capabilities: {} });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  return client;
}

test("each satellite keeps its own endpoint and tool identity", async () => {
  const dir = tmp();
  const host = createMcpSatelliteHost({
    satellites: [writeSatellite(dir, "alpha"), writeSatellite(dir, "beta")],
    port: 0,
    logger: { log() {}, warn() {}, error() {} },
  });
  try {
    await host.start();
    const a = await connect(`http://127.0.0.1:${host.port}/alpha/mcp`);
    const b = await connect(`http://127.0.0.1:${host.port}/beta/mcp`);
    const [ta, tb] = [await a.listTools(), await b.listTools()];
    assert.equal(ta.tools[0].name, "alpha_tool", "alpha endpoint must not serve beta's tools");
    assert.equal(tb.tools[0].name, "beta_tool");
    const ra = await a.callTool({ name: "alpha_tool", arguments: { x: "1" } });
    assert.equal(ra.content[0].text, "alpha:1", "tools/call must reach the right satellite");
    await a.close();
    await b.close();
  } finally {
    await host.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 逐请求岗位身份（fix-report-attribution-concurrency 2.1，2026-11-12 修正）─────
//
// 共用卫星读不到调用方的 env，所以成员身份随 patch 的 X-Fleet-* header 进来，
// 由中继逐请求塞进 tools/call 的保留键。这里用一个"回显身份"的卫星把这根线钉住。

function writeEchoIdentitySatellite(dir, name) {
  const file = join(dir, `${name}.mjs`);
  writeFileSync(
    file,
    `import { Server } from "${new URL("../node_modules/@modelcontextprotocol/sdk/dist/esm/server/index.js", import.meta.url).href}";
import { StdioServerTransport } from "${new URL("../node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js", import.meta.url).href}";
import { ListToolsRequestSchema, CallToolRequestSchema } from "${new URL("../node_modules/@modelcontextprotocol/sdk/dist/esm/types.js", import.meta.url).href}";
const s = new Server({ name: "echo", version: "0" }, { capabilities: { tools: {} } });
s.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: "echo", description: "echo identity", inputSchema: { type: "object" } }] }));
s.setRequestHandler(CallToolRequestSchema, async (r) => ({ content: [{ type: "text", text: JSON.stringify(r.params.arguments ?? null) }] }));
await s.connect(new StdioServerTransport());
`,
  );
  return { name, command: process.execPath, args: [file], env: process.env };
}

async function connectWithHeaders(url, headers) {
  const client = new Client({ name: "probe", version: "0" }, { capabilities: {} });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }));
  return client;
}

test("the caller's X-Fleet-* headers reach the satellite as __fleetIdentity", async () => {
  const dir = tmp();
  const host = createMcpSatelliteHost({
    satellites: [writeEchoIdentitySatellite(dir, "identity")],
    port: 0,
    logger: { log() {}, warn() {}, error() {} },
  });
  try {
    await host.start();
    const c = await connectWithHeaders(`http://127.0.0.1:${host.port}/identity/mcp`, {
      "X-Fleet-Fleet-Id": "fleet_9",
      "X-Fleet-Member-Id": "m_9",
      "X-Fleet-Persona": "user.preset-7",
    });
    const r = await c.callTool({ name: "echo", arguments: { x: "1" } });
    const seen = JSON.parse(r.content[0].text);
    assert.deepEqual(seen.__fleetIdentity, { fleetId: "fleet_9", memberId: "m_9", persona: "user.preset-7" });
    assert.equal(seen.x, "1", "普通参数原样透传");
    await c.close();
  } finally {
    await host.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a forged __fleetIdentity in the arguments is stripped (模型改不了归属坐标)", async () => {
  const dir = tmp();
  const host = createMcpSatelliteHost({
    satellites: [writeEchoIdentitySatellite(dir, "identity")],
    port: 0,
    logger: { log() {}, warn() {}, error() {} },
  });
  try {
    await host.start();
    // ① 无 header + 自带伪造键 ⇒ 保留键必须被删掉
    const forge = await connectWithHeaders(`http://127.0.0.1:${host.port}/identity/mcp`, {});
    const r1 = await forge.callTool({ name: "echo", arguments: { __fleetIdentity: { fleetId: "someone", memberId: "else" } } });
    assert.deepEqual(JSON.parse(r1.content[0].text), {}, "没有 header 时不得把调用方自带的坐标转交");
    await forge.close();
    // ② 有 header + 自带伪造键 ⇒ 以 header 为准，伪造值被覆盖
    const real = await connectWithHeaders(`http://127.0.0.1:${host.port}/identity/mcp`, {
      "X-Fleet-Fleet-Id": "fleet_real",
      "X-Fleet-Member-Id": "m_real",
    });
    const r2 = await real.callTool({ name: "echo", arguments: { __fleetIdentity: { fleetId: "someone", memberId: "else" } } });
    assert.deepEqual(JSON.parse(r2.content[0].text).__fleetIdentity, { fleetId: "fleet_real", memberId: "m_real" });
    await real.close();
  } finally {
    await host.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unknown or dead endpoint is a clean 404, not a hang", async () => {
  const dir = tmp();
  const host = createMcpSatelliteHost({
    satellites: [writeSatellite(dir, "only")],
    port: 0,
    logger: { log() {}, warn() {}, error() {} },
  });
  try {
    await host.start();
    const res = await fetch(`http://127.0.0.1:${host.port}/nope/mcp`, { method: "POST" });
    assert.equal(res.status, 404);
  } finally {
    await host.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a satellite that fails to start does not take the others down (fail-open)", async () => {
  const dir = tmp();
  const host = createMcpSatelliteHost({
    satellites: [
      writeSatellite(dir, "good"),
      { name: "broken", command: process.execPath, args: ["-e", "process.exit(1)"], env: process.env },
    ],
    port: 0,
    logger: { log() {}, warn() {}, error() {} },
  });
  try {
    await host.start();
    assert.deepEqual(host.names.sort(), ["broken", "good"]);
    const ok = host.health().satellites.find((s) => s.name === "good");
    const bad = host.health().satellites.find((s) => s.name === "broken");
    assert.equal(ok.up, true, "the healthy satellite is up");
    assert.equal(bad.up, false, "the broken one is reported down, not silently missing");
    const c = await connect(`http://127.0.0.1:${host.port}/good/mcp`);
    assert.equal((await c.listTools()).tools[0].name, "good_tool");
    await c.close();
  } finally {
    await host.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stop() leaves no satellite child behind", async () => {
  const dir = tmp();
  const marker = `satellite-host-proc-${Date.now()}`;
  const file = join(dir, "leaky.mjs");
  writeFileSync(
    file,
    `import { Server } from "${new URL("../node_modules/@modelcontextprotocol/sdk/dist/esm/server/index.js", import.meta.url).href}";
import { StdioServerTransport } from "${new URL("../node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js", import.meta.url).href}";
import { ListToolsRequestSchema } from "${new URL("../node_modules/@modelcontextprotocol/sdk/dist/esm/types.js", import.meta.url).href}";
const s = new Server({ name: "${marker}", version: "0" }, { capabilities: { tools: {} } });
s.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
await s.connect(new StdioServerTransport());
`,
  );
  const host = createMcpSatelliteHost({
    satellites: [{ name: "leaky", command: process.execPath, args: [file, marker], env: process.env }],
    port: 0,
    logger: { log() {}, warn() {}, error() {} },
  });
  const countProcs = () =>
    execFileSync("ps", ["-eo", "args"], { encoding: "utf8" })
      .split("\n")
      .filter((l) => l.includes(file)).length;
  try {
    await host.start();
    assert.equal(countProcs(), 1, "the satellite is running");
  } finally {
    await host.stop();
    rmSync(dir, { recursive: true, force: true });
  }
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(countProcs(), 0, "stop() must not orphan the child");
});

// ── 2.4 failure domain: a dead satellite degrades ITS tools only ───────────
// The spec promise is "该 cell 的 MCP 工具变灰、其它 cell 不受影响、恢复后自动可用".
// At host level that means: one satellite dying must not take its neighbour
// down, must fail fast (not hang), and must come back when restarted.
test("one satellite dying leaves its neighbour serving (failure domain)", async () => {
  const dir = tmp();
  const host = createMcpSatelliteHost({
    satellites: [writeSatellite(dir, "keep"), writeSatellite(dir, "dies")],
    port: 0,
    logger: { log() {}, warn() {}, error() {} },
  });
  try {
    await host.start();
    const keep = await connect(`http://127.0.0.1:${host.port}/keep/mcp`);
    assert.equal((await keep.listTools()).tools[0].name, "keep_tool");

    // Kill only the "dies" child.
    const died = execFileSync("ps", ["-eo", "pid=,args="], { encoding: "utf8" })
      .split("\n")
      .find((l) => l.includes(join(dir, "dies.mjs")));
    assert.ok(died, "the dies satellite is running");
    process.kill(Number(died.trim().split(/\s+/)[0]), "SIGKILL");
    await new Promise((r) => setTimeout(r, 400));

    // The neighbour still serves.
    assert.equal((await keep.listTools()).tools[0].name, "keep_tool", "a neighbour's death must not take this one down");
    // The dead one fails fast with a clear reason, not a hang. streamable-http
    // answers 200 with a JSON-RPC error inside an SSE frame (measured), so the
    // body — not the status code — is what carries the failure.
    const t0 = Date.now();
    const deadRes = await fetch(`http://127.0.0.1:${host.port}/dies/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    const deadBody = await deadRes.text();
    assert.ok(Date.now() - t0 < 5000, "a dead satellite must fail fast");
    assert.match(deadBody, /"error"/, `the endpoint reports a failure (status ${deadRes.status}): ${deadBody.slice(0, 120)}`);
    assert.match(deadBody, /not running|Not connected/i, "the reason must be legible, not generic silence");
    // And the health face must stop claiming it is up.
    const health = host.health();
    assert.equal(health.satellites.find((x) => x.name === "dies").up, false, "a corpse must not read as up");
    assert.equal(health.satellites.find((x) => x.name === "keep").up, true);
    await keep.close();
  } finally {
    await host.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
