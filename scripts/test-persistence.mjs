// Unit tests for lib/persistence.js (node:test, self-contained tmpdir):
// exact-bytes atomic writes with no temp leftovers, unique temp names under
// concurrency, readJsonOr fallback policy, and the write-chain serializer
// (no lost update + BusyError on tryMutate contention).

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  atomicWriteJson,
  atomicWriteJsonSync,
  atomicWriteTextSync,
  readJsonOr,
  createWriteChain,
  BusyError,
  truncateTitle,
  normalizeBaseUrl,
} from "../lib/persistence.js";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "paas-persistence-"));
test.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));
const tmpFile = (name) => path.join(tmpRoot, name);

test("atomic write produces exact bytes and no temp leftovers (async)", async () => {
  const file = tmpFile("exact.json");
  const value = { providers: [{ id: "a", name: "A" }] };
  await atomicWriteJson(file, value);
  assert.equal(fs.readFileSync(file, "utf8"), JSON.stringify(value, null, 2));
  assert.deepEqual(fs.readdirSync(tmpRoot).filter((f) => f.endsWith(".tmp")), []);
});

test("sync variants write identical bytes", () => {
  const file = tmpFile("sync.json");
  atomicWriteJsonSync(file, { a: 1 });
  assert.equal(fs.readFileSync(file, "utf8"), '{\n  "a": 1\n}');
  const txt = tmpFile("sync.txt");
  atomicWriteTextSync(txt, "line1\nline2\n");
  assert.equal(fs.readFileSync(txt, "utf8"), "line1\nline2\n");
  assert.deepEqual(fs.readdirSync(tmpRoot).filter((f) => f.endsWith(".tmp")), []);
});

test("concurrent saves use distinct temp paths — final file is whole, never corrupt", async () => {
  const file = tmpFile("race.json");
  const payloads = Array.from({ length: 8 }, (_, i) => ({ n: i, pad: "x".repeat(4096) }));
  await Promise.all(payloads.map((p) => atomicWriteJson(file, p)));
  // Whichever save won, the file must parse as one of the payloads exactly.
  const final = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.ok(payloads.some((p) => p.n === final.n));
  assert.deepEqual(fs.readdirSync(tmpRoot).filter((f) => f.endsWith(".tmp")), []);
});

test("readJsonOr: missing file returns fallback silently", () => {
  assert.deepEqual(readJsonOr(tmpFile("absent.json"), { fallback: true }), { fallback: true });
});

test("readJsonOr: corrupt file warns and returns fallback, never throws", () => {
  const file = tmpFile("corrupt.json");
  fs.writeFileSync(file, "{ not json", "utf8");
  assert.deepEqual(readJsonOr(file, [1, 2], { label: "test" }), [1, 2]);
});

test("readJsonOr: non-object JSON returns fallback", () => {
  const file = tmpFile("scalar.json");
  fs.writeFileSync(file, "42", "utf8");
  assert.deepEqual(readJsonOr(file, { fallback: true }), { fallback: true });
});

test("write chain: concurrent mutate() applies both — no lost update", async () => {
  const chain = createWriteChain();
  const state = { count: 0 };
  await Promise.all([
    chain.mutate(async () => {
      const n = state.count;
      await new Promise((r) => setTimeout(r, 5));
      state.count = n + 1;
    }),
    chain.mutate(async () => {
      const n = state.count;
      await new Promise((r) => setTimeout(r, 1));
      state.count = n + 1;
    }),
  ]);
  assert.equal(state.count, 2);
});

test("write chain: tryMutate rejects a concurrent second call with BusyError", async () => {
  const chain = createWriteChain();
  let release;
  const gate = new Promise((r) => (release = r));
  const first = chain.tryMutate(async () => {
    await gate;
  });
  await assert.rejects(() => chain.tryMutate(async () => {}), (e) => e instanceof BusyError && e.code === "busy");
  release();
  await first;
  // After the first completes, tryMutate works again.
  assert.equal(await chain.tryMutate(async () => 7), 7);
});

test("shared helpers: truncateTitle + normalizeBaseUrl", () => {
  assert.equal(truncateTitle("  a\nb  "), "a b");
  assert.equal(truncateTitle("x".repeat(80)).length, 61);
  assert.equal(normalizeBaseUrl("https://api.example.com"), "https://api.example.com/v1");
  assert.equal(normalizeBaseUrl("https://api.example.com/v1/"), "https://api.example.com/v1");
});
