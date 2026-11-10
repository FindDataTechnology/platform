#!/usr/bin/env node
// Headless local-services launcher guards (optimize-paas-module-audit N-18).
//
// `npm start` is the only entry point for a non-Electron run, and before this
// file it had no dedicated test at all (the audit note: "写坏一次全盘不可启动").
// The launcher itself is a blind orchestrator, so the two testable seams were
// extracted: the SETTING_KEYS forwarding rule (a knob dropped here is a
// user-facing setting that silently does nothing in dev while working in the
// desktop app, because the list is shared by three consumers) and the port
// probe that turns a lost port into a clear hard error instead of a silent
// fallback that breaks the Vite proxy and the WS client.

import assert from "node:assert/strict";
import net from "node:net";
import { test } from "node:test";
import { SETTING_KEYS } from "../lib/settings-keys.js";
import { buildAgentEnv, isPortFree } from "../local-services.js";

test("agent env forwards only keys on the shared SETTING_KEYS list", () => {
  const env = {
    LLM_API_KEY: "sk-test",
    DEFAULT_MODEL: "m",
    // Not a user-facing setting: must not reach the child env.
    HOME: "/Users/someone",
    PLATFORM_DATA_DIR: "/tmp/x",
    RANDOM_THING: "nope",
  };
  const out = buildAgentEnv(env);
  assert.deepEqual(out, { LLM_API_KEY: "sk-test", DEFAULT_MODEL: "m" });
  for (const k of Object.keys(out)) {
    assert.ok(SETTING_KEYS.includes(k), `${k} came from the shared list`);
  }
});

test("unset and empty values are dropped, not forwarded as empty strings", () => {
  const out = buildAgentEnv({ LLM_API_KEY: "", DEFAULT_MODEL: undefined, LOGTO_ENDPOINT: null });
  assert.deepEqual(out, {}, "a key present but empty is the same as absent");
});

test("every setting key present in the source is forwarded", () => {
  const env = {};
  for (const k of SETTING_KEYS) env[k] = `v-${k}`;
  const out = buildAgentEnv(env);
  assert.deepEqual(Object.keys(out).sort(), [...SETTING_KEYS].sort());
  // Values are stringified: the child env is a string map, and a numeric PORT
  // or boolean flag from .env must not arrive as a non-string.
  assert.equal(out[SETTING_KEYS[0]], `v-${SETTING_KEYS[0]}`);
});

test("port probe: occupied port reads busy, released port reads free", async (t) => {
  const blocker = net.createServer();
  await new Promise((resolve, reject) => {
    blocker.once("error", reject);
    blocker.listen(0, "127.0.0.1", resolve);
  });
  const port = blocker.address().port;
  t.after(() => new Promise((resolve) => blocker.close(resolve)));

  assert.equal(await isPortFree(port), false, "a bound port is not free");

  await new Promise((resolve) => blocker.close(resolve));
  assert.equal(await isPortFree(port), true, "the same port is free once released");
});
