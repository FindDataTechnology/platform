#!/usr/bin/env node
// ── ACP harness config-dir guard (harden-acp-credential-channel 1.3) ──────────
//
// Spec (harness-adapter, "Harness credentials never persist in a harness config
// directory"): an ACP harness's credentials ride the spawn environment; any
// config dir the runner points it at must not keep a plaintext copy on the
// persistent volume. The guard's policy lives in
// agent-runner/harness/acp-config-dir.js and is exercised here on real temp
// directories — including the modes, because 0644 was half the finding.
//
//   node --test scripts/test-acp-credential-channel.mjs

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { configDirFor, credentialKeysIn, declaredSettings, ownAcpConfigDir } from "../agent-runner/harness/acp-config-dir.js";

// Deliberately NOT shaped like a credential: the guard strips by key NAME, so a
// realistic-looking value would only teach the release gate (gitleaks
// generic-api-key) to flag this fixture — measured, it did.
const TOKEN = "fixture-value-not-a-credential";
const BASE = "https://token.example.invalid/anthropic";

function tempDir(prefix) {
  const dir = mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  return dir;
}

// A log that remembers what was said, so "key names only, never values" is an
// assertion and not a comment.
function recordingLog() {
  const lines = [];
  const push = (msg) => lines.push(String(msg));
  return { lines, log: { info: push, warn: push, log: push } };
}

// The file measured on agent-runner-serving, 2026-11-12: a hand-drifted
// settings file at 0644 carrying the live token next to settings that matter.
function writeDrifted(dir) {
  const file = path.join(dir, "settings.json");
  const body = {
    model: "claude-sonnet-4-5",
    env: { ANTHROPIC_BASE_URL: BASE, ANTHROPIC_AUTH_TOKEN: TOKEN },
  };
  writeFileSync(file, JSON.stringify(body, null, 2));
  return { file, body };
}

test("credentialKeysIn names exactly the credential keys", () => {
  assert.deepEqual(credentialKeysIn({}), []);
  assert.deepEqual(credentialKeysIn(null), []);
  assert.deepEqual(credentialKeysIn({ model: "m", env: { ANTHROPIC_BASE_URL: BASE } }), []);
  assert.deepEqual(credentialKeysIn({ env: { ANTHROPIC_AUTH_TOKEN: TOKEN } }), ["env.ANTHROPIC_AUTH_TOKEN"]);
  assert.deepEqual(credentialKeysIn({ env: { ANTHROPIC_API_KEY: TOKEN } }), ["env.ANTHROPIC_API_KEY"]);
  assert.deepEqual(credentialKeysIn({ apiKey: TOKEN }), ["apiKey"]);
  assert.deepEqual(credentialKeysIn({ primaryApiKey: TOKEN }), ["primaryApiKey"]);
  assert.deepEqual(credentialKeysIn({ env: { ANTHROPIC_AUTH_TOKEN: TOKEN, ANTHROPIC_API_KEY: TOKEN } }), [
    "env.ANTHROPIC_AUTH_TOKEN",
    "env.ANTHROPIC_API_KEY",
  ]);
});

test("configDirFor guards only an explicitly named dir — never $HOME", () => {
  assert.equal(configDirFor({ CLAUDE_CONFIG_DIR: "/data/.claude-acp" }), "/data/.claude-acp");
  assert.equal(configDirFor({ CLAUDE_CONFIG_DIR: "  /x  " }), "/x");
  // The near-miss this pins: a workstation's own ~/.claude/settings.json carries
  // env.ANTHROPIC_AUTH_TOKEN in exactly the shape the guard strips, so an
  // $HOME fallback would mean any local run over the ambient env deletes the
  // operator's live credential.
  assert.equal(configDirFor({ HOME: "/home/node" }), null);
  assert.equal(configDirFor({ CLAUDE_CONFIG_DIR: "", HOME: "/home/node" }), null);
  assert.equal(configDirFor({}), null);
});

test("a settings file carrying the live token is stripped, tightened, and logged by key name only", () => {
  const dir = tempDir("acp-cfg-drift");
  try {
    const { file, body } = writeDrifted(dir);
    const { lines, log } = recordingLog();

    const receipt = ownAcpConfigDir({ CLAUDE_CONFIG_DIR: dir }, { log });

    assert.equal(receipt.ok, true);
    assert.equal(receipt.present, true);
    assert.deepEqual(receipt.dropped, ["env.ANTHROPIC_AUTH_TOKEN"]);

    const after = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(after.env?.ANTHROPIC_AUTH_TOKEN, undefined, "the credential is gone");
    assert.equal(after.env?.ANTHROPIC_BASE_URL, body.env.ANTHROPIC_BASE_URL, "the base URL is configuration, not a secret");
    assert.equal(after.model, body.model, "settings that are not credentials survive");
    assert.equal(statSync(file).mode & 0o777, 0o600, "a 0644 settings file ends up 0600");

    const logged = lines.join("\n");
    assert.match(logged, /env\.ANTHROPIC_AUTH_TOKEN/, "the log names the dropped key");
    assert.ok(!logged.includes(TOKEN), "the log never contains the value");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a top-level apiKey is stripped too", () => {
  const dir = tempDir("acp-cfg-topkey");
  try {
    const file = path.join(dir, "settings.json");
    writeFileSync(file, JSON.stringify({ apiKey: TOKEN, model: "m" }), { mode: 0o644 });
    const { log } = recordingLog();

    const receipt = ownAcpConfigDir({ CLAUDE_CONFIG_DIR: dir }, { log });

    assert.deepEqual(receipt.dropped, ["apiKey"]);
    assert.equal(JSON.parse(readFileSync(file, "utf8")).apiKey, undefined);
    assert.equal(statSync(file).mode & 0o777, 0o600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a clean directory is left untouched — nothing is created, nothing is rewritten", () => {
  const absent = tempDir("acp-cfg-absent");
  const clean = tempDir("acp-cfg-clean");
  try {
    const absentReceipt = ownAcpConfigDir({ CLAUDE_CONFIG_DIR: absent }, { log: recordingLog().log });
    assert.deepEqual({ ok: absentReceipt.ok, present: absentReceipt.present }, { ok: true, present: false });
    assert.equal(statSync(absent).size >= 0, true);
    assert.throws(() => statSync(path.join(absent, "settings.json")), /ENOENT/, "the guard never seeds a settings file");

    const file = path.join(clean, "settings.json");
    const body = JSON.stringify({ model: "m", env: { ANTHROPIC_BASE_URL: BASE } }, null, 2);
    writeFileSync(file, body, { mode: 0o644 });
    const receipt = ownAcpConfigDir({ CLAUDE_CONFIG_DIR: clean }, { log: recordingLog().log });
    assert.deepEqual(receipt.dropped, []);
    assert.equal(readFileSync(file, "utf8"), body, "byte-identical: no rewrite");
  } finally {
    rmSync(absent, { recursive: true, force: true });
    rmSync(clean, { recursive: true, force: true });
  }
});

test("an unparseable file degrades open, is reported by path, and is not rewritten", () => {
  const dir = tempDir("acp-cfg-broken");
  try {
    const file = path.join(dir, "settings.json");
    const broken = `{"env":{"ANTHROPIC_AUTH_TOKEN":"${TOKEN}"`; // truncated on purpose
    writeFileSync(file, broken);
    const { lines, log } = recordingLog();

    const receipt = ownAcpConfigDir({ CLAUDE_CONFIG_DIR: dir }, { log });

    assert.equal(receipt.ok, false);
    assert.equal(receipt.reason, "invalid_json");
    assert.equal(readFileSync(file, "utf8"), broken, "a file we cannot parse is never blindly rewritten");
    assert.match(lines.join("\n"), new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "the report names the path");
    assert.ok(!lines.join("\n").includes(TOKEN), "the report never echoes the value");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a $HOME-shaped config dir is untouchable when the spawn does not name it", () => {
  const home = tempDir("acp-cfg-home");
  try {
    const dir = path.join(home, ".claude");
    mkdirSync(dir, { recursive: true });
    const { file } = writeDrifted(dir);
    const before = readFileSync(file, "utf8");
    const beforeMode = statSync(file).mode & 0o777;
    const { lines, log } = recordingLog();

    const receipt = ownAcpConfigDir({ HOME: home }, { log });

    // This is the developer-workstation case: same shape as the drift, but the
    // runner never pointed the child at it, so it must survive verbatim.
    assert.deepEqual(receipt, { ok: true, checked: false });
    assert.equal(readFileSync(file, "utf8"), before, "no rewrite outside a named config dir");
    assert.equal(statSync(file).mode & 0o777, beforeMode, "no chmod outside a named config dir");
    assert.deepEqual(lines, [], "silent: nothing to report");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ── own-acp-harness-config: the declaration half ─────────────────────────────
//
// The 503 this pins: on 2026-11-13 agent-runner-c's ACP lane had never worked,
// because its config dir had no settings.json and this harness resolves its
// model from that file's top-level `model` — not from the env's ANTHROPIC_MODEL,
// not from the ACP `_meta` the adapter sends. A runner hosting ACP agents that
// leaves this to hand configuration gets exactly one node right.

const MODEL = "gateway-model-not-a-real-name";

test("declaredSettings mirrors only what the env declares", () => {
  assert.deepEqual(declaredSettings({}), {});
  assert.deepEqual(declaredSettings({ ANTHROPIC_MODEL: " m " }), { model: "m" });
  assert.deepEqual(declaredSettings({ ANTHROPIC_BASE_URL: " https://x.invalid " }), {
    env: { ANTHROPIC_BASE_URL: "https://x.invalid" },
  });
  assert.deepEqual(declaredSettings({ ANTHROPIC_MODEL: "m", ANTHROPIC_BASE_URL: "https://x.invalid" }), {
    model: "m",
    env: { ANTHROPIC_BASE_URL: "https://x.invalid" },
  });
});

test("a runner with no settings file gets the declared model, and only that", () => {
  const dir = tempDir("acp-cfg-create");
  try {
    const { lines, log } = recordingLog();
    const receipt = ownAcpConfigDir(
      { CLAUDE_CONFIG_DIR: dir, ANTHROPIC_MODEL: MODEL, ANTHROPIC_BASE_URL: BASE, ANTHROPIC_API_KEY: TOKEN },
      { log },
    );

    assert.equal(receipt.ok, true);
    assert.equal(receipt.created, true);
    const file = path.join(dir, "settings.json");
    const after = JSON.parse(readFileSync(file, "utf8"));
    assert.deepEqual(after, { model: MODEL, env: { ANTHROPIC_BASE_URL: BASE } });
    assert.equal(statSync(file).mode & 0o777, 0o600, "created at 0600");
    // The credential rode the spawn env and MUST NOT land in the file.
    assert.ok(!readFileSync(file, "utf8").includes(TOKEN), "the declaration never carries a credential");
    assert.match(lines.join("\n"), /created/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a file declaring another model is corrected in place, everything else survives", () => {
  const dir = tempDir("acp-cfg-correct");
  try {
    const file = path.join(dir, "settings.json");
    const before = {
      model: "claude-sonnet-4-5", // what the harness falls back to when nothing declares the model
      env: { ANTHROPIC_BASE_URL: "https://stale.invalid", SOMETHING: "kept" },
      permissions: { allow: ["Bash"] },
      keepMe: true,
    };
    writeFileSync(file, JSON.stringify(before, null, 2));

    const receipt = ownAcpConfigDir(
      { CLAUDE_CONFIG_DIR: dir, ANTHROPIC_MODEL: MODEL, ANTHROPIC_BASE_URL: BASE },
      { log: recordingLog().log },
    );

    assert.equal(receipt.changed, true);
    const after = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(after.model, MODEL, "the model routes the request — it is corrected");
    assert.equal(after.env.ANTHROPIC_BASE_URL, BASE);
    assert.equal(after.env.SOMETHING, "kept", "unrelated env entries survive");
    assert.deepEqual(after.permissions, before.permissions, "non-model settings survive verbatim");
    assert.equal(after.keepMe, true);
    assert.equal(statSync(file).mode & 0o777, 0o600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an already-correct declaration is left byte-identical", () => {
  const dir = tempDir("acp-cfg-idempotent");
  try {
    const file = path.join(dir, "settings.json");
    const body = `${JSON.stringify({ model: MODEL, env: { ANTHROPIC_BASE_URL: BASE } }, null, 2)}\n`;
    writeFileSync(file, body);

    const receipt = ownAcpConfigDir(
      { CLAUDE_CONFIG_DIR: dir, ANTHROPIC_MODEL: MODEL, ANTHROPIC_BASE_URL: BASE },
      { log: recordingLog().log },
    );

    assert.equal(receipt.changed, false);
    assert.equal(readFileSync(file, "utf8"), body, "no rewrite when nothing is wrong");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("no declared model means no invention", () => {
  const dir = tempDir("acp-cfg-nomodel");
  try {
    const receipt = ownAcpConfigDir({ CLAUDE_CONFIG_DIR: dir, ANTHROPIC_API_KEY: TOKEN }, { log: recordingLog().log });
    assert.deepEqual({ ok: receipt.ok, present: receipt.present }, { ok: true, present: false });
    assert.throws(() => statSync(path.join(dir, "settings.json")), /ENOENT/, "nothing to declare ⇒ no file");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
