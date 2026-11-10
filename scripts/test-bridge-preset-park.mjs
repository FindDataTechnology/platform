#!/usr/bin/env node
// add-cell-session-persona — the host-side bridge contract for parked
// personas, tested against the REAL DshBridge class with a FAKE dsh child.
//
// The bridge is spawned through the same DSH_BIN seam production uses; the
// fake binary is a newline-delimited JSON-RPC responder whose behavior each
// test configures (capabilities list, preset/set verdict). This pins the
// three states the turn executor consumes:
//   ① park records per generation; spawn clears the map (fresh child = no
//      live agents); deleteSession drops the entry with the session;
//   ② a live-session refusal (the contract message) rejects WITHOUT
//      recording — the caller's legacy fallback reads it via
//      classifyPresetSetError;
//   ③ an older child (capabilities without preset/set) answers
//      hasLiveMethod("preset/set") === false.
//
//   node --test scripts/test-bridge-preset-park.mjs

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

// DSH_BIN is read at module load — set it before the dynamic import below.
const scratch = mkdtempSync(join(tmpdir(), "bridge-park-test-"));
const workDir = join(scratch, "work");
mkdirSync(workDir, { recursive: true });

// The fake dsh: speaks newline-delimited JSON-RPC on stdio. Behavior is
// steered by the FAKE_MODE env var the test sets before each bridge spawn.
const FAKE = join(scratch, "fake-dsh.mjs");
writeFileSync(
  FAKE,
  `#!/usr/bin/env node
import readline from "node:readline";
const mode = process.env.FAKE_MODE ?? "ok";
const methods = (process.env.FAKE_METHODS ?? "model/set,session/cancel,tools/set,preset/set").split(",").filter(Boolean);
const rl = readline.createInterface({ input: process.stdin, terminal: false });
const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\\n");
rl.on("line", (line) => {
  let req; try { req = JSON.parse(line); } catch { return; }
  if (req?.id === undefined || req?.id === null) return; // notification
  if (req.method === "initialize") { send({ jsonrpc: "2.0", id: req.id, result: { serverInfo: { name: "fake-dsh", version: "0.0.0-test" } } }); return; }
  if (req.method === "platform/capabilities") { send({ jsonrpc: "2.0", id: req.id, result: { methods } }); return; }
  if (req.method === "preset/set") {
    if (mode === "refuse-live") {
      send({ jsonrpc: "2.0", id: req.id, error: { code: -32000, message: "preset/set refused for session '" + req.params?.sessionId + "': persona is creation-time composition — start a new session to change presets" } });
    } else if (mode === "hard-error") {
      send({ jsonrpc: "2.0", id: req.id, error: { code: -32000, message: "preset registry exploded" } });
    } else {
      send({ jsonrpc: "2.0", id: req.id, result: {} });
    }
    return;
  }
  send({ jsonrpc: "2.0", id: req.id, result: {} });
});
`,
);
chmodSync(FAKE, 0o755);

// The bridge resolves COMMAND at module load: point it at the fake BEFORE
// the import, or the real bundled `dsh` boots (its bare profile has no
// presets patch → "unknown runtime method: preset/set").
process.env.DSH_BIN = FAKE;

const { DshBridge, classifyPresetSetError } = await import("../dsh-bridge.js");

function makeBridge({ mode = "ok", methods } = {}) {
  return new DshBridge({
    cwd: workDir,
    env: { ...process.env, FAKE_MODE: mode, ...(methods ? { FAKE_METHODS: methods } : {}) },
  });
}

// classifyPresetSetError is pure — pin all three classes first (cheap, no child).
test("classifyPresetSetError: refusal is contract-matched; everything else stays un-refused", () => {
  const refusal = classifyPresetSetError(
    new Error("preset/set refused for session 's1': persona is creation-time composition — start a new session to change presets"),
  );
  assert.equal(refusal.refused, true);

  const altWording = classifyPresetSetError(new Error("session already has a live agent"));
  assert.equal(altWording.refused, true);

  const hard = classifyPresetSetError(new Error("preset registry exploded"));
  assert.equal(hard.refused, false);
  assert.match(hard.error.message, /registry exploded/);

  const nonError = classifyPresetSetError("transport closed");
  assert.equal(nonError.refused, false);
  assert.match(nonError.error.message, /transport closed/);
});

beforeEach(() => {});
afterEach(() => {});

test("park records per generation; delete drops the entry; respawn clears the map", async () => {
  const bridge = makeBridge({});
  try {
    await bridge.start();
    assert.equal(bridge.hasLiveMethod("preset/set"), true);

    await bridge.setPreset({ sessionId: "s1", presetId: "persona-a" });
    assert.equal(bridge.preparedPreset("s1"), "persona-a");

    // A different preset re-park overwrites the generation-local entry (D3 ③).
    await bridge.setPreset({ sessionId: "s1", presetId: "persona-b" });
    assert.equal(bridge.preparedPreset("s1"), "persona-b");

    await bridge.setPreset({ sessionId: "s2", presetId: "persona-a" });
    assert.equal(bridge.preparedPreset("s2"), "persona-a");

    // deleteSession drops the entry WITH the session (fleet rounds rotate ids).
    assert.equal(await bridge.deleteSession("s1"), true);
    assert.equal(bridge.preparedPreset("s1"), null);
    assert.equal(bridge.preparedPreset("s2"), "persona-a");

    // A restart is a fresh child: no live agents, so nothing stays prepared.
    await bridge.restart({});
    assert.equal(bridge.preparedPreset("s2"), null, "spawn clears the prepared map");
    assert.equal(bridge.hasLiveMethod("preset/set"), true, "probe re-runs on the new generation");
  } finally {
    await bridge.shutdown().catch?.(() => {});
  }
});

test("a live-session refusal rejects without recording; the caller classifies it as legacy fallback", async () => {
  const bridge = makeBridge({ mode: "refuse-live" });
  try {
    await bridge.start();
    await assert.rejects(
      () => bridge.setPreset({ sessionId: "live-1", presetId: "persona-a" }),
      /creation-time composition/,
    );
    assert.equal(bridge.preparedPreset("live-1"), null, "a refused park records nothing");
    try {
      await bridge.setPreset({ sessionId: "live-1", presetId: "persona-a" });
    } catch (err) {
      assert.equal(classifyPresetSetError(err).refused, true);
    }
  } finally {
    await bridge.shutdown().catch?.(() => {});
  }
});

test("an unmatched park error still rejects un-recorded but classifies as non-refusal (hard fallback)", async () => {
  const bridge = makeBridge({ mode: "hard-error" });
  try {
    await bridge.start();
    await assert.rejects(() => bridge.setPreset({ sessionId: "s3", presetId: "persona-a" }), /registry exploded/);
    assert.equal(bridge.preparedPreset("s3"), null);
    try {
      await bridge.setPreset({ sessionId: "s3", presetId: "persona-a" });
    } catch (err) {
      const cls = classifyPresetSetError(err);
      assert.equal(cls.refused, false, "unmatched errors must not read as the refusal contract");
    }
  } finally {
    await bridge.shutdown().catch?.(() => {});
  }
});

test("an older child (capabilities without preset/set) reports the method as absent", async () => {
  const bridge = makeBridge({ methods: "model/set,session/cancel,tools/set" });
  try {
    await bridge.start();
    assert.equal(bridge.hasLiveMethod("preset/set"), false, "legacy fallback signal");
    // The park must not be attempted against such a child by the executor;
    // here we only pin the probe's answer.
  } finally {
    await bridge.shutdown().catch?.(() => {});
  }
});

// Silence the unused import warning path: spawn is only used implicitly via
// the bridge's own child management.
void spawn;
void rmSync;
