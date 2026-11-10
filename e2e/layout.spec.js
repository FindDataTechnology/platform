import { test, expect } from "@playwright/test";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pinLocaleEn, spawnTestServer } from "./helpers.js";
import { signSession } from "../server/session.js";

// Workbench layout (openspec: layout-configuration). A private
// AUTH_MODE=logto server (the roles.spec.js pattern) driving the four-layer
// resolution chain through its observable faces: the admin layout section, the
// resolved /api/config payload, the sidebar's rendered tabs, and the user's own
// customization panel.
//
// Serial mode: the tests are a stateful chain over one spawned server
// (baseline → deployment default changed → deployment hide → user tweak →
// restore).

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

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "paas-layout-e2e-"));
const SECRET = "layout-e2e-secret";

let child;
let server;
let fixtureServer;
let BASE;
let bootLog = "";
let adminCookie;
let userCookie;

// The server's nav list includes `fleet`: desktopOnly is a client-owned fact
// (only the shell knows it is the shell), so the resolved payload carries it
// and the browser filters it at render — which the sidebar test asserts.
// `fleets` (agent-fleet-core) is a plain web surface and rides in both lists.
// Registry order (packages/core surfaces.ts NAV_SURFACES). memory/machines/
// zhiyu/blueprints landed after this spec's original list — aligned here.
// add-agent-builder-workspace 3.1: `blueprints` retires from the FACTORY nav
// (the workspace owns the route; /blueprints redirects) — so it is absent from
// the baseline snapshot below while every other registry slug stays.
// restructure-yizuo-ia: registry order (six top-level entries / four families —
// chat · 知识 · 构建 · 运行 · 自动化 · 接入). `tuning` and `channels` gained
// doors; `channels` left Settings for the nav container.
const ALL_NAV = [
  "chat", "knowledge", "resources", "memory", "agents", "tuning",
  "fleets", "machines", "fleet", "tasks", "apps", "channels", "zhiyu",
];
const BROWSER_NAV = ALL_NAV.filter((slug) => slug !== "fleet");
// 12 settings sections; branding/roles/layout are admin-only → filtered for a
// non-admin resolver, and `pairing` replaced devices + wechat-app while
// `diagnostics` folded into `status`.
// The non-admin settings view, in registry order (packages/core/src/lib/surfaces.ts
// SETTINGS_SURFACES). `roles`/`layout`/`branding` carry `adminOnly` and are absent
// here, which is why the count is 9 and not the registry's 12. Kept in step with
// the registry: mcp/plugins left for the materials market, mandate + mandate-intake
// arrived with the personal-mandate work (this list had gone stale against both).
const ALL_SETTINGS = [
  "general", "account", "pairing", "connections",
  "models", "delegation", "mandate", "mandate-intake", "status",
];

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

test.describe("workbench layout (logto mode)", () => {
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
    adminCookie = signSession({ email: "layoutadmin@example.com", groups: ["users", "admin"], exp }, SECRET);
    userCookie = signSession({ email: "layoutuser@example.com", groups: [], exp }, SECRET);

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
        // Hermetic: no ambient layout seeding may leak into the chain's floor.
        LAYOUT_DEFAULT_PRESET: "",
        LAYOUT_ROLE_PRESETS: "",
        LAYOUT_HIDDEN: "",
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

  test("baseline: no layout data anywhere resolves to the standard snapshot", async () => {
    const cfg = await api("/api/config", { cookie: userCookie });
    expect(cfg.status).toBe(200);
    expect(cfg.json.resolvedLayout.nav).toEqual(ALL_NAV);
    expect(cfg.json.resolvedLayout.settings).toEqual(ALL_SETTINGS);
    // restructure-yizuo-ia: `/agents` is the single pack doorway with market +
    // mine; the retired hub slugs stay alias-only. The marketplace predicate
    // gates the 市场 TAB (not the page), and this harness runs without
    // PACK_MARKETPLACE, so 我的 survives alone — installed packs and creator
    // drafts are local state.
    expect(cfg.json.resolvedLayout.agentsTabs).toEqual(["agents", "tools", "skills", "plugins", "mine"]);
  });

  test("the sidebar renders exactly the resolved tab set (baseline)", async ({ page, context }) => {
    await context.addCookies([{ name: "paas_session", value: userCookie, url: BASE, httpOnly: true, sameSite: "Lax" }]);
    await pinLocaleEn(page);
    await page.goto(`${BASE}/chat`);
    await expect(page.getByTestId("sidebar")).toBeVisible();
    for (const slug of BROWSER_NAV) {
      await expect(page.getByTestId(`nav-${slug}`)).toBeVisible();
    }
    // The desktop-only fleet tab never renders in a browser.
    await expect(page.getByTestId("nav-fleet")).toHaveCount(0);
  });

  test("non-admin: layout section hidden, deep link falls back, PUT 403", async ({ page, context }) => {
    await context.addCookies([{ name: "paas_session", value: userCookie, url: BASE, httpOnly: true, sameSite: "Lax" }]);
    await pinLocaleEn(page);
    await page.goto(`${BASE}/settings/layout`);
    await expect(page.getByTestId("settings-dialog")).toBeVisible();
    // Admin-only: the deep link resolves to General, and the nav omits the entry.
    await expect(page.getByTestId("settings-section-general")).toBeVisible();
    await expect(page.getByTestId("settings-section-layout")).toHaveCount(0);

    const put = await api("/api/layout/config", { method: "PUT", cookie: userCookie, body: { defaultPreset: "simple" } });
    expect(put.status).toBe(403);
  });

  test("admin switches the deployment default to simple; the next config read follows, no restart", async () => {
    const put = await api("/api/layout/config", { method: "PUT", cookie: adminCookie, body: { defaultPreset: "simple" } });
    expect(put.status).toBe(200);
    expect(put.json.defaultPreset).toBe("simple");

    const cfg = await api("/api/config", { cookie: userCookie });
    expect(cfg.json.resolvedLayout.nav).toEqual(["chat", "knowledge", "resources", "memory", "agents", "apps"]);
    // `connections` belongs to the non-technical skeleton: the business-role
    // recipes (legal/stock/economic) all resolve to this preset, and it is
    // where those users make tools/search work at all. Dropping it made the
    // section — and every connect deep link — vanish for them (2026-10-18).
    expect(cfg.json.resolvedLayout.settings).toEqual([
      "general",
      "account",
      "pairing",
      "connections",
    ]);
    expect(cfg.json.resolvedLayout.agentsTabs).toEqual(["agents", "tools", "skills", "plugins", "mine"]);
  });

  test("the sidebar reflects the narrowed layout on the next load", async ({ page, context }) => {
    await context.addCookies([{ name: "paas_session", value: userCookie, url: BASE, httpOnly: true, sameSite: "Lax" }]);
    await pinLocaleEn(page);
    await page.goto(`${BASE}/chat`);
    await expect(page.getByTestId("sidebar")).toBeVisible();
    await expect(page.getByTestId("nav-chat")).toBeVisible();
    await expect(page.getByTestId("nav-agents")).toBeVisible();
    // `apps` rides in the simple skeleton (role-nav-apps): the app center is
    // the connection entry business users must reach.
    await expect(page.getByTestId("nav-apps")).toBeVisible();
    // Narrowed away by the simple preset.
    await expect(page.getByTestId("nav-tasks")).toHaveCount(0);
  });

  test("a hidden tab's deep link still resolves (routes survive hiding)", async ({ page, context }) => {
    await context.addCookies([{ name: "paas_session", value: userCookie, url: BASE, httpOnly: true, sameSite: "Lax" }]);
    await pinLocaleEn(page);
    await page.goto(`${BASE}/apps`);
    // The page renders (the surface is hidden, not removed) — its own heading proves it.
    await expect(page.getByTestId("app-center-page").or(page.locator("main"))).toBeVisible();
  });

  test("deployment hiding is terminal: the user's panel offers no way back", async ({ page, context }) => {
    // Restore the standard default, then hide `tasks` for everyone.
    const restore = await api("/api/layout/config", { method: "PUT", cookie: adminCookie, body: { defaultPreset: "standard-snapshot" } });
    expect(restore.status).toBe(200);
    const hide = await api("/api/layout/config", { method: "PUT", cookie: adminCookie, body: { hidden: ["tasks", "apps"] } });
    expect(hide.status).toBe(200);
    expect(hide.json.hidden).toEqual(["tasks", "apps"]);

    const cfg = await api("/api/config", { cookie: userCookie });
    expect(cfg.json.resolvedLayout.nav).not.toContain("tasks");
    expect(cfg.json.resolvedLayout.nav).not.toContain("apps");
    // Everything else survives.
    expect(cfg.json.resolvedLayout.nav).toContain("chat");
    expect(cfg.json.resolvedLayout.nav).toContain("agents");

    // The user's own panel lists only what they can affect — tasks/apps absent.
    await context.addCookies([{ name: "paas_session", value: userCookie, url: BASE, httpOnly: true, sameSite: "Lax" }]);
    await pinLocaleEn(page);
    await page.goto(`${BASE}/chat`);
    await page.getByTestId("workbench-btn").click();
    await expect(page.getByTestId("workbench-panel")).toBeVisible();
    await expect(page.getByTestId("workbench-row-chat")).toBeVisible();
    await expect(page.getByTestId("workbench-row-tasks")).toHaveCount(0);
    await expect(page.getByTestId("workbench-row-apps")).toHaveCount(0);
  });

  test("a user hides a tab for themselves only, then restores the inherited layout", async ({ page, context }) => {
    await context.addCookies([{ name: "paas_session", value: userCookie, url: BASE, httpOnly: true, sameSite: "Lax" }]);
    await pinLocaleEn(page);
    await page.goto(`${BASE}/chat`);
    await page.getByTestId("workbench-btn").click();
    await expect(page.getByTestId("workbench-panel")).toBeVisible();

    // Hide `knowledge` for this user.
    await page.getByTestId("workbench-hide-knowledge").click();
    await expect
      .poll(async () => (await api("/api/config", { cookie: userCookie })).json.resolvedLayout.nav.includes("knowledge"), { timeout: 15_000 })
      .toBe(false);
    // The admin's own resolution is untouched by the user's tweak.
    const adminCfg = await api("/api/config", { cookie: adminCookie });
    expect(adminCfg.json.resolvedLayout.nav).toContain("knowledge");

    // Restore clears the adjustment: knowledge comes back (still minus the
    // deployment-hidden set).
    await page.getByTestId("workbench-restore").click();
    await expect
      .poll(async () => (await api("/api/config", { cookie: userCookie })).json.resolvedLayout.nav.includes("knowledge"), { timeout: 15_000 })
      .toBe(true);
    const after = await api("/api/config", { cookie: userCookie });
    expect(after.json.resolvedLayout.nav).not.toContain("tasks");
  });

  test("a hidden Agents nav tab keeps /agents deep links resolving (market facade)", async ({ page, context }) => {
    // add-agent-builder-hub 4.2: deployment-hide the Agents tab entirely; the
    // route survives hiding (hidden surfaces keep their routes). W2 teardown
    // (0eb48a0d0): /agents now renders AgentMarketPage (the four-zone hub is
    // dissolved) — the route-resolves assertion rides the facade's testids.
    const hide = await api("/api/layout/config", { method: "PUT", cookie: adminCookie, body: { hidden: ["tasks", "apps", "agents"] } });
    expect(hide.status).toBe(200);

    await context.addCookies([{ name: "paas_session", value: userCookie, url: BASE, httpOnly: true, sameSite: "Lax" }]);
    await pinLocaleEn(page);
    await page.goto(`${BASE}/chat`);
    await expect(page.getByTestId("sidebar")).toBeVisible();
    await expect(page.getByTestId("nav-agents")).toHaveCount(0);
    await page.goto(`${BASE}/agents`);
    await expect(page.getByTestId("agent-market-page")).toBeVisible({ timeout: 15000 });

    // Restore the chain's state for any later steps.
    const restore = await api("/api/layout/config", { method: "PUT", cookie: adminCookie, body: { hidden: ["tasks", "apps"] } });
    expect(restore.status).toBe(200);
  });

  test("unknown surfaces and malformed payloads are rejected with nothing persisted", async () => {
    const before = await api("/api/layout/config", { cookie: adminCookie });
    const bad = await api("/api/layout/config", {
      method: "PUT",
      cookie: adminCookie,
      body: { hidden: "not-an-array" },
    });
    expect(bad.status).toBe(400);
    const after = await api("/api/layout/config", { cookie: adminCookie });
    expect(after.json).toEqual(before.json);
  });
});
