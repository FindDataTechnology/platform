// The Models page's family mirror must agree with the server's table
// (fix-model-window-family-reconcile, task 4.6).
//
// Why this file exists: the client mirror in packages/core/src/api/llm-api.ts is
// what the roster editor prefills from, and it shipped WITHOUT a `contextWindow`
// field — every prefill got the conservative 128000, so one operator save wrote
// that default straight back over the family value. A mirror allowed to disagree
// with the table is a second source of truth; this test pins them together.
//
// @platform/core exports raw TS (Vite consumes it), and node ESM will not resolve
// the bundler-style `from "./http"`. So the two files are copied into a temp dir
// with the extension made explicit and loaded with node's own type stripping —
// no bundler, no typescript dependency, and the real function runs.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CORE_API = path.join(REPO_ROOT, "packages/core/src/api");

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "llm-client-family-"));
fs.copyFileSync(path.join(CORE_API, "http.ts"), path.join(tmpDir, "http.ts"));
fs.writeFileSync(
  path.join(tmpDir, "llm-api.ts"),
  fs.readFileSync(path.join(CORE_API, "llm-api.ts"), "utf8")
    .replaceAll('from "./http"', 'from "./http.ts"'),
);

const client = await import(pathToFileURL(path.join(tmpDir, "llm-api.ts")).href);
const server = await import(pathToFileURL(path.join(REPO_ROOT, "llm-providers.js")).href);

test("client mirror knows the measured 1M window", () => {
  assert.equal(client.clientModelFamilyMeta("deepseek-v4.1-flash").contextWindow, 1_000_000);
  assert.equal(client.clientModelFamilyMeta("deepseek/deepseek-v4.1-flash").contextWindow, 1_000_000);
});

test("client mirror agrees with the server table for every family", () => {
  const ids = [
    "deepseek-v4.1-flash",
    "deepseek-v4-pro",
    "deepseek/deepseek-v4.1-flash",
    "deepseek-chat",
    "glm-5.3-flash",
    "glm-5.2",
    "mimo-v2.6-flash",
    "kimi-k2.6",
    "cohere/north-mini-code:free",
  ];
  for (const id of ids) {
    const c = client.clientModelFamilyMeta(id);
    const s = server.modelFamilyMeta(id);
    assert.equal(c.contextWindow, s.contextWindow, `contextWindow drift for ${id}`);
    assert.equal(c.maxTokens, s.maxTokens, `maxTokens drift for ${id}`);
    assert.deepEqual(c.reasoningEfforts, s.reasoningEfforts, `reasoningEfforts drift for ${id}`);
  }
});

test("an unknown family still gets the conservative default on both sides", () => {
  assert.equal(client.clientModelFamilyMeta("zeta-model").contextWindow, 128000);
  assert.equal(client.clientModelFamilyMeta("zeta-model").maxTokens, 8192);
});
