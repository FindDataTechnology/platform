import { test, expect } from "@playwright/test";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { pinLocaleEn } from "./helpers.js";
import { signSession } from "../server/session.js";

// Deployment branding (openspec: add-deployment-branding). A second `node
// server.js` under AUTH_MODE=logto + a hermetic OIDC fixture (the logto.spec.js
// pattern): the login page renders for anonymous visitors (auth-off would
// redirect /login to /chat), admin mutations ride a signed session cookie, and
// the whole surface — /api/config resolution, PUT validation, branded login
// card + favicon, settings section, locale picker — runs against one server.
//
// Serial mode: the tests are a stateful chain (unbranded → PUT → branded →
// clear) over one spawned server; Playwright must not spread them across
// workers (each worker re-runs beforeAll with a fresh DB).

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function waitFor(predicate, ms = 120_000, label = "condition") {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > ms) throw new Error(`waitFor timeout: ${label}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "paas-branding-e2e-"));
const SECRET = "branding-e2e-secret";

let child;
let fixtureServer;
let BASE;
let bootLog = "";
let adminCookie;
let userCookie;

async function api(pathname, { method = "GET", cookie, body } = {}) {
  const headers = {};
  if (cookie) headers.cookie = `paas_session=${cookie}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${BASE}${pathname}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* status is the signal */
  }
  return { status: res.status, json };
}

test.describe("deployment branding (logto mode)", () => {
  test.describe.configure({ mode: "serial", timeout: 180_000 });

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
    BASE = `http://127.0.0.1:${port}`;
    const exp = Math.floor(Date.now() / 1000) + 60 * 60;
    adminCookie = signSession({ email: "admin@example.com", groups: ["users", "admin"], exp }, SECRET);
    userCookie = signSession({ email: "user@example.com", groups: ["users"], exp }, SECRET);

    child = spawn(process.execPath, ["server.js"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PORT: String(port),
        HOST: "127.0.0.1",
        AUTH_MODE: "logto",
        PAAS_BASE_URL: BASE,
        SESSION_SECRET: SECRET,
        SESSION_TTL_HRS: "1",
        LOGTO_ENDPOINT: fixture,
        LOGTO_APP_ID: "client",
        LOGTO_APP_SECRET: "secret",
        LOGTO_CLIENT_TYPE: "confidential",
        LOGTO_END_SESSION: "false",
        AGENTS_CONFIG_URL: "",
        CATALOG_REFRESH_SECS: "0",
        // Hermetic branding envs: the ambient shell must not seed values.
        COMPANY_NAME: "",
        ASSISTANT_NAME: "",
        BRAND_ICON_URL: "",
        LOGIN_FOOTER_TEXT: "",
        CHAT_HISTORY_STORE_DIR: path.join(tmpRoot, "chat"),
        DOCUMENTS_STORE_DIR: path.join(tmpRoot, "docs"),
        SESSIONS_STORE_DIR: path.join(tmpRoot, "sessions"),
        LLM_PROVIDERS_STORE: path.join(tmpRoot, "llm-providers.json"),
        LLM_DEFAULT_STORE: path.join(tmpRoot, "llm-default.json"),
        DB_PATH: path.join(tmpRoot, "app.db"),
        MCP_CONFIG_PATH: path.join(tmpRoot, "mcp.json"),
        DSH_HOME: path.join(tmpRoot, "dsh-home"),
        DSH_SHARED_HOME: process.env.DSH_SHARED_HOME || path.join(os.homedir(), ".dsh"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (d) => (bootLog += d));
    child.stderr.on("data", (d) => (bootLog += d));
    await waitFor(
      async () => {
        try {
          const r = await fetch(`${BASE}/api/ready`);
          return r.ok;
        } catch {
          return false;
        }
      },
      120_000,
      `server ready\n${bootLog.slice(-2000)}`,
    );
  });

  test.afterAll(async () => {
    if (child) {
      child.kill("SIGKILL");
      child = null;
    }
    if (fixtureServer) await new Promise((resolve) => fixtureServer.close(resolve));
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  test("unbranded login renders defaults: no icon, no footer, no favicon link", async ({ page }) => {
    const cfg = await api("/api/config");
    expect(cfg.json).toMatchObject({ companyName: null, assistantName: null, brandIconUrl: null, loginFooterText: null });

    await pinLocaleEn(page);
    await page.goto(`${BASE}/login`);
    await expect(page.getByTestId("login-page")).toBeVisible();
    await expect(page.getByTestId("login-brand-icon")).toHaveCount(0);
    await expect(page.getByTestId("login-footer")).toHaveCount(0);
    expect(await page.evaluate(() => document.querySelector('link[rel="icon"]'))).toBeNull();
    // Locale picker present + the login link carries rd and the locale hint.
    await expect(page.getByTestId("login-locale-select")).toBeVisible();
    const href = await page.getByTestId("sso-login").getAttribute("href");
    expect(href).toContain("rd=");
    expect(href).toContain("ui_locales=en");
  });

  test("admin PUT stores branding; /api/config reflects it without a restart", async () => {
    const put = await api("/api/config/branding", {
      method: "PUT",
      cookie: adminCookie,
      body: { companyName: "寻数科技", brandIconUrl: "https://cdn.example/icon.png", loginFooterText: "© 2026 寻数科技" },
    });
    expect(put.status).toBe(200);
    const cfg = await api("/api/config");
    expect(cfg.json).toMatchObject({
      companyName: "寻数科技",
      brandIconUrl: "https://cdn.example/icon.png",
      loginFooterText: "© 2026 寻数科技",
    });
  });

  test("non-admin write rejected; invalid values rejected with nothing persisted", async () => {
    const forbidden = await api("/api/config/branding", { method: "PUT", cookie: userCookie, body: { companyName: "hack" } });
    expect(forbidden.status).toBe(403);
    expect((await api("/api/config/branding", { method: "PUT", cookie: adminCookie, body: { companyName: 42 } })).status).toBe(400);
    expect((await api("/api/config/branding", { method: "PUT", cookie: adminCookie, body: { loginFooterText: "x".repeat(201) } })).status).toBe(400);
    expect((await api("/api/config/branding", { method: "PUT", cookie: adminCookie, body: { brandIconUrl: "javascript:alert(1)" } })).status).toBe(400);
    const cfg = await api("/api/config");
    expect(cfg.json).toMatchObject({ companyName: "寻数科技", loginFooterText: "© 2026 寻数科技" });
  });

  test("admin gate follows ADMIN_GROUPS, not the literal 'admin' group", async ({ request }) => {
    // /api/auth/me reports the deployment's admin group names; the default
    // (unset ADMIN_GROUPS) is the historical literal "admin".
    const me = await (await request.get(`${BASE}/api/auth/me`)).json();
    expect(me.adminGroups).toEqual(["admin"]);
    // A user whose groups contain "admin" passes the gate (covered above via
    // adminCookie). Under ADMIN_GROUPS=platform-admin the same user would NOT
    // pass — verified hermetically in the route tests; here we only pin the
    // reported contract.
  });

  test("branded login: icon, company copy, footer; favicon link injected", async ({ page }) => {
    await pinLocaleEn(page);
    await page.goto(`${BASE}/login`);
    await expect(page.getByTestId("login-brand-icon")).toBeVisible();
    await expect(page.getByTestId("login-page")).toContainText("寻数科技");
    await expect(page.getByTestId("login-footer")).toHaveText("© 2026 寻数科技");
    const href = await page.evaluate(() => document.querySelector('link[rel="icon"]')?.getAttribute("href"));
    expect(href).toBe("https://cdn.example/icon.png");
  });

  test("settings branding section: admin saves, refresh reflects; non-admin never sees it", async ({ page, context }) => {
    await context.addCookies([{ name: "paas_session", value: adminCookie, url: BASE, httpOnly: true, sameSite: "Lax" }]);
    await pinLocaleEn(page);
    await page.goto(`${BASE}/settings/branding`);
    await expect(page.getByTestId("settings-branding")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("branding-companyName")).toHaveValue("寻数科技");
    await page.getByTestId("branding-companyName").fill("Fork Co");
    await page.getByTestId("branding-save").click();
    await expect(page.getByTestId("settings-branding")).toContainText("Saved");
    expect((await api("/api/config")).json.companyName).toBe("Fork Co");
    // A fresh load (no server restart) sees the new value.
    await page.goto(`${BASE}/settings/branding`);
    await expect(page.getByTestId("branding-companyName")).toHaveValue("Fork Co");

    // Non-admin: the section is hidden and a deep link falls back to General.
    const userContext = await page.context().browser().newContext();
    const userPage = await userContext.newPage();
    await userContext.addCookies([{ name: "paas_session", value: userCookie, url: BASE, httpOnly: true, sameSite: "Lax" }]);
    await pinLocaleEn(userPage);
    await userPage.goto(`${BASE}/settings/branding`);
    await expect(userPage.getByTestId("settings-general")).toBeVisible({ timeout: 15_000 });
    await expect(userPage.getByTestId("settings-section-branding")).toHaveCount(0);
    await userContext.close();
  });

  test("login locale picker switches language, persists, and feeds ui_locales", async ({ page }) => {
    await pinLocaleEn(page);
    await page.goto(`${BASE}/login`);
    await page.getByTestId("login-locale-select").selectOption("zh-CN");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("登录");
    const href = await page.getByTestId("sso-login").getAttribute("href");
    expect(href).toContain("ui_locales=zh-CN");
    // Persists across reload.
    await page.reload();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("登录");
  });

  test("clearing a field falls back (empty string → null when no env)", async () => {
    expect((await api("/api/config/branding", { method: "PUT", cookie: adminCookie, body: { companyName: "" } })).status).toBe(200);
    const cfg = await api("/api/config");
    expect(cfg.json.companyName).toBeNull();
    expect(cfg.json.brandIconUrl).toBe("https://cdn.example/icon.png");
  });
});
