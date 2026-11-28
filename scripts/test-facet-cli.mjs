#!/usr/bin/env node
// ── Facet CLI prefs tests (add-caller-preferences 4.1) ──────────────────────
//
// Spawn-level tests: the CLI is a self-contained script (top-level await,
// process.exit), so the honest harness runs it as a child process against a
// stub facade that records requests. Covers argument shapes (set/clear/show),
// the caller-key plumbing (flag + env), and refusal surfaces (missing key,
// bad flags, facade errors).
//
//   node --test scripts/test-facet-cli.mjs

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "facet", "cli", "facet.js");

function runCli(args, env = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { env: { ...process.env, ...env }, timeout: 15_000 }, (err, stdout, stderr) => {
      resolve({ code: err?.code ?? 0, stdout, stderr });
    });
  });
}

function stubFacade() {
  const seen = [];
  let prefs = { callbackUrl: null, callbackSecretSet: false, reapMinutes: null };
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : null;
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization ?? null, body });
      if (req.headers.authorization !== "Bearer sk-test-key") {
        res.writeHead(401, { "Content-Type": "application/json" }).end(JSON.stringify({ error: { code: "INVALID_KEY", message: "bad key" } }));
        return;
      }
      if (req.method === "PUT") {
        if (body.callbackUrl !== undefined) {
          prefs.callbackUrl = body.callbackUrl;
          prefs.callbackSecretSet = body.callbackSecret != null;
        }
        if (body.reapMinutes !== undefined) prefs.reapMinutes = body.reapMinutes;
      }
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ prefs }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, seen, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

test("facet prefs: show defaults, set both dimensions, clear all — against a stub facade", async () => {
  const { server, seen, base } = await stubFacade();
  try {
    // Read (defaults).
    let r = await runCli(["prefs", "packs-x-agent", "--key", "sk-test-key", "--wanxing", base]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /调用者偏好 · packs-x-agent/);
    assert.match(r.stdout, /回合完成回调：（未设）/);
    assert.match(r.stdout, /上下文收割窗：（平台默认）/);
    assert.deepEqual(seen.at(-1), { method: "GET", url: "/api/wanxing/v1/prefs/packs-x-agent", auth: "Bearer sk-test-key", body: null });

    // Set callback + reap in two steps (patch semantics stay exercised).
    r = await runCli(["prefs", "packs-x-agent", "--key", "sk-test-key", "--wanxing", base, "--set-callback", "https://cb.example/hook", "s3cret-sig"]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(seen.at(-1).body.callbackUrl, "https://cb.example/hook");
    assert.equal(seen.at(-1).body.callbackSecret, "s3cret-sig");
    r = await runCli(["prefs", "packs-x-agent", "--key", "sk-test-key", "--wanxing", base, "--set-reap", "45"]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(seen.at(-1).body.reapMinutes, 45);
    assert.match(r.stdout, /45 分钟/);

    // Clear all.
    r = await runCli(["prefs", "packs-x-agent", "--key", "sk-test-key", "--wanxing", base, "--clear", "all"]);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(seen.at(-1).body, { callbackUrl: null, callbackSecret: null, reapMinutes: null });

    // Env-provided key works without the flag.
    r = await runCli(["prefs", "packs-x-agent", "--wanxing", base], { FACET_CALLER_KEY: "sk-test-key" });
    assert.equal(r.code, 0, r.stderr);
  } finally {
    await new Promise((res) => server.close(res));
  }
});

test("facet prefs: refusals — missing key, bad reap value, bad --clear, facade auth error", async () => {
  const { server, base } = await stubFacade();
  try {
    let r = await runCli(["prefs", "packs-x-agent", "--wanxing", base]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /需要调用键/);

    r = await runCli(["prefs", "packs-x-agent", "--key", "sk-test-key", "--wanxing", base, "--set-reap", "0"]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /正整数分钟数/);

    r = await runCli(["prefs", "packs-x-agent", "--key", "sk-test-key", "--wanxing", base, "--clear", "everything"]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /--clear 只接受/);

    r = await runCli(["prefs", "packs-x-agent", "--key", "sk-wrong", "--wanxing", base]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /bad key/);

    r = await runCli(["prefs", "--key", "sk-test-key", "--wanxing", base]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /缺少 agent slug/);

    // --set-callback with one value refuses at parse time.
    r = await runCli(["prefs", "packs-x-agent", "--key", "sk-test-key", "--wanxing", base, "--set-callback", "https://cb.example/hook"]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /需要两个值/);
  } finally {
    await new Promise((res) => server.close(res));
  }
});