// Unit tests — the browser lane supply gate in dsh-profile.writeMcpPatch
// (add-browser-use-lane, design D2). The lane's patch entry must resolve one of
// three deployment shapes at patch-write time:
//
//   local   BROWSER_RUNTIME_PATH names an EXISTING directory → entry composed
//   remote  BROWSER_CDP_ENDPOINT set (no local runtime needed) → entry composed
//   absent  neither (or BROWSER_LANE=off, which vetoes both) → entry OMITTED,
//           info-logged as a silent normal state
//
// The gate rides the MERGED server map, so this test drives it through the
// operator layer (mcp.json) exactly like a deployment would.
//
// Run: node --test scripts/test-browser-lane-gate.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import { pathToFileURL } from "node:url";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const LANE_ENTRY = {
  command: "node",
  args: ["server/browser-mcp.js"],
  laneGate: "browser",
};

function makeHome() {
  const home = mkdtempSync(join(tmpdir(), "browser-lane-gate-"));
  mkdirSync(join(home, "profiles", "platform"), { recursive: true });
  writeFileSync(
    join(home, "mcp.json"),
    JSON.stringify({ mcpServers: { playwright: LANE_ENTRY } }, null, 2),
  );
  return home;
}

// Each case imports dsh-profile.js fresh with its own env domain: the module
// resolves MCP_PATCH_PATH and MCP_CONFIG_PATH at import time.
async function patchEntries(home, { workspace = null, ownerEmail = null } = {}) {
  const mod = await import(`${pathToFileURL(join(REPO_ROOT, "dsh-profile.js")).href}?case=${Date.now()}-${Math.random()}`);
  await mod.writeMcpPatch({ workspace, ownerEmail });
  const patchPath = join(home, "profiles", "platform", "mcp.patch.yml");
  // Zero composed servers → the writer emits no patch file at all; "no entry"
  // and "no file" are the same omission from the lane's point of view.
  let raw;
  try {
    raw = readFileSync(patchPath, "utf8");
  } catch {
    return [];
  }
  const rows = yaml.load(raw) ?? [];
  return rows.filter((row) => row?.insert).flatMap((row) => row.insert);
}

async function withEnv(home, env, fn) {
  const saved = {};
  for (const key of ["DSH_HOME", "MCP_CONFIG_PATH", "DB_PATH", "BROWSER_LANE", "BROWSER_SHARED_MCP_URL", "BROWSER_SHARED_CELLS", "BROWSER_OUTPUT_DIR", "AGENT_WORKSPACE", "BROWSER_RUNTIME_PATH", "BROWSER_CDP_ENDPOINT", "BROWSER_MCP_CLI", "BROWSER_CHROMIUM_PATH"]) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  process.env.DSH_HOME = home;
  process.env.MCP_CONFIG_PATH = join(home, "mcp.json");
  process.env.DB_PATH = join(home, "app.db");
  Object.assign(process.env, env);
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("absent: no runtime and no endpoint omits the lane", async () => {
  const home = makeHome();
  const rows = await withEnv(home, {}, () => patchEntries(home));
  assert.equal(rows.some((r) => r.id === "mcp-playwright"), false, "lane must be omitted without a browser supply");
});

test("local: an existing runtime path composes the lane", async () => {
  const home = makeHome();
  const rows = await withEnv(home, { BROWSER_RUNTIME_PATH: home }, () => patchEntries(home));
  const row = rows.find((r) => r.id === "mcp-playwright");
  assert.ok(row, "lane must compose when BROWSER_RUNTIME_PATH exists");
  assert.equal(row.name, "@deepseek-ai/dsh-mcp-client");
  assert.equal(row.config?.serverName, "playwright");
});

test("local: a stale runtime path (does not exist) still omits the lane", async () => {
  const home = makeHome();
  const rows = await withEnv(home, { BROWSER_RUNTIME_PATH: join(home, "no-such-dir") }, () => patchEntries(home));
  assert.equal(rows.some((r) => r.id === "mcp-playwright"), false, "a path that does not exist is not a supply");
});

test("remote: a CDP endpoint composes the lane without a local runtime", async () => {
  const home = makeHome();
  const rows = await withEnv(home, { BROWSER_CDP_ENDPOINT: "http://127.0.0.1:9222" }, () => patchEntries(home));
  assert.ok(rows.find((r) => r.id === "mcp-playwright"), "lane must compose for a remote endpoint");
});

test("desktop opt-in: an installed BROWSER_MCP_CLI file alone supplies the lane", async () => {
  const home = makeHome();
  const cli = join(home, "fake-playwright-mcp-cli.js");
  writeFileSync(cli, "// stand-in for @playwright/mcp/cli.js\n");
  const rows = await withEnv(home, { BROWSER_MCP_CLI: cli }, () => patchEntries(home));
  assert.ok(rows.find((r) => r.id === "mcp-playwright"), "a present CLI file is the desktop opt-in's supply evidence");
});

test("desktop opt-in: a BROWSER_MCP_CLI path that does not exist omits the lane", async () => {
  const home = makeHome();
  const rows = await withEnv(home, { BROWSER_MCP_CLI: join(home, "no-such-cli.js") }, () => patchEntries(home));
  assert.equal(rows.some((r) => r.id === "mcp-playwright"), false, "a missing CLI file is not a supply");
});

test("off: BROWSER_LANE=off vetoes both supply forms", async () => {
  const home = makeHome();
  const rows = await withEnv(
    home,
    { BROWSER_LANE: "off", BROWSER_RUNTIME_PATH: home, BROWSER_CDP_ENDPOINT: "http://127.0.0.1:9222" },
    () => patchEntries(home),
  );
  assert.equal(rows.some((r) => r.id === "mcp-playwright"), false, "explicit off must win over supply");
});
// ── Shared-endpoint shape (slim-browser-lane-footprint 2.1 / 2.3 / 2.4) ─────

test("shared: BROWSER_SHARED_MCP_URL alone composes a streamable-http entry", async () => {
  const home = makeHome();
  const url = "http://127.0.0.1:9310/mcp";
  // No runtime, no endpoint, no CLI: a pod-level service needs none of them.
  const rows = await withEnv(home, { BROWSER_SHARED_MCP_URL: url }, () => patchEntries(home));
  const row = rows.find((r) => r.id === "mcp-playwright");
  assert.ok(row, "the shared endpoint alone must supply the lane");
  assert.equal(row.config.transport, "streamable-http");
  assert.equal(row.config.url, url);
  assert.equal(row.config.command, undefined, "no stdio command in the shared shape");
  assert.equal(row.config.args, undefined, "no per-cell launcher args in the shared shape");
  assert.equal(row.config.cwd, undefined, "no spawn cwd to pin");
  assert.equal(row.config.env, undefined, "no BROWSER_OUTPUT_DIR injection — the service routes artifacts");
});

test("shared: BROWSER_LANE=off still vetoes the entry", async () => {
  const home = makeHome();
  const rows = await withEnv(
    home,
    { BROWSER_SHARED_MCP_URL: "http://127.0.0.1:9310/mcp", BROWSER_LANE: "off" },
    () => patchEntries(home),
  );
  assert.equal(rows.some((r) => r.id === "mcp-playwright"), false, "the kill switch must win over a shared endpoint");
});

test("shared: an UNREACHABLE endpoint still writes the url and never a stdio fallback", async () => {
  const home = makeHome();
  // Nothing listens on this port: the shared lane degrades (tools grey out) but
  // the patch must not grow a per-cell playwright (design D6).
  const rows = await withEnv(home, { BROWSER_SHARED_MCP_URL: "http://127.0.0.1:1/mcp" }, () =>
    patchEntries(home),
  );
  const row = rows.find((r) => r.id === "mcp-playwright");
  assert.ok(row, "an unreachable shared endpoint keeps the (degraded) entry");
  assert.equal(row.config.transport, "streamable-http");
  assert.equal(row.config.command, undefined, "no local playwright fallback");
});

test("no shared endpoint: the stdio lane is byte-identical to the pre-change shape", async () => {
  const home = makeHome();
  const workspace = join(home, "workspace");
  mkdirSync(workspace, { recursive: true });
  const rows = await withEnv(home, { BROWSER_RUNTIME_PATH: home }, () =>
    patchEntries(home, { workspace }),
  );
  const row = rows.find((r) => r.id === "mcp-playwright");
  assert.deepEqual(row.config, {
    serverName: "playwright",
    failOnStartupError: false,
    transport: "stdio",
    command: "node",
    args: ["server/browser-mcp.js"],
    env: { BROWSER_OUTPUT_DIR: workspace },
    cwd: REPO_ROOT,
  });
});

// ── Gray rollout switch (BROWSER_SHARED_CELLS) ──────────────────────────────

test("gray: a listed cell takes the shared shape, an unlisted one keeps the per-cell shape", async () => {
  const home = makeHome();
  const url = "http://127.0.0.1:9310/mcp";
  const workspace = join(home, "workspace");
  mkdirSync(workspace, { recursive: true });
  const env = {
    BROWSER_SHARED_MCP_URL: url,
    BROWSER_SHARED_CELLS: "tester@example.com",
    BROWSER_RUNTIME_PATH: home, // the unlisted cell still has a local supply
  };

  const listed = await withEnv(home, env, () =>
    patchEntries(home, { workspace, ownerEmail: "tester@example.com" }),
  );
  const listedRow = listed.find((r) => r.id === "mcp-playwright");
  assert.equal(listedRow.config.transport, "streamable-http", "the gray cell rides the shared service");
  assert.equal(listedRow.config.command, undefined);

  const other = await withEnv(home, env, () =>
    patchEntries(home, { workspace, ownerEmail: "someone-else@example.com" }),
  );
  const otherRow = other.find((r) => r.id === "mcp-playwright");
  assert.equal(otherRow.config.transport, "stdio", "an unlisted cell keeps its own browser process");
  assert.equal(otherRow.config.command, "node", "no cell loses the lane during a gray rollout");
});

test("gray: '*' (and unset) means every cell shares", async () => {
  const home = makeHome();
  const url = "http://127.0.0.1:9310/mcp";
  for (const value of ["*", ""]) {
    const rows = await withEnv(home, { BROWSER_SHARED_MCP_URL: url, BROWSER_SHARED_CELLS: value }, () =>
      patchEntries(home, { ownerEmail: "anyone@example.com" }),
    );
    const row = rows.find((r) => r.id === "mcp-playwright");
    assert.equal(row.config.transport, "streamable-http", `BROWSER_SHARED_CELLS="${value}" shares for all`);
  }
});
