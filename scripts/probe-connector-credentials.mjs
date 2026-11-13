#!/usr/bin/env node
// ── Local end-to-end probe: connector credential → effective profile ─────────
//
// Boots the REAL server (server.js) against a throwaway environment whose
// mcp.json carries the baseline connector row (URL pointed at a local probe
// stub), then drives the real HTTP surface and reads the real dsh patch file:
//
//   A. no credential  → GET says unconnected; the effective profile OMITS the
//                       connector server (server log carries the omission
//                       warning) while the mcp.json row itself is untouched
//   B. paste a PAT    → the stub (initialize probe) answers 200; GET says
//                       connected; the profile rewrite injects the connector
//                       server with `Authorization: Bearer <PAT>` — and no
//                       HTTP response ever echoes the PAT
//   C. disconnect     → the row is gone; the profile rewrite omits the server
//                       again (baseline row still intact)
//
// Fully local (auth off ⇒ machine owner; no dsh turn is driven — the patch
// file is the effective profile). Run from the repo root:
//
//   node scripts/probe-connector-credentials.mjs

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "connector-probe-"));
const PORT = 10000 + Math.floor(Math.random() * 30000);

// The connector stub: initialize answers 200 (a live PAT) by default.
let stubStatus = 200;
const stubHits = [];
const stub = createServer((req, res) => {
  stubHits.push({ auth: req.headers.authorization });
  res.statusCode = stubStatus;
  res.end(stubStatus === 401 ? "unauthorized" : JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }));
});
await new Promise((r) => stub.listen(0, "127.0.0.1", r));
const STUB_PORT = stub.address().port;

const env = {
  ...process.env,
  PORT: String(PORT),
  HOST: "127.0.0.1",
  DB_PATH: path.join(TMP, "platform.db"),
  PLATFORM_DATA_DIR: TMP,
  DSH_HOME: path.join(TMP, "dsh"),
  MCP_CONFIG_PATH: path.join(TMP, "mcp.json"),
  LLM_API_KEY: "", // degrade gracefully: no provider needed for this probe
};
delete env.REGISTRY_URL;
delete env.MARKET_REGISTRY_URL;
fs.mkdirSync(env.DSH_HOME, { recursive: true });
fs.writeFileSync(env.MCP_CONFIG_PATH, JSON.stringify({
  mcpServers: {
    connector: { url: `http://127.0.0.1:${STUB_PORT}/mcp`, credentialRef: "connector" },
    "probe-plain": { url: "https://example.invalid/mcp" },
  },
}, null, 2));

const PATCH_FILE = path.join(env.DSH_HOME, "profiles", process.env.DSH_PROFILE || "platform", "mcp.patch.yml");
const baselineRow = () =>
  JSON.parse(fs.readFileSync(env.MCP_CONFIG_PATH, "utf8")).mcpServers.connector;

function patchNames() {
  if (!fs.existsSync(PATCH_FILE)) return [];
  const doc = yaml.load(fs.readFileSync(PATCH_FILE, "utf8"));
  return (doc?.[0]?.insert ?? []).map((e) => e.config.serverName);
}
function patchHeader(name) {
  const doc = yaml.load(fs.readFileSync(PATCH_FILE, "utf8"));
  return (doc?.[0]?.insert ?? []).find((e) => e.config.serverName === name)?.config?.headers?.Authorization ?? null;
}

async function api(method, p, body) {
  const res = await fetch(`http://127.0.0.1:${PORT}${p}`, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const raw = await res.text();
  return { status: res.status, raw, body: raw ? JSON.parse(raw) : null };
}

// Boot the real server. Readiness = the connector routes answer (DB up): the
// dsh child itself may degrade on machines whose profile node_modules tree is
// incomplete — this probe drives the host-side patch chain, which the boot
// sequence writes before agent init regardless.
const server = spawn(process.execPath, ["server.js"], {
  env,
  stdio: ["ignore", "pipe", "pipe"],
});
const log = [];
server.stdout.on("data", (c) => log.push(String(c)));
server.stderr.on("data", (c) => log.push(String(c)));

try {
  let ready = false;
  for (let i = 0; i < 120 && !ready; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/api/connector/connection`);
      ready = res.status === 200;
    } catch { /* still booting */ }
  }
  assert.ok(ready, `connector routes answered (log tail:\n${log.join("").slice(-2000)})`);
  // The boot MCP patch lands shortly after the routes; wait for a stable read.
  let booted = false;
  for (let i = 0; i < 40 && !booted; i++) {
    await new Promise((r) => setTimeout(r, 250));
    booted = fs.existsSync(PATCH_FILE) || log.join("").includes("MCP server(s)");
  }
  assert.ok(booted, "the boot patch write happened");
  await new Promise((r) => setTimeout(r, 500));

  const PAT = `oct_${"p".repeat(40)}`;

  // ── A. No credential: unconnected + omitted from the effective profile ────
  const before = await api("GET", "/api/connector/connection");
  assert.equal(before.status, 200);
  assert.equal(before.body.connected, false);
  assert.ok(before.body.connectorUrl, "payload carries the connector origin for the card hint");
  assert.equal(patchNames().includes("connector"), false, "A: connector omitted without a PAT");
  assert.ok(patchNames().includes("probe-plain"), "A: non-ref baseline server kept");
  assert.deepEqual(baselineRow().credentialRef, "connector", "A: mcp.json row untouched");
  assert.ok(
    log.join("").includes("omitting 1 connector MCP server"),
    "A: the omission warning names the connector ref",
  );

  // ── B. Paste a live PAT: connected + injected with the Bearer header ───────
  stubStatus = 200;
  const pasted = await api("POST", "/api/connector/credential", { token: PAT });
  assert.equal(pasted.status, 200, `paste accepted (raw: ${pasted.raw})`);
  assert.equal(pasted.body.connected, true);
  assert.equal(pasted.raw.includes(PAT), false, "B: paste response never echoes the PAT");
  assert.equal(stubHits.at(-1)?.auth, `Bearer ${PAT}`, "B: the paste-time probe presented the PAT");
  // The paste re-applies the profile through ctx.dshUpdateMcp — which only
  // exists once the dsh child booted. Wait for the live rewrite; on a machine
  // where dsh is degraded (e.g. an incomplete local profile tree) fall back to
  // invoking the SAME writer in-process against the same DB and mcp.json, so
  // the credential → effective-profile mapping is still proven end-to-end.
  let injected = false;
  for (let i = 0; i < 60 && !injected; i++) {
    await new Promise((r) => setTimeout(r, 250));
    injected = patchNames().includes("connector") && patchHeader("connector") === `Bearer ${PAT}`;
  }
  let reapplyPath = "live reapply (dshUpdateMcp)";
  if (!injected) {
    for (const [k, v] of Object.entries(env)) process.env[k] = v;
    // A fresh process must open the same SQLite file before the writer can
    // resolve credentials from it (the server did this at boot).
    const db = await import("../db.js");
    await db.initDb();
    const { writeMcpPatch } = await import("../dsh-profile.js");
    await writeMcpPatch({ ownerEmail: null, userGroups: null });
    injected = patchNames().includes("connector") && patchHeader("connector") === `Bearer ${PAT}`;
    reapplyPath = "in-process writer (dsh degraded on this machine)";
  }
  assert.ok(injected, `B: connector injected with Authorization: Bearer <PAT> (names: ${patchNames().join(", ") || "(no patch)"}; log tail:\n${log.join("").slice(-1500)})`);
  const status = await api("GET", "/api/connector/connection");
  assert.equal(status.raw.includes(PAT), false, "B: status response never echoes the PAT");

  // ── B2. A revoked PAT is rejected at paste time (stub now answers 401) ────
  stubStatus = 401;
  const dead = await api("POST", "/api/connector/credential", { token: `oct_${"d".repeat(40)}` });
  assert.equal(dead.status, 400, "B2: dead PAT rejected");
  assert.match(dead.body.error, /revoked|invalid/i);

  // ── C. Disconnect: row gone, server omitted again, baseline intact ────────
  const del = await api("DELETE", "/api/connector/connection");
  assert.equal(del.status, 200);
  assert.equal(del.body.connected, false);
  let omitted = false;
  for (let i = 0; i < 60 && !omitted; i++) {
    await new Promise((r) => setTimeout(r, 250));
    omitted = !patchNames().includes("connector");
  }
  if (!omitted && reapplyPath.startsWith("in-process")) {
    const { writeMcpPatch } = await import("../dsh-profile.js");
    await writeMcpPatch({ ownerEmail: null, userGroups: null });
    omitted = !patchNames().includes("connector");
  }

  assert.ok(omitted, "C: connector omitted after disconnect");
  assert.deepEqual(baselineRow().credentialRef, "connector", "C: mcp.json row still intact");
  assert.ok(patchNames().includes("probe-plain"), "C: plain server unaffected");

  console.log("PROBE PASS — connector credential → effective profile loop verified");
  console.log(`  A: omitted without PAT (warning logged)`);
  console.log(`  B: injected with Bearer header after paste via ${reapplyPath}`);
  console.log(`  B2: dead PAT rejected 400 at paste time`);
  console.log(`  C: omitted again after disconnect; baseline row never mutated`);
} finally {
  server.kill("SIGKILL");
  stub.close();
  fs.rmSync(TMP, { recursive: true, force: true });
}
