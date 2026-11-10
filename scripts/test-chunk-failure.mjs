// Unit tests for the chunk-failure core (openspec:
// harden-spa-shell-resilience, task 2.1). Framework-free, runs under plain
// node via `npm run test:unit`.

import assert from "node:assert/strict";
import { test } from "node:test";
import { chunkFailureKey, claimReloadOnce, isChunkLoadError } from "../web/src/lib/chunk-failure.ts";

test("chunk failure wording is recognized on all four engines", () => {
  assert.equal(isChunkLoadError(new Error("Failed to fetch dynamically imported module: http://h/assets/ZhiyuPage-abc123.js")), true);
  assert.equal(isChunkLoadError(new Error("error loading dynamically imported module: http://h/assets/x.js")), true);
  assert.equal(isChunkLoadError(new Error("Importing a module script failed.")), true);
  assert.equal(isChunkLoadError(Object.assign(new Error("missing"), { name: "ChunkLoadError" })), true);
  assert.equal(isChunkLoadError(new Error("Loading chunk 7 failed.")), true);
});

test("ordinary render errors are NOT chunk failures", () => {
  assert.equal(isChunkLoadError(new Error("Cannot read properties of undefined")), false);
  assert.equal(isChunkLoadError(null), false);
  assert.equal(isChunkLoadError("boom"), false);
});

test("claimReloadOnce: first claim wins, the same URL never reloads twice", () => {
  const store = memStore();
  const url = "http://h/assets/ZhiyuPage-abc.js";
  assert.equal(claimReloadOnce(url, store), true, "first failure may reload");
  assert.equal(claimReloadOnce(url, store), false, "same failure never loops");
  // a DIFFERENT stale chunk later in the session still self-heals once
  assert.equal(claimReloadOnce("http://h/assets/AppsPage-xyz.js", store), true);
});

test("claimReloadOnce: bounded tracking degrades to the error card", () => {
  const store = memStore();
  for (let i = 0; i < 10; i++) assert.equal(claimReloadOnce(`http://h/assets/c${i}-hash.js`, store), true);
  assert.equal(claimReloadOnce("http://h/assets/c10-hash.js", store), false);
});

test("claimReloadOnce: corrupt store payload is treated as empty", () => {
  const store = memStore();
  store.setItem("shell-reload-chunks", "{not json");
  assert.equal(claimReloadOnce("http://h/a.js", store), true);
});

test("chunkFailureKey is stable and message-based", () => {
  const e = new Error("Failed to fetch dynamically imported module: http://h/assets/x.js");
  assert.equal(chunkFailureKey(e), chunkFailureKey(e));
  assert.equal(chunkFailureKey(null), "unknown");
});

function memStore() {
  const m = new Map();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v) };
}
