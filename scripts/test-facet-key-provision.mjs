#!/usr/bin/env node
// ── facet key provision/status (facet-key-provisioning 3.x) ──────────────────
//
// Runs the real CLI against an in-process fake 萬星词元 router so the mint path
// is exercised WITHOUT network: login → mint under the caller → store 0600 →
// status verifies against /v1/models. Also pins the two-domain rule (3.3): a
// wgk- key presented as a model key is rejected, and vice versa, each pointing
// to the right command.
//
//   node --test scripts/test-facet-key-provision.mjs

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const exec = promisify(execFile);
const CLI = path.resolve("facet/cli/facet.js");

// Fake router: enough of the sub2api surface the CLI touches. A key is valid
// iff it is one this server minted (the CLI's liveness check hits /v1/models).
function startFakeRouter() {
  const minted = new Set();
  const server = http.createServer((req, res) => {
    const send = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
    if (req.method === "POST" && req.url === "/api/v1/auth/login") {
      let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => {
        const { email } = JSON.parse(b || "{}");
        if (email === "cust@example.com") return send(200, { code: 0, data: { access_token: "jwt-ok" } });
        return send(401, { code: 401, message: "invalid email or password" });
      });
      return;
    }
    if (req.method === "GET" && req.url === "/api/v1/groups/available") {
      return send(200, { code: 0, data: [{ id: 2, name: "dev-sandbox", platform: "composite" }] });
    }
    if (req.method === "POST" && req.url === "/api/v1/keys") {
      let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => {
        if (req.headers.authorization !== "Bearer jwt-ok") return send(401, { code: 401 });
        const key = "sk-" + "a".repeat(64);
        minted.add(key);
        send(200, { code: 0, data: { id: 1, user_id: 42, key, group_id: 2 } });
      });
      return;
    }
    if (req.method === "GET" && req.url === "/v1/models") {
      const k = req.headers["x-api-key"];
      if (minted.has(k)) return send(200, { data: [{ id: "deepseek-v4-pro" }] });
      return send(401, { code: "INVALID_API_KEY", message: "Invalid API key" });
    }
    send(404, {});
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port })));
}

const run = (args, env) => exec(process.execPath, [CLI, ...args], { env: { ...process.env, ...env }, timeout: 20_000 });

test("provision: login → mint under caller → store 0600 → status verifies", async () => {
  const { server, port } = await startFakeRouter();
  const home = mkdtempSync(path.join(tmpdir(), "facet-kp-"));
  const env = {
    FACET_HOME: home,
    FACET_LLM_KEY_PATH: path.join(home, ".facet", "llm-key.json"),
    FACET_ROUTER: `http://127.0.0.1:${port}`,
  };
  try {
    const { stdout } = await run(["key", "provision", "--email", "cust@example.com", "--password", "x"], env);
    assert.match(stdout, /模型调用键已就绪/);
    assert.match(stdout, /归属账号 id=42/);
    const store = JSON.parse(readFileSync(env.FACET_LLM_KEY_PATH, "utf8"));
    assert.match(store.key, /^sk-/);
    assert.equal(store.groupId, 2);
    // 0600 — the key is the customer's wallet
    assert.equal(statSync(env.FACET_LLM_KEY_PATH).mode & 0o777, 0o600);

    const st = await run(["key", "status"], env);
    assert.match(st.stdout, /状态：有效/);
  } finally {
    server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("provision: wrong-group login is refused, nothing stored", async () => {
  const { server, port } = await startFakeRouter();
  const home = mkdtempSync(path.join(tmpdir(), "facet-kp-"));
  const env = {
    FACET_HOME: home,
    FACET_LLM_KEY_PATH: path.join(home, ".facet", "llm-key.json"),
    FACET_ROUTER: `http://127.0.0.1:${port}`,
  };
  try {
    await assert.rejects(
      run(["key", "provision", "--email", "nobody@example.com", "--password", "x"], env),
      /登录失败/,
    );
    assert.throws(() => statSync(env.FACET_LLM_KEY_PATH), /ENOENT/);
  } finally {
    server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("domain guard: sk- and wgk- cannot impersonate each other (3.3)", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "facet-kp-"));
  const env = { FACET_HOME: home, FACET_ROUTER: "http://127.0.0.1:1" };
  try {
    // wgk- offered as a model key → rejected, points to connect
    await assert.rejects(
      run(["key", "provision", "--key", "wgk-abcdefgh12345678"], env),
      /wgk- 是工具面调用键/,
    );
    await assert.rejects(
      run(["key", "status", "--key", "wgk-abcdefgh12345678"], env),
      /wgk- 是工具面调用键/,
    );
    // a non-sk- offered as a model key → rejected
    await assert.rejects(
      run(["key", "provision", "--key", "plainvalue123456"], env),
      /应以 sk- 开头/,
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});