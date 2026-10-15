import { test, expect } from "@playwright/test";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { pinLocaleEn, prepareTempStoreDirs, spawnTestServer } from "./helpers.js";
import { signSession } from "../server/session.js";

function freePort() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitFor(predicate, ms = 90_000) {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > ms) throw new Error("waitFor timeout");
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

function openWs(base, cookie) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://${new URL(base).host}/`, {
      headers: cookie ? { cookie: `paas_session=${cookie}` } : {},
    });
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

test.describe("AUTH_MODE=logto", () => {
  test.describe.configure({ timeout: 120_000 });

  let base;
  let child;
  let server;
  let fixtureServer;
  let bootLog;
  let secret;
  let cookie;
  // Its own tree: this spec boots a second server, so it must not share — or,
  // as a worker-time call, wipe — the webServer's stores.
  const stores = prepareTempStoreDirs({ subdir: "logto" });

  test.beforeAll(async () => {
    const fixturePort = await freePort();
    const fixture = `http://127.0.0.1:${fixturePort}`;
    fixtureServer = http.createServer((req, res) => {
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/oidc/.well-known/openid-configuration") {
        res.end(JSON.stringify({
          issuer: `${fixture}/oidc`,
          authorization_endpoint: `${fixture}/oidc/auth`,
          token_endpoint: `${fixture}/oidc/token`,
          jwks_uri: `${fixture}/oidc/jwks`,
          end_session_endpoint: `${fixture}/oidc/logout`,
        }));
        return;
      }
      if (req.url === "/oidc/jwks") {
        res.end(JSON.stringify({ keys: [] }));
        return;
      }
      res.statusCode = 404;
      res.end("{}");
    });
    await new Promise((resolve) => fixtureServer.listen(fixturePort, "127.0.0.1", resolve));

    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    secret = "logto-e2e-secret";
    cookie = signSession({
      email: "logto@example.com",
      groups: ["users"],
      exp: Math.floor(Date.now() / 1000) + 60 * 60,
    }, secret);
    bootLog = "";
    server = spawnTestServer({
      env: {
        ...process.env,
        PORT: String(port),
        HOST: "127.0.0.1",
        AUTH_MODE: "logto",
        PAAS_BASE_URL: base,
        SESSION_SECRET: secret,
        SESSION_TTL_HRS: "1",
        LOGTO_ENDPOINT: fixture,
        LOGTO_APP_ID: "client",
        LOGTO_APP_SECRET: "secret",
        LOGTO_CLIENT_TYPE: "confidential",
        LOGTO_END_SESSION: "false",
        AGENTS_CONFIG_URL: "",
        CATALOG_REFRESH_SECS: "0",
        CHAT_HISTORY_STORE_DIR: stores.chat,
        DOCUMENTS_STORE_DIR: stores.docs,
        SESSIONS_STORE_DIR: stores.sessions,
        DB_PATH: stores.db,
        MCP_CONFIG_PATH: path.join(stores.root, "mcp.json"),
        LLM_PROVIDERS_STORE: stores.llmProviders,
        LLM_DEFAULT_STORE: stores.llmDefault,
        // Workers do not inherit the webServer's env, so without these this
        // server's dsh child would compose against the developer's real ~/.dsh
        // and rewrite its settings.yaml.
        DSH_HOME: stores.dshHome,
        DSH_SHARED_HOME: process.env.DSH_SHARED_HOME || path.join(os.homedir(), ".dsh"),
      },
    });
    child = server.child;
    child.stdout.on("data", (data) => { bootLog += data; });
    child.stderr.on("data", (data) => { bootLog += data; });

    // Gate on /api/ready, not /api/auth/me: the server listens FIRST and
    // initializes the agent in the background (listen-first boot), and this
    // spec's stores are wiped + recomposed fresh each run — a cold profile
    // composition can exceed a minute on a loaded machine (the main
    // webServer's own timeout allows 180s for the same reason).
    await waitFor(async () => {
      try {
        const response = await fetch(`${base}/api/ready`);
        return response.ok;
      } catch {
        return false;
      }
    }, 180_000, `server ready\n${bootLog.slice(-2000)}`);
  });

  test.afterAll(async () => {
    if (server) await server.stop();
    child = null;
    if (fixtureServer) await new Promise((resolve) => fixtureServer.close(resolve));
    fs.rmSync(stores.root, { recursive: true, force: true });
  });

  test("anonymous browser requests are routed to login", async ({ page }) => {
    await pinLocaleEn(page);
    await page.goto(`${base}/chat`);
    await expect(page).toHaveURL(`${base}/login`);
    await expect(page.getByTestId("login-page")).toBeVisible();
  });

  test("callback errors are shown on the login page", async ({ page }) => {
    await pinLocaleEn(page);
    await page.goto(`${base}/login?auth_error=state`);
    await expect(page.getByRole("alert")).toContainText("expired or did not match");
  });

  test("seeded session opens the shell and account page", async ({ page, context }) => {
    await context.addCookies([{ name: "paas_session", value: cookie, url: base, httpOnly: true, sameSite: "Lax" }]);
    await pinLocaleEn(page);
    await page.goto(`${base}/chat`);
    await expect(page.getByTestId("status-text")).toHaveText("Connected", { timeout: 15000 });
    await expect(page.locator('[data-testid="session-row"]').first()).toHaveCount(1);

    await page.goto(`${base}/settings/account`);
    await expect(page.getByTestId("settings-account")).toBeVisible();
    await expect(page.getByTestId("account-email")).toHaveText("logto@example.com");
    const logout = page.getByTestId("sso-logout");
    await expect(logout).toBeVisible();
    expect(await logout.getAttribute("href")).toContain("/api/auth/logout?rd=");
  });

  test("logout clears the session and WS requires a valid cookie", async ({ page, context }) => {
    await context.addCookies([{ name: "paas_session", value: cookie, url: base, httpOnly: true, sameSite: "Lax" }]);
    await page.goto(`${base}/settings/account`);
    await expect(page.getByTestId("account-email")).toHaveText("logto@example.com");
    await page.evaluate(async () => fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" }));
    const identity = await page.evaluate(async () => (await fetch("/api/auth/me", { credentials: "same-origin" })).json());
    expect(identity.authenticated).toBe(false);

    await expect(openWs(base, cookie)).resolves.toBeDefined();
    await expect(openWs(base, "invalid")).rejects.toThrow();
  });
});
