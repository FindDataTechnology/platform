// facet × 免键 MCP 鉴权三道（add-universal-keyless-mcp-auth）
// 能力表只收机器证据；选道可解释；L2 只写短 access token（不写 refresh）；
// PKCE 与续期可离线驱动（桩授权服务器，不开浏览器）。
//
// 运行：node --test scripts/test-facet-mcp-auth.mjs
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm, readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const CLI = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "facet", "cli", "facet.js");
const CAP = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "facet", "cli", "mcp-auth-capability.js");

const { LANE, hasEvidence, isStale, findCapability, selectLane } = await import(CAP);

// ── 能力表：只信证据 ────────────────────────────────────────────────────────
test("能力记录缺证据即视为不存在，不能据此选 L1", () => {
  assert.equal(hasEvidence({ client: "x", evidence: {} }), false);
  assert.equal(hasEvidence({ client: "x" }), false);
  assert.equal(hasEvidence({ evidence: { probe: "p", at: "2026-10-30", build: "b" } }), true);
  // selectLane 对无记录客户端 → 兜底 L2（有浏览器时）
  const pick = selectLane("nonexistent-client", { hasBrowser: true });
  assert.equal(pick.lane, LANE.BROKERED);
  assert.match(pick.reason, /无能力表记录/);
});

test("WorkBuddy 5.9.x：用户文件不消费 oauth 块 → 选 L2 而非 L1", () => {
  const pick = selectLane("workbuddy", { hasBrowser: true });
  assert.equal(pick.lane, LANE.BROKERED, "必须选代持令牌道");
  assert.match(pick.reason, /不消费静态 client_id/);
  assert.equal(pick.record.oauthClientId, false);
  assert.equal(pick.record.headerStatic, true);
});

test("版本与证据不符 → 记录 stale，降级 L2 并提示待复验", () => {
  const pick = selectLane("workbuddy", { installedBuild: "WorkBuddy 5.10.0", hasBrowser: true });
  assert.equal(pick.lane, LANE.BROKERED);
  assert.match(pick.reason, /待复验/);
  assert.equal(isStale({ evidence: { build: "WorkBuddy 5.9.3 (app.asar)" } }, "WorkBuddy 5.10.0"), true);
  assert.equal(isStale({ evidence: { build: "WorkBuddy 5.9.3 (app.asar)" } }, "5.9.3"), false);
});

test("无浏览器时降级为调用键 L3", () => {
  const pick = selectLane("workbuddy", { hasBrowser: false });
  assert.equal(pick.lane, LANE.KEY);
});

test("六 target 都有能力记录且证据齐全", () => {
  for (const t of ["workbuddy", "CC", "cursor", "zcode", "codex", "gemini-cli"]) {
    const rec = findCapability(t);
    assert.ok(rec, `${t} 缺记录`);
    assert.equal(rec.usable, true, `${t} 记录缺证据`);
    assert.equal(rec.headerStatic, true, `${t} 应支持静态头（L2 前提）`);
  }
});

// ── 令牌视图与拒绝分类 ──────────────────────────────────────────────────────
test("describeToken 读出余期/可续期性，classifyRefusal 三分类", async () => {
  const cli = await import("../facet/cli/facet.js");
  const claims = { aud: "https://mcp.finddatatech.cloud", username: "u@example.com", roles: ["r1"], exp: Math.floor(Date.now() / 1000) + 600 };
  const jwt = `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;
  const view = cli.describeToken({ access_token: jwt });
  assert.equal(view.username, "u@example.com");
  assert.equal(view.renewable, false);
  assert.ok(view.minutesLeft > 0 && !view.expired);
  assert.equal(cli.describeToken({ access_token: jwt, refresh_token: "r" }).renewable, true);

  assert.equal(cli.classifyRefusal(401, "invalid_token").kind, "expired");
  assert.equal(cli.classifyRefusal(403, "group required").kind, "group");
  assert.equal(cli.classifyRefusal(405, "").kind, "disabled");
});

// ── PKCE 全链（桩授权服务器，不开浏览器） ──────────────────────────────────
async function stubAuth({ issueRefresh = true } = {}) {
  const seen = { auth: null, token: null };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://127.0.0.1");
    if (u.pathname === "/auth") {
      seen.auth = Object.fromEntries(u.searchParams);
      // Redirect back to the loopback callback the CLI is listening on.
      const back = new URL(u.searchParams.get("redirect_uri"));
      back.searchParams.set("code", "CODE-1");
      back.searchParams.set("state", u.searchParams.get("state"));
      res.writeHead(302, { Location: back.toString() }).end();
      return;
    }
    if (u.pathname === "/token") {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        seen.token = Object.fromEntries(new URLSearchParams(body));
        const payload = {
          access_token: `h.${Buffer.from(JSON.stringify({ aud: "https://mcp.finddatatech.cloud", username: "u@example.com", exp: Math.floor(Date.now() / 1000) + 600 })).toString("base64url")}.s`,
          token_type: "Bearer",
          expires_in: 600,
          scope: "openid gateway:access offline_access",
          ...(issueRefresh ? { refresh_token: "RT-1" } : {}),
        };
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(payload));
      });
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, base: `http://127.0.0.1:${server.address().port}`, seen };
}

test("PKCE：authorize 带 prompt=consent 与 resource，回调换回令牌", async () => {
  const { server, base, seen } = await stubAuth();
  try {
    const cli = await import("../facet/cli/facet.js");
    const doc = await cli.pkceAuthorize({
      authBase: base,
      clientId: "cid-test",
      scope: "openid gateway:access offline_access",
      resource: "https://mcp.finddatatech.cloud",
      noOpen: true,
      // Test seam: act as the browser — hit /auth, follow the 302 back to the
      // CLI's loopback callback. No real browser, no manual step.
      onAuthorizeUrl: async (url) => {
        const r = await fetch(url, { redirect: "manual" });
        const loc = r.headers.get("location");
        assert.ok(loc, "桩授权服务器必须回 302 到回调");
        await fetch(loc);
      },
    });
    assert.equal(seen.auth.client_id, "cid-test");
    assert.equal(seen.auth.code_challenge_method, "S256");
    assert.equal(seen.auth.prompt, "consent", "必须强制 consent 才可能拿到 refresh_token");
    assert.equal(seen.auth.resource, "https://mcp.finddatatech.cloud", "RFC 8707 resource 原样发出");
    assert.match(seen.auth.redirect_uri, /^http:\/\/127\.0\.0\.1:\d+\/oauth\/callback$/);
    assert.equal(seen.token.grant_type, "authorization_code");
    assert.ok(seen.token.code_verifier, "必须带 PKCE verifier");
    assert.ok(doc.access_token);
    assert.equal(doc.refresh_token, "RT-1");
  } finally { server.close(); }
});

test("L2 写入：只写 access token，不落 refresh token，文件 0600", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "facet-auth-home-"));
  const proj = await mkdtemp(path.join(tmpdir(), "facet-auth-proj-"));
  const pack = http.createServer((req, res) => {
    if (req.url === "/api/packs/pk1") {
      res.writeHead(200, { "Content-Type": "application/json" })
        .end(JSON.stringify({ id: "pk1", name: "P", version: 1, manifest: { skills: [], mcpServers: [{ registryName: "fd-daas-mcp" }] } }));
      return;
    }
    res.writeHead(404).end("{}");
  });
  await new Promise((r) => pack.listen(0, "127.0.0.1", r));
  try {
    const base = `http://127.0.0.1:${pack.address().port}`;
    // seed a fresh token so the flow does not need the browser
    const jwt = `h.${Buffer.from(JSON.stringify({ aud: "https://mcp.finddatatech.cloud", username: "u@example.com", exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")}.s`;
    await mkdir(path.join(home, ".facet"), { recursive: true });
    await writeFile(path.join(home, ".facet", "oauth.json"), JSON.stringify({ access_token: jwt, refresh_token: "RT-secret", expires_in: 3600, obtained_at: Date.now() }), "utf8");

    await run(process.execPath, [CLI, "auth", "pk1", "--target", "workbuddy", "--write-mcp", "--base", base, "--registry", base, "--no-open"], {
      env: { ...process.env, FACET_HOME: home },
    });

    const cfg = await readFile(path.join(home, ".workbuddy", "mcp.json"), "utf8");
    const entry = JSON.parse(cfg).mcpServers["fd-daas-mcp"];
    assert.equal(entry.type, "http");
    assert.equal(entry.url, `${base}/fd-daas-mcp/mcp`);
    assert.match(entry.headers.Authorization, /^Bearer h\./);
    assert.ok(!cfg.includes("RT-secret"), "refresh token 绝不可写进客户端配置");
    const mode = (await stat(path.join(home, ".workbuddy", "mcp.json"))).mode & 0o777;
    assert.equal(mode, 0o600, "承载令牌的配置必须 0600");
  } finally {
    pack.close();
    await rm(home, { recursive: true, force: true });
    await rm(proj, { recursive: true, force: true });
  }
});

// ── 续期：必须重放 resource，绝不可重放 scope（生产实测约束） ──────────────
// Logto 两条硬约束：不带 resource → 返回无 aud 的客户端 opaque token（网关不认）；
// 带 scope → 400 invalid_scope「refresh token missing requested scope」。
test("refresh 重放 resource、不发 scope，并落盘轮换后的 refresh token", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "facet-refresh-"));
  const seen = {};
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      seen.form = Object.fromEntries(new URLSearchParams(body));
      const payload = {
        access_token: `h.${Buffer.from(JSON.stringify({ aud: "https://mcp.finddatatech.cloud", username: "u@example.com", exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")}.s`,
        token_type: "Bearer",
        expires_in: 3600,
        refresh_token: "RT-2",
      };
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(payload));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    await mkdir(path.join(home, ".facet"), { recursive: true });
    await writeFile(path.join(home, ".facet", "oauth.json"), JSON.stringify({
      access_token: "expired", refresh_token: "RT-1", expires_in: 60, obtained_at: Date.now() - 120000,
      resource: "https://mcp.finddatatech.cloud", scope: "openid gateway:access offline_access", client_id: "cid",
    }), "utf8");

    const { stdout } = await run(process.execPath, ["-e", `
      const cli = await import(${JSON.stringify(CLI)});
      const out = await cli.refreshOAuthToken({ authBase: ${JSON.stringify(base)}, clientId: "cid" });
      console.log(JSON.stringify({ ok: Boolean(out), rt: out?.refresh_token, aud: cli.describeToken(out).audience }));
    `], { env: { ...process.env, FACET_HOME: home } });

    assert.equal(seen.form.grant_type, "refresh_token");
    assert.equal(seen.form.resource, "https://mcp.finddatatech.cloud", "必须重放 resource，否则拿到无 aud 的 opaque token");
    assert.equal(seen.form.scope, undefined, "不可重放 scope——Logto 会 400 invalid_scope");
    const out = JSON.parse(stdout.trim().split("\n").pop());
    assert.equal(out.ok, true);
    assert.equal(out.rt, "RT-2", "轮换后的 refresh token 必须落盘");
    assert.equal(out.aud, "https://mcp.finddatatech.cloud");
    const saved = JSON.parse(await readFile(path.join(home, ".facet", "oauth.json"), "utf8"));
    assert.equal(saved.refresh_token, "RT-2");
  } finally {
    server.close();
    await rm(home, { recursive: true, force: true });
  }
});

// ── 续期必须原地改写客户端配置（真机抓到的缺陷） ────────────────────────────
// 只续期不回写，等于告诉用户「已续期」而客户端还握着旧令牌。这里用 CLI 真实
// 子进程跑 `facet auth --refresh`，断言 ~/.workbuddy/mcp.json 里的 Bearer 换成新值。
test("--refresh 后把新令牌原地写回客户端配置（只改旧令牌，不动别的凭据）", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "facet-auth-rewrite-"));
  const server = http.createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      const newJwt = `h.${Buffer.from(JSON.stringify({ aud: "https://mcp.finddatatech.cloud", username: "u@example.com", exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")}.s`;
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({
        access_token: newJwt, token_type: "Bearer", expires_in: 3600, refresh_token: "RT-NEW",
      }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const oldJwt = `h.${Buffer.from(JSON.stringify({ aud: "https://mcp.finddatatech.cloud", username: "u@example.com", exp: Math.floor(Date.now() / 1000) - 60 })).toString("base64url")}.s`;
    await mkdir(path.join(home, ".facet"), { recursive: true });
    await writeFile(path.join(home, ".facet", "oauth.json"), JSON.stringify({
      access_token: oldJwt, refresh_token: "RT-OLD", expires_in: 60, obtained_at: Date.now() - 120000,
      resource: "https://mcp.finddatatech.cloud",
    }), "utf8");
    // 已写入的客户端配置：一条带旧令牌（应被改写），一条带别人的键（必须不动）
    await mkdir(path.join(home, ".workbuddy"), { recursive: true });
    await writeFile(path.join(home, ".workbuddy", "mcp.json"), JSON.stringify({
      mcpServers: {
        "fd-daas-mcp": { type: "http", url: "https://mcp.finddatatech.cloud/fd-daas-mcp/mcp", headers: { Authorization: `Bearer ${oldJwt}` } },
        "other-mcp": { type: "http", url: "https://x/mcp", headers: { Authorization: "Bearer wgk-someone-elses-key" } },
      },
    }, null, 2) + "\n", "utf8");

    const { stdout } = await run(process.execPath, [CLI, "auth", "--refresh", "--auth-url", base], {
      env: { ...process.env, FACET_HOME: home },
    });
    assert.match(stdout, /已静默续期/);
    assert.match(stdout, /已原地改写配置/);

    const cfg = JSON.parse(await readFile(path.join(home, ".workbuddy", "mcp.json"), "utf8"));
    const saved = JSON.parse(await readFile(path.join(home, ".facet", "oauth.json"), "utf8"));
    assert.equal(cfg.mcpServers["fd-daas-mcp"].headers.Authorization, `Bearer ${saved.access_token}`, "旧令牌必须被换成续期后的令牌");
    assert.notEqual(cfg.mcpServers["fd-daas-mcp"].headers.Authorization, `Bearer ${oldJwt}`);
    assert.equal(cfg.mcpServers["other-mcp"].headers.Authorization, "Bearer wgk-someone-elses-key", "别人的凭据绝不可被覆盖");
  } finally {
    server.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("--status 报告余期与可续期性；无令牌时明说未登录", async () => {  const home = await mkdtemp(path.join(tmpdir(), "facet-auth-status-"));
  try {
    const { stdout: empty } = await run(process.execPath, [CLI, "auth", "--status"], { env: { ...process.env, FACET_HOME: home } });
    assert.match(empty, /未登录/);

    const jwt = `h.${Buffer.from(JSON.stringify({ aud: "https://mcp.finddatatech.cloud", username: "u@example.com", exp: Math.floor(Date.now() / 1000) + 900 })).toString("base64url")}.s`;
    await mkdir(path.join(home, ".facet"), { recursive: true });
    await writeFile(path.join(home, ".facet", "oauth.json"), JSON.stringify({ access_token: jwt, refresh_token: "RT", expires_in: 900, obtained_at: Date.now() }), "utf8");
    const { stdout } = await run(process.execPath, [CLI, "auth", "--status", "--target", "workbuddy"], { env: { ...process.env, FACET_HOME: home } });
    assert.match(stdout, /u@example\.com/);
    assert.match(stdout, /可续期\s+是/);
    assert.match(stdout, /workbuddy 能力表/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
