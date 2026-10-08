#!/usr/bin/env node
// ── Local mini-program rehearsal gateway ─────────────────────────────────────
//
// Boots the REAL gateway (real Logto from .env, real bind-code flow) with a
// MOCK WeChat code2Session upstream, so the mini program can rehearse the
// full first-login → bind → silent-relogin flow in devtools without the real
// MP AppSecret:
//
//   1. node scripts/dev-mp-gateway.mjs          (listens on :3080)
//   2. browser → http://localhost:3080          sign in with Logto (real)
//   3. browser → http://localhost:3080/api/mp/bindcode   copy the 6-digit code
//   4. mini program → set the server address to http://localhost:3080 →
//      enter the code on the login page → bound; relaunch → silent entry
//
// The mock accepts EVERY wx.login code and maps it to a fixed openid, so the
// devtools session "is" one WeChat user. Swap in the real MP_SECRET (and drop
// MP_JS_CODE_URL) on the cloud gateway for production.

import "dotenv/config";
import http from "node:http";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WECHAT_MOCK_PORT = 3990;
const GATEWAY_PORT = Number(process.env.GATEWAY_PORT || 3080);

const mockWechat = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname.endsWith("/sns/jscode2session")) {
    const code = url.searchParams.get("js_code") || "";
    // Codes shaped `openid-<suffix>` mint distinct openids, so a rehearsal can
    // exercise multi-user paths (fresh demo identities, per-user cells);
    // everything else maps to the one fixed devtools user as before.
    const openid = code.startsWith("openid-") ? `o-MOCK-${code.slice(7)}` : "o-DEVTOOLS-LOCAL-USER";
    console.log(`[mp-mock] code2Session code=${code} → ${openid}`);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ openid, session_key: "mock" }));
    return;
  }
  res.statusCode = 404;
  res.end();
});
await new Promise((r) => mockWechat.listen(WECHAT_MOCK_PORT, "127.0.0.1", r));

const cellRoot = mkdtempSync(path.join(tmpdir(), "mp-dev-cells-"));
const gateway = spawn(process.execPath, ["gateway/index.js"], {
  cwd: REPO,
  env: {
    ...process.env,
    GATEWAY_PORT: String(GATEWAY_PORT),
    GATEWAY_HOST: "127.0.0.1",
    CELL_DATA_ROOT: cellRoot,
    CELL_GATEWAY_SECRET: process.env.CELL_GATEWAY_SECRET || "dev-gateway-secret",
    // Mock WeChat: every wx.login code resolves to one fixed dev openid.
    MP_APPID: process.env.MP_APPID || "wx-dev-appid",
    MP_SECRET: process.env.MP_SECRET || "dev-mock-secret",
    MP_TOKEN_SECRET: process.env.MP_TOKEN_SECRET || "dev-mp-token-secret",
    MP_JS_CODE_URL: `http://127.0.0.1:${WECHAT_MOCK_PORT}/sns/jscode2session`,
    CELL_START_TIMEOUT_MS: "120000",
    CELL_IDLE_REAP_SECS: "0",
  },
  stdio: ["ignore", "inherit", "inherit"],
});

const shutdown = () => {
  mockWechat.close();
  gateway.kill("SIGTERM");
  setTimeout(() => gateway.kill("SIGKILL"), 3000).unref();
};
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, shutdown);
gateway.on("exit", (code) => {
  mockWechat.close();
  process.exit(code ?? 0);
});

console.log(`[dev-mp] mock WeChat on :${WECHAT_MOCK_PORT} (every code → one dev openid)`);
console.log(`[dev-mp] gateway on http://localhost:${GATEWAY_PORT} — cells under ${cellRoot}`);
console.log(`[dev-mp] next: sign in at http://localhost:${GATEWAY_PORT}, then open /api/mp/bindcode`);
