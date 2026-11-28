import { test, expect } from "@playwright/test";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pinLocaleEn, spawnTestServer } from "./helpers.js";
import { signSession } from "../server/session.js";

// Business roles (openspec: role-system). A second `node server.js` under
// AUTH_MODE=logto with a hermetic OIDC fixture (the branding.spec.js pattern):
// the admin surface at /settings/roles reassigns a user's primary role over
// the REST routes, the target user's next session load reflects it, and the
// non-admin view omits the section and is refused at the API.
//
// Serial mode: the tests are a stateful chain (unassigned → reassigned →
// verified) over one spawned server.

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

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "paas-roles-e2e-"));
const SECRET = "roles-e2e-secret";

let child;
let server;
let fixtureServer;
let BASE;
let bootLog = "";
let adminCookie;
let userCookie;

async function api(pathname, { method = "GET", cookie, body } = {}) {
  const headers = {};
  if (cookie) headers.cookie = `paas_session=${cookie}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${BASE}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* status is the signal */
  }
  return { status: res.status, json };
}

test.describe("business roles (logto mode)", () => {
  test.describe.configure({ mode: "serial", timeout: 240_000 });

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
    adminCookie = signSession({ email: "roleadmin@example.com", groups: ["users", "admin"], exp }, SECRET);
    userCookie = signSession({ email: "roleuser@example.com", groups: ["users"], exp }, SECRET);

    server = spawnTestServer({
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
        // Hermetic: no ambient role seeding must leak into the chain's floor.
        ROLES_DEFAULT_PRIMARY: "",
        ROLES_SEED_ASSIGNMENTS: "",
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
    });
    child = server.child;
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
    if (server) await server.stop();
    child = null;
    if (fixtureServer) await new Promise((resolve) => fixtureServer.close(resolve));
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  test("baseline: unassigned user resolves to standard and sees no roles field", async () => {
    const cfg = await api("/api/config", { cookie: userCookie });
    expect(cfg.status).toBe(200);
    expect(cfg.json.roles).toEqual({ primary: "standard", secondary: [] });

    const me = await api("/api/auth/me", { cookie: userCookie });
    expect(me.json.isAdmin).toBe(false);
  });

  test("non-admin cannot see the section, deep link falls back, PUT is 403", async ({ page }) => {
    await pinLocaleEn(page);
    // The SPA boots with the user's session for the REST calls it makes.
    await page.context().addCookies([{ name: "paas_session", value: userCookie, url: BASE }]);
    await page.goto(`${BASE}/settings/roles`);
    await expect(page.getByTestId("settings-dialog")).toBeVisible();
    // The roles section is admin-only: the deep link resolves to General.
    await expect(page.getByTestId("settings-section-general")).toBeVisible();
    await expect(page.getByTestId("settings-content").getByTestId("roles-section")).toHaveCount(0);
    // And the section list itself omits the entry.
    await expect(page.getByTestId("settings-section-roles")).toHaveCount(0);

    const put = await api("/api/roles/assignments/roleuser%40example.com", {
      method: "PUT",
      cookie: userCookie,
      body: { primary: "legal" },
    });
    expect(put.status).toBe(403);
  });

  test("admin lists users, reassigns the primary role; target user's next config load reflects it", async () => {
    const before = await api("/api/roles/assignments", { cookie: adminCookie });
    expect(before.status).toBe(200);
    expect(Array.isArray(before.json.assignments)).toBe(true);

    const put = await api("/api/roles/assignments/roleuser%40example.com", {
      method: "PUT",
      cookie: adminCookie,
      body: { primary: "legal", secondary: ["technical"], admin: false },
    });
    expect(put.status).toBe(200);
    expect(put.json.primary).toBe("legal");

    // The target user's next session load (a fresh /api/config read) resolves
    // the new assignment with no server restart.
    const cfg = await api("/api/config", { cookie: userCookie });
    expect(cfg.json.roles).toEqual({ primary: "legal", secondary: ["technical"] });

    // Identity groups stay authoritative: this user's identity carries
    // ["users"], so the role's mapped group adds nothing (design D4).
    const me = await api("/api/auth/me", { cookie: userCookie });
    expect(me.json.groups).toEqual(["users"]);

    // A user whose identity carries NO groups gets the role-mapped admission
    // set instead — the local/no-synced-groups path.
    const bare = await api("/api/roles/assignments/bare%40example.com", {
      method: "PUT",
      cookie: adminCookie,
      body: { primary: "legal" },
    });
    expect(bare.status).toBe(200);
    const bareCookie = signSession({ email: "bare@example.com", groups: [], exp: Math.floor(Date.now() / 1000) + 60 * 60 }, SECRET);
    const bareMe = await api("/api/auth/me", { cookie: bareCookie });
    expect(bareMe.json.groups).toEqual(["legal"]);
  });

  test("admin reassigns again; the newer assignment wins (no cache)", async () => {
    const put = await api("/api/roles/assignments/roleuser%40example.com", {
      method: "PUT",
      cookie: adminCookie,
      body: { primary: "stock", admin: false },
    });
    expect(put.status).toBe(200);
    const cfg = await api("/api/config", { cookie: userCookie });
    expect(cfg.json.roles.primary).toBe("stock");
  });

  test("admin grants the orthogonal admin flag; the target becomes admin without a business-role change", async () => {
    const put = await api("/api/roles/assignments/roleuser%40example.com", {
      method: "PUT",
      cookie: adminCookie,
      body: { primary: "stock", admin: true },
    });
    expect(put.status).toBe(200);
    const me = await api("/api/auth/me", { cookie: userCookie });
    expect(me.json.isAdmin).toBe(true);
    expect(me.json.roles.primary).toBe("stock");
  });

  test("unknown role slug is rejected 400 and nothing is stored", async () => {
    const res = await api("/api/roles/assignments/roleuser%40example.com", {
      method: "PUT",
      cookie: adminCookie,
      body: { primary: "wizard" },
    });
    expect(res.status).toBe(400);
    const cfg = await api("/api/auth/me", { cookie: userCookie });
    expect(cfg.json.roles.primary).toBe("stock");
  });

  test("admin drives the same reassignment through /settings/roles in the UI", async ({ page }) => {
    await pinLocaleEn(page);
    // The signed session rides the browser context exactly as branding.spec.js
    // does it: httpOnly + Lax, set before the first navigation.
    const context = page.context();
    await context.addCookies([{ name: "paas_session", value: adminCookie, url: BASE, httpOnly: true, sameSite: "Lax" }]);
    await page.goto(`${BASE}/settings/roles`);
    await expect(page.getByTestId("settings-dialog")).toBeVisible();
    // The admin sees the section nav entry and the section itself.
    const nav = page.getByTestId("settings-section-roles");
    await expect(nav).toBeVisible();
    await nav.click();
    await expect(page.getByTestId("roles-section")).toBeVisible();

    // The row for the user this suite has been reassigning renders with the
    // stored assignment (paper was never set; the last state is stock+admin).
    const row = page.getByTestId("roles-row-roleuser@example.com");
    await expect(row).toBeVisible();
    const primary = page.getByTestId("roles-primary-roleuser@example.com");
    await expect(primary).toHaveValue("stock");

    // Reassign through the UI control (the same route the API test exercised).
    await primary.selectOption("legal");
    // The row reflects the saved answer once the PUT round-trips.
    await expect(primary).toHaveValue("legal", { timeout: 15_000 });
    const cfg = await api("/api/config", { cookie: userCookie });
    expect(cfg.json.roles.primary).toBe("legal");
  });
});

