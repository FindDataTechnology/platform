// Unit tests — steward control plane (add-cell-lifecycle, chapter 1).
//
// Pin the contract the UI attaches to:
//   - steward.json names a socket the client can reach, with the protocol
//     version the client demands
//   - a major-version mismatch is an explicit refusal, never a silent misparse
//   - ops do what they say: status shape, start/stop toggle the stack,
//     drainQuit stops AND exits
//   - attach discipline: no steward.json → reason "no-steward-json"
//
// Run: node --test scripts/test-steward-control.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const { createSteward } = await import("../supervisor/steward.js");
const { attachSteward, readStewardDiscovery } = await import("../supervisor/steward-client.js");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "steward-"));

const fakeSupervisor = () => {
  const calls = [];
  return {
    calls,
    started: false,
    async start() { this.started = true; calls.push("start"); },
    async stop() { this.started = false; calls.push("stop"); },
    status() { return [{ id: "server-js", state: this.started ? "healthy" : "stopped" }]; },
  };
};

test("discovery file lands after listen; hello answers the protocol version; status reports stack state", async () => {
  const dataDir = tmp();
  const sup = fakeSupervisor();
  const steward = createSteward({ supervisor: sup, dataDir, onExit: () => {} });
  const info = await steward.start();

  const disc = readStewardDiscovery(dataDir);
  assert.equal(disc.socket, info.socket);
  assert.equal(disc.protocolVersion, 1);
  if (process.platform !== "win32") {
    // POSIX-only claim: Windows has no modes (stat reports 0o666 for every
    // file) — custody there is DPAPI sealing + the profile ACL, not chmod.
    assert.equal((fs.statSync(path.join(dataDir, "steward.json")).mode & 0o777), 0o600, "discovery file is owner-only");
  }

  const attached = await attachSteward(dataDir);
  assert.equal(attached.ok, true, attached.reason);

  const status = await attached.client.request("status");
  assert.equal(status.state, "stopped");
  assert.deepEqual(status.servers, [{ id: "server-js", state: "stopped" }]);

  await attached.client.request("start");
  assert.equal(sup.started, true);
  const st2 = await attached.client.request("status");
  assert.equal(st2.state, "running");

  await attached.client.request("stop");
  assert.equal(sup.started, false);
  await steward.shutdown({ removeDiscovery: true });
});

test("major version mismatch is refused explicitly", async () => {
  const dataDir = tmp();
  const steward = createSteward({ supervisor: fakeSupervisor(), dataDir, onExit: () => {} });
  const info = await steward.start();
  const raw = await new Promise((resolve, reject) => {
    const conn = net.createConnection(info.socket);
    let buf = "";
    conn.on("data", (c) => { buf += c; if (buf.includes("\n")) { conn.end(); resolve(buf.trim()); } });
    conn.on("error", reject);
    conn.on("connect", () => conn.write(JSON.stringify({ id: "t1", op: "status", protocolVersion: 99 }) + "\n"));
  });
  const msg = JSON.parse(raw);
  assert.equal(msg.ok, false);
  assert.match(msg.error, /unsupported protocolVersion 99/);
  await steward.shutdown({ removeDiscovery: true });
});

test("drainQuit stops the stack and tears the discovery file", async () => {
  const dataDir = tmp();
  const exitCodes = [];
  const sup = fakeSupervisor();
  sup.started = true;
  const steward = createSteward({ supervisor: sup, dataDir, onExit: (c) => exitCodes.push(c) });
  await steward.start();
  const attached = await attachSteward(dataDir);
  assert.equal(attached.ok, true);
  await attached.client.request("drainQuit");
  assert.deepEqual(sup.calls, ["stop"]);
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(exitCodes, [0]);
  assert.equal(fs.existsSync(path.join(dataDir, "steward.json")), false);
  // drainQuit removed the discovery but the listener still owns the loop —
  // close it or the suite never exits.
  await steward.shutdown({ removeDiscovery: false }).catch(() => {});
});

test("attach discipline: no discovery file is a reason, never a repair", async () => {
  const r = await attachSteward(tmp());
  assert.deepEqual({ ok: r.ok, reason: r.reason }, { ok: false, reason: "no-steward-json" });
});

test("setPolicy persists and survives a steward restart; getPolicy round-trips", async () => {
  const dataDir = tmp();
  const steward = createSteward({ supervisor: fakeSupervisor(), dataDir, onExit: () => {} });
  await steward.start();
  const attached = await attachSteward(dataDir);
  await attached.client.request("setPolicy", { policy: "on_demand" });
  assert.equal((await attached.client.request("getPolicy")).policy, "on_demand");
  await steward.shutdown();

  const steward2 = createSteward({ supervisor: fakeSupervisor(), dataDir, onExit: () => {} });
  assert.equal(steward2.policy, "on_demand", "policy ledger survived the restart");
  await steward2.shutdown({ removeDiscovery: true });
});
