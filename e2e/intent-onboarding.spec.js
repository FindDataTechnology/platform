import { test, expect } from "@playwright/test";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pinLocaleEn, spawnTestServer } from "./helpers.js";
import { signSession } from "../server/session.js";

// The `simple` preset's nav list — mirror of packages/core/src/lib/surfaces.ts
// (`presets.simple.nav`); that file is the source of truth and its own unit
// tests pin the shape, so a change there should be mirrored here deliberately
// rather than silently re-derived.

const SIMPLE_NAV = ["chat", "knowledge", "resources", "memory", "agents", "apps"];

// Intent onboarding (openspec: intent-onboarding) — the first-run QUESTIONNAIRE
// (distinct from e2e/onboarding.spec.js, which covers the three-step tour).
//
// A private AUTH_MODE=logto server driving the flow end to end: the
// questionnaire appears for a fresh user, skip is durable, answers assign the
// primary role and return the provisioning plan, activation selects the
// recipe's expert, and re-answering switches roles add-only.
//
// The marketplace is OFF in this deployment (no PACK_MARKETPLACE), so the plan
// exercises the spec's degradation path — layout + default expert, no packs.
// That keeps the run hermetic: no market fetch, nothing materialized.
//
// Serial mode: a stateful chain over one spawned server.

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

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "paas-intent-e2e-"));
const SECRET = "intent-e2e-secret";

let child;
let server;
let fixtureServer;
let BASE;
let bootLog = "";
let newUserCookie;
let skipUserCookie;

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

test.describe("intent onboarding", () => {
  test.describe.configure({ mode: "serial", timeout: 300_000 });

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
    newUserCookie = signSession({ email: "fresh@example.com", groups: [], exp }, SECRET);
    skipUserCookie = signSession({ email: "skipper@example.com", groups: [], exp }, SECRET);

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
        // Hermetic: no deployment preset may answer for these users, and the
        // marketplace stays off (the degradation path).
        ONBOARDING_DEFAULT_ROLES: "",
        ONBOARDING_DEFAULT_NOTE: "",
        PACK_MARKETPLACE: "",
        ROLE_ADMISSION_GROUPS: "",
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

  test("a fresh user is due the questionnaire; only recipe-ready roles are offered", async () => {
    const res = await api("/api/onboarding/profile", { cookie: newUserCookie });
    expect(res.status).toBe(200);
    expect(res.json.needsQuestionnaire).toBe(true);
    expect(res.json.profile.source).toBe("empty");
    expect([...res.json.readyRoles].sort()).toEqual(["economic", "legal", "stock"]);
    for (const role of ["financial", "screenplay", "paper", "technical", "standard"]) {
      expect(res.json.readyRoles).not.toContain(role);
    }
  });

  test("the questionnaire renders in the welcome state above the suggested prompts", async ({ page, context }) => {
    await context.addCookies([{ name: "paas_session", value: newUserCookie, url: BASE, httpOnly: true, sameSite: "Lax" }]);
    await pinLocaleEn(page);
    await page.goto(`${BASE}/chat`);
    await expect(page.getByTestId("chat-welcome")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("intent-questionnaire")).toBeVisible();
    await expect(page.getByTestId("intent-role-legal")).toBeVisible();
    await expect(page.getByTestId("intent-role-stock")).toBeVisible();
    await expect(page.getByTestId("intent-role-economic")).toBeVisible();
    await expect(page.getByTestId("intent-role-financial")).toHaveCount(0);
    await expect(page.getByTestId("intent-role-paper")).toHaveCount(0);
    // The composer stays usable underneath (the panel never blocks chat).
    await expect(page.getByTestId("composer-input")).toBeVisible();
  });

  test("submitting answers assigns the primary role and shows the confirmation list", async ({ page, context }) => {
    await context.addCookies([{ name: "paas_session", value: newUserCookie, url: BASE, httpOnly: true, sameSite: "Lax" }]);
    await pinLocaleEn(page);
    await page.goto(`${BASE}/chat`);
    await expect(page.getByTestId("intent-questionnaire")).toBeVisible({ timeout: 20_000 });
    await page.getByTestId("intent-role-legal").click();
    await page.getByTestId("intent-note").fill("contract review");
    await page.getByTestId("intent-submit").click();
    // The confirmation list is the SERVER's plan (marketplace off here → the
    // degraded shape: expert + layout, no packs, with the closing note).
    await expect(page.getByTestId("intent-plan")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("intent-degraded-note")).toBeVisible();
    await expect(page.getByTestId("intent-activate")).toBeVisible();

    // Chrome text must be INTERPOLATED, not literal: these two keys shipped
    // with single braces while the project uses react-i18next, which needs
    // {{name}}/{{role}} — the raw braces reached the user's eyes in all five
    // locales (2026-10-17 defect ④). check:locales only compares key sets, so
    // this is the assertion that catches it.
    //
    // Guarding the heading ({{role}}) is the load-bearing half here: this
    // deployment has the marketplace OFF, so no pack rows render and the
    // planPack slot never appears. That key is covered by
    // scripts/test-intent-onboarding.mjs (the plan carries `name`) plus the
    // hosted suite's live market.
    const panelText = await page.getByTestId("intent-questionnaire").innerText();
    expect(panelText).not.toContain("{name}");
    expect(panelText).not.toContain("{role}");
    expect(panelText).toContain("Legal");

    const me = await api("/api/auth/me", { cookie: newUserCookie });
    expect(me.json.roles.primary).toBe("legal");
  });

  test("activation selects the recipe's default expert and the layout follows the role", async ({ page, context }) => {
    await context.addCookies([{ name: "paas_session", value: newUserCookie, url: BASE, httpOnly: true, sameSite: "Lax" }]);
    await pinLocaleEn(page);
    await page.goto(`${BASE}/chat`);
    // The panel may still be showing the confirm phase from the previous test.
    const activate = page.getByTestId("intent-activate");
    if (await activate.isVisible().catch(() => false)) {
      await activate.click();
      await expect(page.getByTestId("intent-done")).toBeVisible({ timeout: 20_000 });
    } else {
      const res = await api("/api/onboarding/provision", { method: "POST", cookie: newUserCookie });
      expect(res.status).toBe(200);
      // This hermetic deployment publishes no pack personas, so the expert
      // selection reports its outcome rather than succeeding — the contract is
      // that the run COMPLETES and reports, never that it throws.
      expect(["selected", "failed"]).toContain(res.json.expert.status);
    }

    const cfg = await api("/api/config", { cookie: newUserCookie });
    expect(cfg.json.roles.primary).toBe("legal");
    // legal's recipe rides the simple preset through the layout chain. Asserted
    // against the PRESET's own list (surfaces.ts `simple.nav`) rather than a
    // hand-copied array: `apps` joined in role-nav-apps (2026-10-18) and
    // `memory` joined with the knowledge-memory surface, and each addition went
    // red here for a preset change nobody disputed. Comparing with the source of
    // truth keeps the test about routing, not about keeping two lists in sync.
    expect(cfg.json.resolvedLayout.nav).toEqual(SIMPLE_NAV);
  });

  test("the questionnaire does not come back after answering", async ({ page, context }) => {
    await context.addCookies([{ name: "paas_session", value: newUserCookie, url: BASE, httpOnly: true, sameSite: "Lax" }]);
    await pinLocaleEn(page);
    await page.goto(`${BASE}/chat`);
    await expect(page.getByTestId("chat-welcome")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("intent-questionnaire")).toHaveCount(0);
  });

  test("skip is durable: no roles recorded and no re-prompt", async ({ page, context }) => {
    const before = await api("/api/auth/me", { cookie: skipUserCookie });
    expect(before.json.roles.primary).toBe("standard");

    await context.addCookies([{ name: "paas_session", value: skipUserCookie, url: BASE, httpOnly: true, sameSite: "Lax" }]);
    await pinLocaleEn(page);
    await page.goto(`${BASE}/chat`);
    await expect(page.getByTestId("intent-questionnaire")).toBeVisible({ timeout: 20_000 });
    await page.getByTestId("intent-skip").click();
    await expect(page.getByTestId("intent-questionnaire")).toHaveCount(0, { timeout: 15_000 });

    // Reload: still gone, and the role is unchanged (skip does not guess).
    await page.reload();
    await expect(page.getByTestId("chat-welcome")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("intent-questionnaire")).toHaveCount(0);
    const after = await api("/api/auth/me", { cookie: skipUserCookie });
    expect(after.json.roles.primary).toBe("standard");
  });

  test("re-answering switches the primary role; the layout follows", async () => {
    const answers = await api("/api/onboarding/answers", {
      method: "POST",
      cookie: newUserCookie,
      body: { roles: ["stock"] },
    });
    expect(answers.status).toBe(200);
    expect(answers.json.assignment.primary).toBe("stock");

    const provision = await api("/api/onboarding/provision", { method: "POST", cookie: newUserCookie });
    expect(provision.status).toBe(200);
    expect(provision.json.role).toBe("stock");
    expect(["selected", "failed"]).toContain(provision.json.expert.status);

    const cfg = await api("/api/config", { cookie: newUserCookie });
    expect(cfg.json.roles.primary).toBe("stock");
  });

  test("re-provisioning is idempotent", async () => {
    const first = await api("/api/onboarding/provision", { method: "POST", cookie: newUserCookie });
    const second = await api("/api/onboarding/provision", { method: "POST", cookie: newUserCookie });
    expect(second.status).toBe(200);
    expect(second.json.results).toEqual(first.json.results);
    expect(second.json.expert.status).toBe(first.json.expert.status);
  });

  test("the self channel never grants the admin flag", async () => {
    const me = await api("/api/auth/me", { cookie: newUserCookie });
    expect(me.json.isAdmin).toBe(false);
  });

  test("reopen re-shows the questionnaire pre-filled from the stored profile", async ({ page, context }) => {
    await context.addCookies([{ name: "paas_session", value: newUserCookie, url: BASE, httpOnly: true, sameSite: "Lax" }]);
    await pinLocaleEn(page);
    await page.goto(`${BASE}/chat`);
    await expect(page.getByTestId("chat-welcome")).toBeVisible({ timeout: 20_000 });
    await page.getByTestId("settings-btn").click();
    await expect(page.getByTestId("settings-general")).toBeVisible({ timeout: 15_000 });
    await page.getByTestId("onboarding-reopen").click();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("intent-questionnaire")).toBeVisible({ timeout: 15_000 });
    // The stored answer (stock) renders preselected.
    await expect(page.getByTestId("intent-role-stock")).toHaveAttribute("aria-pressed", "true");
  });

  test("invalid answers are rejected with nothing persisted", async () => {
    const before = await api("/api/onboarding/profile", { cookie: newUserCookie });
    const bad = await api("/api/onboarding/answers", {
      method: "POST",
      cookie: newUserCookie,
      body: { roles: ["screenplay"] },
    });
    expect(bad.status).toBe(400);
    const after = await api("/api/onboarding/profile", { cookie: newUserCookie });
    expect(after.json.profile.roles).toEqual(before.json.profile.roles);
  });
});
