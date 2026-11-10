// scripts/smoke-browser-lane-shared.mjs — image smoke for the SHARED browser
// lane (slim-browser-lane-footprint, tasks 3.3 + 4.1).
//
// The per-cell smoke (scripts/browser-lane-smoke.mjs) proves the stdio shim
// speaks MCP. This one proves the shape that replaces it on hosted pods:
//
//   1. the service spawns the real pinned @playwright/mcp and a cell session
//      arrives over streamable-http,
//   2. the browser ACTUALLY NAVIGATES (about:blank: no outbound network, but it
//      does require working chromium + system libs — the 2026-10-28 class),
//   3. the screenshot lands inside the CALLING cell's workspace, not a pool,
//   4. two sessions on the one shared process are isolated: a window-scoped
//      marker set by cell A is invisible to cell B, i.e. they are separate
//      browser contexts (cookies and login state ride that same boundary).
//
// Identity is injected here on purpose: the smoke runs outside /proc's cell
// tree (and macOS has no /proc at all), so the real resolver would honestly
// answer "unknown". Peer attribution has its own unit test
// (scripts/test-browser-lane-service.mjs); this gate covers service + browser.
//
// Run inside the image:  node /app/scripts/smoke-browser-lane-shared.mjs
// Exit 0 = navigated, routed, isolated; anything else prints why and exits 1.

import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createBrowserLaneService } from "../server/browser-lane-service.js";

const TIMEOUT_MS = Number(process.env.BROWSER_SMOKE_TIMEOUT_MS) || 180_000;
const CELL_ID = "0123456789abcdef";
const OTHER_CELL_ID = "fedcba9876543210";

const LANE_ABSENT = /@playwright\/mcp is not installed in this deployment/;
const LANE_CLAIMED = Boolean((process.env.BROWSER_MCP_CLI || "").trim());

function fail(msg) {
  if (LANE_ABSENT.test(msg)) {
    if (LANE_CLAIMED) {
      console.error(
        "smoke-browser-lane-shared: FAIL — this image claims the browser lane (BROWSER_MCP_CLI is set) " +
          `but the runtime is missing: ${process.env.BROWSER_MCP_CLI}`,
      );
      process.exit(1);
    }
    console.log("smoke-browser-lane-shared: SKIP — this image declares no browser lane (BROWSER_MCP_CLI unset)");
    process.exit(0);
  }
  console.error(`smoke-browser-lane-shared: FAIL — ${msg}`);
  process.exit(1);
}

const root = mkdtempSync(join(tmpdir(), "browser-lane-shared-smoke-"));
const cellsRoot = join(root, "cells");
const outputRoot = join(root, "shared");
const workspace = join(cellsRoot, CELL_ID, "workspace");

// The injected resolver answers per CONNECT, exactly like the proc resolver
// would for two different peer processes.
let currentCell = CELL_ID;
const service = createBrowserLaneService({
  env: {
    ...process.env,
    BROWSER_SHARED_PORT: String(Number(process.env.BROWSER_SMOKE_PORT || 19310)),
    BROWSER_SHARED_UPSTREAM_PORT: String(Number(process.env.BROWSER_SMOKE_UPSTREAM_PORT || 19311)),
    BROWSER_SHARED_OUTPUT_ROOT: outputRoot,
    AGENT_WORKSPACE: workspace,
  },
  cellsRoot,
  identifyCell: () => ({ cellId: currentCell, attributedVia: "smoke" }),
  logger: console,
});

async function openSessionAs(cellId) {
  currentCell = cellId;
  const client = new Client({ name: `shared-lane-smoke-${cellId.slice(0, 4)}`, version: "0" }, { capabilities: {} });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${service.port}/mcp`)));
  return client;
}

// A loopback page so "login state" is a real cookie, not a window variable:
// /login sets it, /whoami echoes it. Entirely offline (127.0.0.1), which keeps
// the gate runnable in CI with no outbound traffic.
const cookieServer = createServer((req, res) => {
  if (req.url.startsWith("/login")) {
    res.writeHead(200, { "content-type": "text/html", "set-cookie": "lane_cell=AAA; Path=/" });
    res.end("<html><body>logged in</body></html>");
    return;
  }
  res.writeHead(200, { "content-type": "text/html" });
  res.end(`<html><body>cookie=${req.headers.cookie ?? "none"}</body></html>`);
});
await new Promise((r) => cookieServer.listen(0, "127.0.0.1", r));
const cookieBase = `http://127.0.0.1:${cookieServer.address().port}`;

const timeout = setTimeout(() => fail(`TIMEOUT after ${TIMEOUT_MS}ms`), TIMEOUT_MS);

try {
  await service.start();
  const client = await openSessionAs(CELL_ID);

  const tools = await client.listTools();
  const count = Array.isArray(tools?.tools) ? tools.tools.length : -1;
  if (count <= 0) fail("the shared service exposed no tools (upstream never answered tools/list)");

  const nav = await client.callTool(
    { name: "browser_navigate", arguments: { url: "about:blank" } },
    undefined,
    { timeout: 90_000 },
  );
  if (nav?.isError) fail(`browser_navigate(about:blank) failed: ${JSON.stringify(nav).slice(0, 300)}`);

  const shot = await client.callTool(
    { name: "browser_take_screenshot", arguments: { filename: "shared-lane-smoke.png" } },
    undefined,
    { timeout: 90_000 },
  );
  if (shot?.isError) fail(`browser_take_screenshot failed: ${JSON.stringify(shot).slice(0, 300)}`);

  const cellArtifactDir = join(workspace, "browser");
  const landed = existsSync(cellArtifactDir) ? readdirSync(cellArtifactDir) : [];
  if (!landed.some((f) => f.endsWith(".png"))) {
    fail(
      `no screenshot landed in the calling cell's artifact dir (${cellArtifactDir}); ` +
        `shared root has: ${(existsSync(outputRoot) ? readdirSync(outputRoot) : []).join(", ") || "(nothing)"}`,
    );
  }
  const title = nav?.content?.find?.((c) => c.type === "text")?.text ?? "";

  // ── 4.1 isolation sentinel, with a real browser ──────────────────────────
  // Cell A logs into a loopback page (a real cookie). Cell B, on the SAME
  // shared process, must see no cookie. Then A's session ends and a fresh
  // session must start clean — no residue left behind for anyone.
  await client.callTool({ name: "browser_navigate", arguments: { url: `${cookieBase}/login` } }, undefined, {
    timeout: 90_000,
  });
  const sessionB = await openSessionAs(OTHER_CELL_ID);
  try {
    await sessionB.callTool({ name: "browser_navigate", arguments: { url: `${cookieBase}/whoami` } }, undefined, {
      timeout: 90_000,
    });
    const seen = await sessionB.callTool(
      { name: "browser_evaluate", arguments: { function: "() => document.body.innerText" } },
      undefined,
      { timeout: 60_000 },
    );
    const seenText = JSON.stringify(seen?.content ?? seen ?? "").slice(0, 300);
    if (seenText.includes("lane_cell=AAA")) {
      fail(`cross-cell login state leaked: cell B saw cell A's cookie (${seenText})`);
    }

    // ── 4.2 artifact sentinel: each cell's shots stay in its own workspace ──
    const shotB = await sessionB.callTool(
      { name: "browser_take_screenshot", arguments: { filename: "cell-b.png" } },
      undefined,
      { timeout: 90_000 },
    );
    if (shotB?.isError) fail(`cell B screenshot failed: ${JSON.stringify(shotB).slice(0, 200)}`);
    const dirA = join(cellsRoot, CELL_ID, "workspace", "browser");
    const dirB = join(cellsRoot, OTHER_CELL_ID, "workspace", "browser");
    const filesA = existsSync(dirA) ? readdirSync(dirA) : [];
    const filesB = existsSync(dirB) ? readdirSync(dirB) : [];
    if (filesB.some((f) => f === "shared-lane-smoke.png") || filesA.some((f) => f === "cell-b.png")) {
      fail(`artifacts crossed cells: A=${filesA.join(",") || "(none)"} B=${filesB.join(",") || "(none)"}`);
    }
    if (!filesB.includes("cell-b.png")) fail(`cell B's screenshot did not land in its own dir (B=${filesB.join(",")})`);
  } finally {
    await sessionB.close().catch(() => {});
  }

  // Residue check: closing A's session must leave nothing for the next one.
  await client.close();
  const fresh = await openSessionAs(CELL_ID);
  try {
    await fresh.callTool({ name: "browser_navigate", arguments: { url: `${cookieBase}/whoami` } }, undefined, {
      timeout: 90_000,
    });
    const after = await fresh.callTool(
      { name: "browser_evaluate", arguments: { function: "() => document.body.innerText" } },
      undefined,
      { timeout: 60_000 },
    );
    const afterText = JSON.stringify(after?.content ?? after ?? "").slice(0, 300);
    if (afterText.includes("lane_cell=AAA")) {
      fail(`browser state survived the session: a fresh session for the same cell still sees the old cookie (${afterText})`);
    }
  } finally {
    await fresh.close().catch(() => {});
  }
  cookieServer.close();

  console.log(
    `smoke-browser-lane-shared: ok — ${count} tools, navigated about:blank, ` +
      `artifact routed into cell ${CELL_ID} (${landed.length} file(s)), ` +
      `sessions ${CELL_ID} / ${OTHER_CELL_ID} isolated; navigate reply: ${String(title).slice(0, 120)}`,
  );
  clearTimeout(timeout);
  await service.stop();
  process.exit(0);
} catch (err) {
  clearTimeout(timeout);
  await service.stop().catch(() => {});
  fail(err?.message || String(err));
}
