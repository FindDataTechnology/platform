// ── Shared MCP satellites: patch gate + membership safety (2.1/2.2/3.0) ─────
//
// Two things must hold:
//   1. With MCP_SATELLITE_HOST_URL set, the shareable servers become `url`
//      entries (no command) and everything else stays byte-identical stdio.
//   2. The shareable list itself must not contain a member-scoped satellite.
//      That is asserted against the satellites' REAL env reads, so a future
//      server that starts reading a member token cannot be added silently.
//
// Run: node --test scripts/test-mcp-satellite-sharing.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { pathToFileURL } from "node:url";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// A cell-shaped mcp.json: two shareable servers plus three that must stay
// per-runtime for different reasons.
const ENTRIES = {
  fleet: { command: "node", args: ["server/fleet-mcp.js"] },
  cron: { command: "node", args: ["server/cron-mcp.js"] },
  library: { command: "node", args: ["server/library-mcp.js"] },
  websearch: { command: "node", args: ["server/websearch-mcp.js"] },
  actions: { command: "node", args: ["server/actions-mcp.js"] },
};

function makeHome() {
  const home = mkdtempSync(join(tmpdir(), "satellite-sharing-"));
  mkdirSync(join(home, "profiles", "platform"), { recursive: true });
  writeFileSync(join(home, "mcp.json"), JSON.stringify({ mcpServers: ENTRIES }, null, 2));
  return home;
}

async function patchRows(home) {
  const mod = await import(`${pathToFileURL(join(REPO_ROOT, "dsh-profile.js")).href}?case=${Date.now()}-${Math.random()}`);
  await mod.writeMcpPatch({});
  let raw;
  try {
    raw = readFileSync(join(home, "profiles", "platform", "mcp.patch.yml"), "utf8");
  } catch {
    return [];
  }
  return (yaml.load(raw) ?? []).filter((r) => r?.insert).flatMap((r) => r.insert);
}

async function withEnv(home, env, fn) {
  const keys = ["DSH_HOME", "MCP_CONFIG_PATH", "DB_PATH", "MCP_SATELLITE_HOST_URL", "BROWSER_LANE", "BROWSER_SHARED_MCP_URL"];
  const saved = {};
  for (const k of keys) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.DSH_HOME = home;
  process.env.MCP_CONFIG_PATH = join(home, "mcp.json");
  process.env.DB_PATH = join(home, "app.db");
  Object.assign(process.env, env);
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("with a host url, shareable servers become url entries and the rest stay stdio", async () => {
  const home = makeHome();
  const rows = await withEnv(home, { MCP_SATELLITE_HOST_URL: "http://127.0.0.1:19801" }, () => patchRows(home));
  const byId = Object.fromEntries(rows.map((r) => [r.id, r.config]));

  for (const name of ["fleet", "cron"]) {
    const c = byId[`mcp-${name}`];
    assert.ok(c, `${name} must still be present`);
    assert.equal(c.transport, "streamable-http", `${name} rides the shared host`);
    assert.equal(c.url, `http://127.0.0.1:19801/${name}/mcp`, `${name} keeps its own endpoint`);
    assert.equal(c.command, undefined, `${name} must not spawn anything`);
    // The whole design leans on fail-open: a satellite host that is down must
    // grey its tools out, not stop the dsh runtime from starting. Verified live
    // 2026-11-08 that this field IS honoured — production already runs 41
    // `transport: streamable-http` entries built by this same function
    // (facet-market / fd-erp-ledger / airegistry), so the url path is a shipped
    // path rather than a new one.
    assert.equal(c.failOnStartupError, false, `${name} must degrade, not block startup`);
    assert.equal(c.serverName, name, "dsh keys the roster by serverName");
  }
  // Member-scoped and session-scoped servers are untouched.
  for (const name of ["library", "websearch", "actions"]) {
    const c = byId[`mcp-${name}`];
    assert.ok(c, `${name} must still be present`);
    assert.equal(c.transport, "stdio", `${name} must stay per-runtime`);
    assert.equal(c.command, "node");
  }
});

test("without a host url the composition is byte-identical stdio", async () => {
  const home = makeHome();
  const rows = await withEnv(home, {}, () => patchRows(home));
  for (const row of rows) {
    assert.equal(row.config.transport, "stdio", `${row.id} stays stdio`);
    assert.equal(row.config.command, "node");
  }
});

test("the shareable list contains no member-scoped satellite (env-read audit)", async () => {
  const mod = await import(pathToFileURL(join(REPO_ROOT, "dsh-profile.js")).href);
  const memberRe = /TOKEN|SECRET|_KEY|COLLECTIONS|PROJECT_ID|MEMBER|EMAIL|OWNER/;
  const offenders = [];
  for (const name of mod.SHARED_SATELLITE_SERVERS) {
    const file = join(REPO_ROOT, "server", `${name}-mcp.js`);
    let src = "";
    try {
      src = readFileSync(file, "utf8");
    } catch {
      // No in-repo file (e.g. an external package) → cannot audit here; the
      // membership decision for those is recorded in design.md F2 instead.
      continue;
    }
    const envs = [...new Set((src.match(/process\.env\.[A-Z0-9_]+/g) || []).map((s) => s.replace("process.env.", "")))];
    const bad = envs.filter((e) => memberRe.test(e));
    if (bad.length) offenders.push(`${name}: ${bad.join(",")}`);
  }
  assert.deepEqual(offenders, [], "a member-scoped env read in the shareable set means cross-member leakage");
});

test("session-scoped `actions` is deliberately excluded", async () => {
  const mod = await import(pathToFileURL(join(REPO_ROOT, "dsh-profile.js")).href);
  assert.equal(mod.SHARED_SATELLITE_SERVERS.includes("actions"), false, "actions reads DSH_SESSION_ID (session-scoped)");
  for (const excluded of ["library", "websearch", "fd-memory"]) {
    assert.equal(mod.SHARED_SATELLITE_SERVERS.includes(excluded), false, `${excluded} is member-scoped`);
  }
});

// ── Member views must not relax when satellites are shared (3.1/3.2) ────────
// The whole safety argument rests on one thing: sharing moves only the
// cell-scoped satellites, never the member-scoped ones. This drives the real
// member-patch writer with a host url present and asserts the member-scoped
// entries keep THEIR env (token / collections) while the shareable ones become
// url entries.

test("member patch keeps member-scoped env while shareable entries go url", async () => {
  const home = makeHome();
  const rows = await withEnv(
    home,
    {
      MCP_SATELLITE_HOST_URL: "http://127.0.0.1:19900",
      // member-scoped servers need to exist in the cell config for the writer
      // to stamp them; add them for this case only.
      MCP_CONFIG_PATH: (() => {
        const p = join(home, "mcp-member.json");
        writeFileSync(
          p,
          JSON.stringify({
            mcpServers: {
              ...ENTRIES,
              "fd-memory": { command: "node", args: ["node_modules/fd-memory/dist/index.js"], env: {} },
              library: { command: "node", args: ["server/library-mcp.js"], env: { LIBRARY_PROJECT_ID: "proj-cell" } },
            },
          }),
        );
        return p;
      })(),
    },
    async () => {
      const mod = await import(`${pathToFileURL(join(REPO_ROOT, "dsh-profile.js")).href}?member=${Date.now()}-${Math.random()}`);
      const memberPatch = await mod.writeMemberMcpPatch({
        personaPreset: "mo-inventory",
        memoryToken: "mem-token-for-this-member",
        libraryCollections: ["library:col-a", "library:col-b"],
        ownerEmail: "owner@example.com",
      });
      assert.ok(memberPatch, "member patch was written");
      const parsed = yaml.load(readFileSync(memberPatch, "utf8"));
      return parsed.filter((r) => r?.insert).flatMap((r) => r.insert);
    },
  );
  const byId = Object.fromEntries(rows.map((r) => [r.id, r.config]));

  // Shareable → url, no command.
  for (const name of ["fleet", "cron"]) {
    assert.equal(byId[`mcp-${name}`].transport, "streamable-http", `${name} rides the shared host`);
    assert.equal(byId[`mcp-${name}`].command, undefined);
  }
  // Member-scoped → still stdio WITH the member's values.
  const library = byId["mcp-library"];
  assert.equal(library.transport, "stdio", "library must stay per-runtime");
  assert.equal(library.command, "node");
  assert.equal(library.env.LIBRARY_COLLECTIONS, "col-a,col-b", "the member's collections must survive sharing");

  // fd-memory carries the member token as a bearer HEADER (it is an external
  // streamable-http service), not in env — asserting the wrong carrier would
  // have "proved" leakage protection that does not exist.
  // fd-memory carries the member token as a bearer HEADER (external
  // streamable-http service), not in env. `memoryUrl` decides whether a url is
  // present; the token rides headers either way — that is the property to pin.
  const memory = byId["mcp-fd-memory"];
  assert.equal(
    memory.headers?.Authorization,
    "Bearer mem-token-for-this-member",
    "the member's memory token must survive sharing, per member",
  );

  // 3.2: a SECOND member on the SAME shared host must get ITS OWN values. One
  // member's patch proves nothing about cross-member leakage — the failure this
  // guards is precisely "everyone inherits the first member's token".
  const second = await withEnv(
    home,
    { MCP_SATELLITE_HOST_URL: "http://127.0.0.1:19900", MCP_CONFIG_PATH: join(home, "mcp-member.json") },
    async () => {
      const mod = await import(`${pathToFileURL(join(REPO_ROOT, "dsh-profile.js")).href}?member2=${Date.now()}-${Math.random()}`);
      const patch = await mod.writeMemberMcpPatch({
        personaPreset: "ops-wx-chief",
        memoryToken: "mem-token-for-the-other-member",
        libraryCollections: ["library:col-z"],
        ownerEmail: "owner@example.com",
      });
      assert.ok(patch, "second member patch was written");
      const parsed2 = yaml.load(readFileSync(patch, "utf8"));
      return parsed2.filter((r) => r?.insert).flatMap((r) => r.insert);
    },
  );
  const byId2 = Object.fromEntries(second.map((r) => [r.id, r.config]));
  for (const name of ["fleet", "cron"]) {
    assert.equal(byId2[`mcp-${name}`].transport, "streamable-http", `${name} rides the shared host for member 2 too`);
  }
  assert.equal(byId2["mcp-library"].env.LIBRARY_COLLECTIONS, "col-z", "member 2 sees only its own collections");
  assert.equal(
    byId2["mcp-fd-memory"].headers?.Authorization,
    "Bearer mem-token-for-the-other-member",
    "member 2 must not inherit member 1's memory token",
  );
});
