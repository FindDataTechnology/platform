// Self-test for scripts/lib/test-server.mjs — the shared test-server hygiene
// core (fix-unit-lane-process-hygiene). Exercises the teardown ladder, group
// descendant reach, stale-registration self-healing, live-owner skipping, and
// the repo-identity gate that keeps a recycled pgid from ever being killed.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, unlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { spawnTestServer, sweepStaleServers } from "./lib/test-server.mjs";

const SLEEPER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "lib", "test-sleeper.mjs");
const REGISTRY_DIR = path.join(tmpdir(), "paas-test-servers");
const entryOf = (pgid) => path.join(REGISTRY_DIR, `${pgid}.json`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function dead(pid, tries = 20) {
  for (let i = 0; i < tries; i++) {
    try { process.kill(pid, 0); } catch { return true; }
    await sleep(100);
  }
  return false;
}

// A process pid that is verifiably dead — the corpse entries' fake owner.
async function deadPid() {
  const short = spawn(process.execPath, ["-e", "process.exit(0)"]);
  await new Promise((r) => short.on("exit", r));
  return short.pid;
}

test("ladder: graceful stop kills the group and deregisters", async () => {
  const server = spawnTestServer({ args: [SLEEPER], env: process.env });
  await sleep(500);
  assert.ok(existsSync(entryOf(server.child.pid)), "spawn must register the group");
  await server.stop({ graceMs: 3000 });
  assert.ok(server.child.signalCode === "SIGTERM" || server.child.exitCode !== null, "server must be down");
  assert.ok(!existsSync(entryOf(server.child.pid)), "stop must deregister");
});

test("ladder: a wedged server is group-SIGKILLed after the grace", async () => {
  const server = spawnTestServer({ args: [SLEEPER], env: { ...process.env, TRAP_TERM: "1" } });
  await sleep(500);
  const t0 = Date.now();
  await server.stop({ graceMs: 800 });
  assert.ok(Date.now() - t0 >= 750, "must wait out the grace before escalating");
  assert.equal(server.child.signalCode, "SIGKILL", "wedged server must die by SIGKILL");
});

test("group kill reaches spawned descendants", async () => {
  const server = spawnTestServer({ args: [SLEEPER], env: { ...process.env, SPAWN_CHILD: "1" } });
  let descendant = null;
  server.child.stdout.on("data", (b) => {
    const m = String(b).match(/^child (\d+)$/m);
    if (m) descendant = Number(m[1]);
  });
  await sleep(800);
  assert.ok(descendant, "sleeper must report its child pid");
  await server.stop({ graceMs: 3000 });
  assert.ok(await dead(descendant), "descendant must die with the group");
});

test("self-heal: stale registration (dead owner) is killed and swept", async () => {
  const storeRoot = mkdtempSync(path.join(tmpdir(), "sleeper-corpse-"));
  const stray = spawn(process.execPath, [SLEEPER], { stdio: "ignore", env: process.env, detached: true });
  await sleep(500);
  mkdirSync(REGISTRY_DIR, { recursive: true });
  writeFileSync(entryOf(stray.pid), JSON.stringify({
    pgid: stray.pid, ownerPid: await deadPid(), storeRoot, createdAt: Date.now(),
  }));
  sweepStaleServers();
  assert.ok(await dead(stray.pid), "corpse group must be SIGKILLed");
  assert.ok(!existsSync(storeRoot), "corpse store root must be deleted");
  assert.ok(!existsSync(entryOf(stray.pid)), "stale entry must be removed");
});

test("self-heal: live-owner registration is never touched", async () => {
  mkdirSync(REGISTRY_DIR, { recursive: true });
  const mine = entryOf(process.pid);
  writeFileSync(mine, JSON.stringify({ pgid: process.pid, ownerPid: process.pid, storeRoot: null }));
  sweepStaleServers();
  assert.ok(existsSync(mine), "a registration whose owner is alive must be skipped");
  unlinkSync(mine);
});

test("identity gate: a foreign group with a dead owner is never killed", async () => {
  mkdirSync(REGISTRY_DIR, { recursive: true });
  const foreign = entryOf(1); // launchd's group — members' commands never name this repo
  writeFileSync(foreign, JSON.stringify({ pgid: 1, ownerPid: await deadPid(), storeRoot: null }));
  sweepStaleServers();
  // Surviving this line means kill(-1) never happened; the entry is dropped.
  assert.ok(!existsSync(foreign), "unprovable entry must still be dropped");
  assert.ok(true, "this process lives — the gate held");
});
