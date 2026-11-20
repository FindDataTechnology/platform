// ── Shared browser lane: service + proxy contract tests ─────────────────────
//
// slim-browser-lane-footprint tasks 1.1, 1.3, 1.4, 1.5 and the CI sentinels
// 4.1/4.2 — driven against a DUMMY upstream MCP that speaks SSE exactly like
// @playwright/mcp --port does, so the frontend's translation, its per-session
// upstream sessions, its identity resolution and its artifact routing are all
// exercised without a browser in CI.
//
// What a dummy cannot prove is browser-state isolation itself (two logins not
// seeing each other): that needs a real chromium and lives in the image smoke
// (task 3.3). What this file DOES prove is the mechanism isolation rests on —
// one upstream session per cell, every session on the same process, artifacts
// landing only inside the calling cell's workspace — plus that a forged
// identity in the request is ignored.
//
// Run: node --test scripts/test-browser-lane-service.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readdirSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { createBrowserLaneService } from "../server/browser-lane-service.js";
import { resolvePeerCell } from "../lib/browser-lane-identity.js";
import { rewriteArtifactArgs, safeArtifactName } from "../lib/browser-lane-artifacts.js";

const CELL_A = "aaaaaaaaaaaaaaaa";
const CELL_B = "bbbbbbbbbbbbbbbb";

// ── dummy upstream: same wire shape as @playwright/mcp --port (SSE) ─────────
async function startSseUpstream({ sharedDir }) {
  const state = { sessions: [], calls: [], cancellations: [] };
  const transports = new Map();
  const httpServer = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/sse") {
      const transport = new SSEServerTransport("/messages", res);
      transports.set(transport.sessionId, transport);
      state.sessions.push(transport.sessionId);
      const mcp = new Server({ name: "dummy-playwright", version: "0.0.0" }, { capabilities: { tools: {} } });
      mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [
          { name: "echo", description: `session=${transport.sessionId}`, inputSchema: { type: "object" } },
          { name: "slow", description: "long operation with progress", inputSchema: { type: "object" } },
          { name: "boom", description: "always fails", inputSchema: { type: "object" } },
          { name: "snap", description: "writes an artifact", inputSchema: { type: "object" } },
        ],
      }));
      mcp.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
        const { name, arguments: args = {} } = request.params;
        state.calls.push({ sessionId: transport.sessionId, name, args });
        if (name === "echo") return { content: [{ type: "text", text: `echo:${args.text ?? ""}` }] };
        if (name === "boom") throw new McpError(ErrorCode.InvalidParams, "boom: bad arguments", { detail: 42 });
        if (name === "slow") {
          const token = request.params._meta?.progressToken;
          if (token != null) {
            await extra.sendNotification({
              method: "notifications/progress",
              params: { progressToken: token, progress: 1, total: 2, message: "step 1" },
            });
          }
          const aborted = await new Promise((resolve) => {
            const t = setTimeout(() => resolve(false), Number(args.ms ?? 1000));
            extra.signal.addEventListener("abort", () => {
              clearTimeout(t);
              state.cancellations.push({ sessionId: transport.sessionId, name, at: Date.now() });
              resolve(true);
            });
          });
          if (aborted) throw new McpError(ErrorCode.InvalidRequest, "cancelled by caller");
          return { content: [{ type: "text", text: "slow:done" }] };
        }
        if (name === "snap") {
          const target =
            args.filename ||
            join(sharedDir, `auto-${Date.now()}-${Math.random().toString(16).slice(2)}.png`);
          mkdirSync(join(target, ".."), { recursive: true });
          writeFileSync(target, "PNG");
          return { content: [{ type: "text", text: `saved:${target}` }] };
        }
        throw new McpError(ErrorCode.MethodNotFound, `unknown tool ${name}`);
      });
      res.on("close", () => {
        transports.delete(transport.sessionId);
        transport.close();
      });
      await mcp.connect(transport);
      return;
    }
    if (req.method === "POST" && url.pathname === "/messages") {
      const transport = transports.get(url.searchParams.get("sessionId"));
      let body = "";
      for await (const chunk of req) body += chunk;
      if (!transport) {
        res.writeHead(404).end();
        return;
      }
      await transport.handlePostMessage(req, res, body ? JSON.parse(body) : undefined);
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const port = httpServer.address().port;
  return {
    url: `http://127.0.0.1:${port}`,
    state,
    async stop() {
      await new Promise((r) => httpServer.close(r));
    },
  };
}

function freePort() {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

async function startFrontend({ upstreamUrl, sharedDir, identifyCell, extraEnv = null }) {
  const port = await freePort();
  const service = createBrowserLaneService({
    env: {
      ...process.env,
      BROWSER_SHARED_PORT: String(port),
      BROWSER_SHARED_UPSTREAM_URL: upstreamUrl,
      BROWSER_SHARED_OUTPUT_ROOT: sharedDir,
      ...(extraEnv ?? {}),
    },
    cellsRoot: join(sharedDir, "cells"),
    identifyCell,
    logger: { log() {}, warn() {}, error() {} },
  });
  await service.start();
  return { service, port, url: `http://127.0.0.1:${port}/mcp` };
}

async function connectClient(url, extraHeaders = null) {
  const client = new Client({ name: "cell-client", version: "0.0.0" }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    ...(extraHeaders ? { requestInit: { headers: extraHeaders } } : {}),
  });
  await client.connect(transport);
  return { client, transport };
}

function makeCellsRoot() {
  const root = mkdtempSync(join(tmpdir(), "browser-lane-cells-"));
  for (const cellId of [CELL_A, CELL_B]) {
    mkdirSync(join(root, cellId, "workspace"), { recursive: true });
    mkdirSync(join(root, cellId, "runtime"), { recursive: true });
  }
  return root;
}

// ── 1.1: one service, per-session upstream sessions, independent tools/list ──
test("1.1 two cell sessions share one service but never one upstream session", async () => {
  const sharedDir = mkdtempSync(join(tmpdir(), "browser-lane-shared-"));
  const upstream = await startSseUpstream({ sharedDir });
  const frontend = await startFrontend({
    upstreamUrl: upstream.url,
    sharedDir,
    identifyCell: () => ({ cellId: CELL_A, attributedVia: "test" }),
  });
  try {
    const a = await connectClient(frontend.url);
    const b = await connectClient(frontend.url);
    const toolsA = await a.client.listTools();
    const toolsB = await b.client.listTools();
    const sessionA = toolsA.tools.find((t) => t.name === "echo").description;
    const sessionB = toolsB.tools.find((t) => t.name === "echo").description;
    assert.notEqual(sessionA, sessionB, "each cell session must own its upstream session");
    assert.equal(upstream.state.sessions.length, 2, "one upstream SSE session per cell session");
    const health = frontend.service.healthSnapshot();
    assert.equal(health.sessions, 2, "frontend tracks both cell sessions");
    await a.client.close();
    await b.client.close();
  } finally {
    await frontend.service.stop();
    await upstream.stop();
  }
});

// ── 1.3: forwarding fidelity — normal / long / progress / cancel / error code ─
test("1.3 tools/call forwards normal results verbatim", async () => {
  const sharedDir = mkdtempSync(join(tmpdir(), "browser-lane-shared-"));
  const upstream = await startSseUpstream({ sharedDir });
  const frontend = await startFrontend({
    upstreamUrl: upstream.url,
    sharedDir,
    identifyCell: () => ({ cellId: CELL_A, attributedVia: "test" }),
  });
  try {
    const { client } = await connectClient(frontend.url);
    const res = await client.callTool({ name: "echo", arguments: { text: "hi" } });
    assert.equal(res.content[0].text, "echo:hi");
    await client.close();
  } finally {
    await frontend.service.stop();
    await upstream.stop();
  }
});

test("1.3 a long operation completes and relays progress", async () => {
  const sharedDir = mkdtempSync(join(tmpdir(), "browser-lane-shared-"));
  const upstream = await startSseUpstream({ sharedDir });
  const frontend = await startFrontend({
    upstreamUrl: upstream.url,
    sharedDir,
    identifyCell: () => ({ cellId: CELL_A, attributedVia: "test" }),
  });
  try {
    const { client } = await connectClient(frontend.url);
    const progress = [];
    const res = await client.callTool({ name: "slow", arguments: { ms: 1200 } }, undefined, {
      onprogress: (p) => progress.push(p),
      timeout: 20000,
    });
    assert.equal(res.content[0].text, "slow:done");
    assert.ok(progress.length >= 1, "upstream progress must reach the cell");
    assert.equal(progress[0].progress, 1);
    await client.close();
  } finally {
    await frontend.service.stop();
    await upstream.stop();
  }
});

test("1.3 cancelling downstream cancels the upstream session's call", async () => {
  const sharedDir = mkdtempSync(join(tmpdir(), "browser-lane-shared-"));
  const upstream = await startSseUpstream({ sharedDir });
  const frontend = await startFrontend({
    upstreamUrl: upstream.url,
    sharedDir,
    identifyCell: () => ({ cellId: CELL_A, attributedVia: "test" }),
  });
  try {
    const { client } = await connectClient(frontend.url);
    const controller = new AbortController();
    const pending = client
      .callTool({ name: "slow", arguments: { ms: 5000 } }, undefined, {
        signal: controller.signal,
        timeout: 30000,
      })
      .catch((err) => err);
    await new Promise((r) => setTimeout(r, 300));
    controller.abort();
    await pending;
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(
      upstream.state.cancellations.length >= 1,
      "the upstream must observe the cancellation, not just the downstream caller",
    );
    await client.close();
  } finally {
    await frontend.service.stop();
    await upstream.stop();
  }
});

test("1.3 upstream error codes pass through unchanged", async () => {
  const sharedDir = mkdtempSync(join(tmpdir(), "browser-lane-shared-"));
  const upstream = await startSseUpstream({ sharedDir });
  const frontend = await startFrontend({
    upstreamUrl: upstream.url,
    sharedDir,
    identifyCell: () => ({ cellId: CELL_A, attributedVia: "test" }),
  });
  try {
    const { client } = await connectClient(frontend.url);
    const err = await client.callTool({ name: "boom", arguments: {} }).then(
      () => null,
      (e) => e,
    );
    assert.ok(err, "the call must fail");
    assert.ok(err instanceof McpError, `expected McpError, got ${err?.constructor?.name}`);
    assert.equal(err.code, ErrorCode.InvalidParams, "the upstream code must survive the hop");
    assert.match(err.message, /boom: bad arguments/);
    assert.deepEqual(err.data, { detail: 42 }, "structured error data must survive too");
    await client.close();
  } finally {
    await frontend.service.stop();
    await upstream.stop();
  }
});

// ── 1.4: identity comes from the deployment, not from the caller ─────────────
test("1.4 a forged cell claim in the request is ignored", async () => {
  const sharedDir = mkdtempSync(join(tmpdir(), "browser-lane-shared-"));
  const upstream = await startSseUpstream({ sharedDir });
  const identity = { cellId: CELL_A, attributedVia: "proc:cwd" };
  const frontend = await startFrontend({
    upstreamUrl: upstream.url,
    sharedDir,
    identifyCell: () => identity,
  });
  try {
    // Claim cell B in the URL and in headers — the resolver's answer wins.
    const { client } = await connectClient(
      `${frontend.url}?cell=${CELL_B}`,
      { "x-cell-id": CELL_B, "x-browser-cell": CELL_B },
    );
    const res = await client.callTool({ name: "snap", arguments: { filename: "forged.png" } });
    assert.match(res.content[0].text, /saved:/);
    const session = [...frontend.service.sessions.values()][0];
    assert.equal(session.cellId, CELL_A, "the real cell wins over the claimed one");
    assert.equal(session.artifactDir, join(sharedDir, "cells", CELL_A, "workspace", "browser"));
    assert.equal(existsSync(join(sharedDir, "cells", CELL_B, "workspace", "browser")), false);
    await client.close();
  } finally {
    await frontend.service.stop();
    await upstream.stop();
  }
});

// The proc-side resolver itself, against a fake /proc tree.
test("1.4 peer resolution reads the connection's process, incl. one ancestor hop", () => {
  const cellsRoot = makeCellsRoot();
  const fakeProc = mkdtempSync(join(tmpdir(), "browser-lane-proc-"));
  const netRoot = join(fakeProc, "net");
  mkdirSync(netRoot, { recursive: true });
  // Peer client socket: local port 40001, remote port 9310, inode 777, ESTABLISHED.
  const hex = (n) => n.toString(16).toUpperCase().padStart(4, "0");
  writeFileSync(
    join(netRoot, "tcp"),
    [
      "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
      `   0: 0100007F:${hex(40001)} 0100007F:${hex(9310)} 01 00000000:00000000 00:00000000 00000000  1000        0 777 1`,
    ].join("\n"),
  );
  // The connecting dsh child has no clue of its own; its parent (the cell
  // server) carries the cell root in its cwd — one ancestor hop.
  const childPid = join(fakeProc, "5151");
  mkdirSync(join(childPid, "fd"), { recursive: true });
  writeFileSync(join(childPid, "cmdline"), "node\0/app/dsh.js\0");
  symlinkSync("/app", join(childPid, "cwd"));
  writeFileSync(join(childPid, "stat"), "5151 (node) S 4242 5151 5151 0 -1");
  symlinkSync("socket:[777]", join(childPid, "fd", "7"));
  const parentPid = join(fakeProc, "4242");
  mkdirSync(parentPid, { recursive: true });
  writeFileSync(join(parentPid, "cmdline"), "node\0/app/server.js\0");
  symlinkSync(join(cellsRoot, CELL_A, "runtime"), join(parentPid, "cwd"));
  writeFileSync(join(parentPid, "stat"), "4242 (node) S 1 4242 4242 0 -1");

  const resolved = resolvePeerCell({
    socket: { remotePort: 40001, localPort: 9310 },
    procRoot: fakeProc,
    netRoot,
    cellsRoot,
  });
  assert.equal(resolved.cellId, CELL_A);
  assert.equal(resolved.pid, 5151);
  assert.match(resolved.attributedVia, /^ancestor:1/);
  assert.equal(resolved.workspaceDir, join(cellsRoot, CELL_A, "workspace"));

  // An unrelated port pair resolves to nobody — no guessing, no default cell.
  const miss = resolvePeerCell({
    socket: { remotePort: 40002, localPort: 9310 },
    procRoot: fakeProc,
    netRoot,
    cellsRoot,
  });
  assert.equal(miss.cellId, null);
});

// ── 1.5 / 4.2: artifacts land in the calling cell, invisible to the other ────
test("1.5 + 4.2 screenshots land in the calling cell's workspace and not the other's", async () => {
  const sharedDir = mkdtempSync(join(tmpdir(), "browser-lane-shared-"));
  const cellsRoot = join(sharedDir, "cells");
  for (const cellId of [CELL_A, CELL_B]) {
    mkdirSync(join(cellsRoot, cellId, "workspace"), { recursive: true });
  }
  const upstream = await startSseUpstream({ sharedDir });
  // Two frontends would be two services; here one service serves both cells and
  // the identity differs per connect — emulate by a mutable resolver.
  let current = CELL_A;
  const frontend = await startFrontend({
    upstreamUrl: upstream.url,
    sharedDir,
    identifyCell: () => ({ cellId: current, attributedVia: "test" }),
  });
  try {
    const a = await connectClient(frontend.url);
    await a.client.callTool({ name: "snap", arguments: { filename: "cell-a.png" } });
    // Unnamed artifact: the dummy writes it into the shared root, the frontend
    // sweeps it into the caller's dir.
    await a.client.callTool({ name: "snap", arguments: {} });
    current = CELL_B;
    const b = await connectClient(frontend.url);
    await b.client.callTool({ name: "snap", arguments: { filename: "cell-b.png" } });

    const dirA = join(cellsRoot, CELL_A, "workspace", "browser");
    const dirB = join(cellsRoot, CELL_B, "workspace", "browser");
    const filesA = readdirSync(dirA).sort();
    const filesB = readdirSync(dirB).sort();
    assert.ok(filesA.includes("cell-a.png"), `cell A dir must hold its named shot, has ${filesA}`);
    assert.ok(filesB.includes("cell-b.png"), `cell B dir must hold its named shot, has ${filesB}`);
    assert.ok(
      filesA.some((f) => f.startsWith("auto-")),
      `the unnamed shot must be adopted by the calling cell, has ${filesA}`,
    );
    // 4.2 sentinel: neither cell can enumerate the other's artifacts.
    assert.equal(filesB.some((f) => f.startsWith("cell-a")), false);
    assert.equal(filesA.some((f) => f.startsWith("cell-b")), false);
    assert.equal(readdirSync(sharedDir).some((f) => f.endsWith(".png")), false, "nothing left in the shared root");
    await a.client.close();
    await b.client.close();
  } finally {
    await frontend.service.stop();
    await upstream.stop();
  }
});

test("1.5 a filename with path segments cannot escape the cell dir", () => {
  const dir = "/data/cells/aaaaaaaaaaaaaaaa/workspace/browser";
  const { args } = rewriteArtifactArgs({ filename: "../../other-cell/leak.png", saveAs: "/etc/passwd" }, dir);
  assert.equal(args.filename, join(dir, "leak.png"));
  assert.equal(args.saveAs, join(dir, "passwd"));
  assert.equal(safeArtifactName("../.."), null);
  // Upload paths are inputs, never rewritten.
  const uploads = rewriteArtifactArgs({ paths: ["/tmp/some.pdf"] }, dir);
  assert.deepEqual(uploads.args, { paths: ["/tmp/some.pdf"] });
});

// ── Session retirement (a dsh client never sends DELETE) ────────────────────
// The MCP client dsh ships defines terminateSession() but never calls it: its
// teardown only closes the transport locally. Without this reaper every cell
// restart leaves a session + browser context alive in the shared pod forever.
test("idle sessions are retired so a reconnecting cell cannot leak contexts", async () => {
  const sharedDir = mkdtempSync(join(tmpdir(), "browser-lane-idle-"));
  const upstream = await startSseUpstream({ sharedDir });
  const frontend = await startFrontend({
    upstreamUrl: upstream.url,
    sharedDir,
    identifyCell: () => ({ cellId: CELL_A, attributedVia: "test" }),
    extraEnv: { BROWSER_SHARED_SESSION_IDLE_MS: "400", BROWSER_SHARED_SESSION_SWEEP_MS: "100" },
  });
  try {
    const a = await connectClient(frontend.url);
    await a.client.callTool({ name: "echo", arguments: { text: "x" } });
    assert.equal(frontend.service.sessions.size, 1, "the session is live while in use");
    // Close only locally — exactly what dsh does (no DELETE reaches the server).
    await a.transport.close();
    assert.equal(frontend.service.sessions.size, 1, "a local close alone leaves the session registered");
    await new Promise((r) => setTimeout(r, 900));
    assert.equal(frontend.service.sessions.size, 0, "the reaper retires it without client cooperation");
  } finally {
    await frontend.service.stop();
    await upstream.stop();
  }
});

test("an actively used session is never reaped", async () => {
  const sharedDir = mkdtempSync(join(tmpdir(), "browser-lane-busy-"));
  const upstream = await startSseUpstream({ sharedDir });
  const frontend = await startFrontend({
    upstreamUrl: upstream.url,
    sharedDir,
    identifyCell: () => ({ cellId: CELL_A, attributedVia: "test" }),
    extraEnv: { BROWSER_SHARED_SESSION_IDLE_MS: "400", BROWSER_SHARED_SESSION_SWEEP_MS: "100" },
  });
  try {
    const a = await connectClient(frontend.url);
    for (let i = 0; i < 5; i += 1) {
      await a.client.callTool({ name: "echo", arguments: { text: String(i) } });
      await new Promise((r) => setTimeout(r, 150));
    }
    assert.equal(frontend.service.sessions.size, 1, "activity keeps the session alive");
    await a.client.close();
  } finally {
    await frontend.service.stop();
    await upstream.stop();
  }
});
