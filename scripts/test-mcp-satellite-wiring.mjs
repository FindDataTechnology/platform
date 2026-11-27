// ── Cell-side wiring for the shared satellite host (2.1) ────────────────────
//
// The decision table this pins:
//   pool off            → no host, and nothing about the patch changes
//   MCP_SATELLITE_HOST=0 → explicit kill switch
//   pool on             → specs come from the COMPOSED PATCH (not a second copy
//                         of the composition logic) and `node` is pinned to our
//                         own binary
//   host fails          → fail open with the reason, caller keeps stdio
//
// Run: node --test scripts/test-mcp-satellite-wiring.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import { satelliteHostAllowedForCell, satelliteSpecsFromPatch, startCellSatelliteHost } from "../server/mcp-satellite-wiring.js";

const quiet = { log() {}, warn() {}, error() {} };

function writePatch(entries) {
  const dir = mkdtempSync(join(tmpdir(), "satellite-wiring-"));
  const file = join(dir, "mcp.patch.yml");
  writeFileSync(file, yaml.dump(entries.map((config) => ({ insert: [{ id: `mcp-${config.serverName}`, name: "@deepseek-ai/dsh-mcp-client", config }] }))));
  return { file, dir };
}

const stdio = (serverName, script) => ({
  serverName,
  transport: "stdio",
  command: "node",
  args: [script],
  cwd: "/app",
});

test("pool off leaves the patch alone", async () => {
  const { file, dir } = writePatch([stdio("fleet", "server/fleet-mcp.js")]);
  try {
    const r = await startCellSatelliteHost({ patchPath: file, poolSize: "0", logger: quiet });
    assert.equal(r.host, null);
    assert.equal(r.url, null);
    assert.match(r.reason, /worker pool off/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("MCP_SATELLITE_HOST=0 is an explicit kill switch even with a pool", async () => {
  const { file, dir } = writePatch([stdio("fleet", "server/fleet-mcp.js")]);
  try {
    const r = await startCellSatelliteHost({ patchPath: file, poolSize: "2", logger: quiet, env: { MCP_SATELLITE_HOST: "0" } });
    assert.equal(r.host, null);
    assert.match(r.reason, /MCP_SATELLITE_HOST=0/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("specs are read from the composed patch, and only for the shareable set", () => {
  const { file, dir } = writePatch([
    stdio("fleet", "server/fleet-mcp.js"),
    stdio("cron", "server/cron-mcp.js"),
    stdio("library", "server/library-mcp.js"), // member-scoped → excluded
    { serverName: "actions", transport: "stdio", command: "node", args: ["server/actions-mcp.js"] }, // session-scoped → excluded
    { serverName: "playwright", transport: "streamable-http", url: "http://127.0.0.1:9310/mcp" }, // already shared → no command
  ]);
  try {
    const specs = satelliteSpecsFromPatch(file);
    assert.deepEqual(specs.map((s) => s.name).sort(), ["cron", "fleet"]);
    const fleet = specs.find((s) => s.name === "fleet");
    assert.equal(fleet.command, process.execPath, "`node` is pinned to our own binary, not PATH");
    assert.deepEqual(fleet.args, ["server/fleet-mcp.js"]);
    assert.equal(fleet.cwd, "/app");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a satellite the rewrite refused is not spawned by the host (2026-11-09 A/B)", () => {
  // bench-proposal in the real fleet keeps its stdio entry because it carries
  // envRefs. From the patch alone it still LOOKS shareable (a shareable name
  // with a command), so the old derivation handed it to the host — which then
  // ran a copy every dsh also spawned. The authority is mcp.shared.json.
  const { file, dir } = writePatch([
    stdio("fleet", "server/fleet-mcp.js"),
    stdio("bench-proposal", "server/bench-proposal-mcp.js"),
  ]);
  try {
    writeFileSync(join(dir, "mcp.shared.json"), JSON.stringify({ sharedSatelliteNames: ["fleet"] }));
    assert.deepEqual(satelliteSpecsFromPatch(file).map((s) => s.name), ["fleet"]);

    // No sidecar (a profile dir written by an older image): declared-list
    // behaviour, so an upgrade does not silently stop sharing.
    rmSync(join(dir, "mcp.shared.json"));
    assert.deepEqual(satelliteSpecsFromPatch(file).map((s) => s.name).sort(), ["bench-proposal", "fleet"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a patch with nothing shareable declines cleanly", async () => {
  const { file, dir } = writePatch([stdio("library", "server/library-mcp.js")]);
  try {
    const r = await startCellSatelliteHost({ patchPath: file, poolSize: "2", logger: quiet, env: {} });
    assert.equal(r.host, null);
    assert.match(r.reason, /no shareable satellites/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unreadable patch declines instead of throwing", async () => {
  const r = await startCellSatelliteHost({ patchPath: "/no/such/patch.yml", poolSize: "1", logger: quiet, env: {} });
  assert.equal(r.host, null);
  assert.match(r.reason, /no shareable satellites/);
});

test("per-cell gray list keeps the rollout to the listed cells", async () => {
  const { file, dir } = writePatch([stdio("fleet", "server/fleet-mcp.js")]);
  try {
    // Unset / "*" → every cell shares.
    assert.equal(satelliteHostAllowedForCell("a@b.c", {}), true);
    assert.equal(satelliteHostAllowedForCell("a@b.c", { MCP_SATELLITE_HOST_CELLS: "*" }), true);
    // Listed → shares; unlisted → keeps its own satellites, and never silently.
    assert.equal(satelliteHostAllowedForCell("a@b.c", { MCP_SATELLITE_HOST_CELLS: "a@b.c,x@y.z" }), true);
    assert.equal(satelliteHostAllowedForCell("other@b.c", { MCP_SATELLITE_HOST_CELLS: "a@b.c" }), false);
    assert.equal(satelliteHostAllowedForCell(null, { MCP_SATELLITE_HOST_CELLS: "a@b.c" }), false);

    const skipped = await startCellSatelliteHost({
      patchPath: file,
      poolSize: "2",
      logger: quiet,
      env: { MCP_SATELLITE_HOST_CELLS: "someone@else.test" },
      cellEmail: "platform-test@findmail.com",
    });
    assert.equal(skipped.host, null);
    assert.match(skipped.reason, /not in MCP_SATELLITE_HOST_CELLS/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
