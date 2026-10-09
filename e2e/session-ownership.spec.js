import { test, expect } from "@playwright/test";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pinLocaleEn, spawnTestServer } from "./helpers.js";
import { signSession } from "../server/session.js";

// Session ownership (add-session-ownership): a private AUTH_MODE=logto server
// (the branding.spec.js spawn pattern — hermetic OIDC fixture + signed
// session cookies) with TWO users driving two browser contexts. The fast
// suite's LLM gateway is dead, but the user message records at dispatch, so
// prompts mint owner-stamped sessions without a working model:
//   - each user's list contains only their own sessions (admin sees all)
//   - foreign REST read/delete → 403
//   - foreign WS switch_session → access error; runtime view unchanged
//   - a user's turn events never reach the other user's transcript

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function waitFor(predicate, ms = 180_000, label = "condition") {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > ms) throw new Error(`waitFor timeout: ${label}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "paas-session-ownership-e2e-"));
const SECRET = "session-ownership-e2e-secret";

const ALICE = { email: "alice@example.com", groups: ["users"] };
const BOB = { email: "bob@example.com", groups: ["users"] };
const ADMIN = { email: "root@example.com", groups: ["users", "admin"] };

let child;
let server;
let fixtureServer;
let BASE;
let bootLog = "";

async function api(pathname, { method = "GET", user, body } = {}) {
  const headers = {};
  if (user) headers.cookie = `paas_session=${signSession({ ...user, exp: Math.floor(Date.now() / 1000) + 3600 }, SECRET)}`;
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

test.describe("session ownership (two users, auth on)", () => {
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
        LLM_API_KEY: process.env.LLM_API_KEY || "sk-e2e-dummy-key",
        LLM_BASE_URL: process.env.LLM_BASE_URL || "http://127.0.0.1:9/v1",
        CHAT_HISTORY_STORE_DIR: path.join(tmpRoot, "chat"),
        DOCUMENTS_STORE_DIR: path.join(tmpRoot, "docs"),
        SESSIONS_STORE_DIR: path.join(tmpRoot, "sessions"),
        LLM_PROVIDERS_STORE: path.join(tmpRoot, "llm-providers.json"),
        LLM_DEFAULT_STORE: path.join(tmpRoot, "llm-default.json"),
        DB_PATH: path.join(tmpRoot, "app.db"),
        MCP_CONFIG_PATH: path.join(tmpRoot, "mcp.json"),
        PLATFORM_DATA_DIR: path.join(tmpRoot, "root"),
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
          return (await fetch(`${BASE}/api/ready`)).ok;
        } catch {
          return false;
        }
      },
      180_000,
      `server ready\n${bootLog.slice(-2000)}`,
    );
  });

  test.afterAll(async () => {
    if (server) await server.stop();
    child = null;
    if (fixtureServer) await new Promise((resolve) => fixtureServer.close(resolve));
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  let alicePage;
  let bobPage;

  // Prompt as a user until the message actually lands. The shared runtime
  // serializes turns, and a dead-LLM turn can hold the slot long after the
  // prompting client looks idle (agent_start never fires, so the store never
  // enters streaming) — a refused prompt leaves no row, so re-prompting with
  // the SAME text is safe and eventually lands once the slot frees.
  // `inSession` (optional) polls THAT session's messages instead of the list
  // (a continuation turn never mints a row).
  const promptAs = async (page, user, text, inSession = null) => {
    await waitFor(
      async () => {
        const streaming = await page.evaluate(() => window.__chatStore.getState().isStreaming);
        if (streaming !== true) {
          await page.getByTestId("composer-input").fill(text);
          await page.getByTestId("composer-send").click();
        }
        if (inSession) {
          const sess = (await api(`/api/chat-history/sessions/${inSession}`, { user })).json;
          return (sess.messages || []).some((m) => m.content?.includes(text));
        }
        const list = (await api("/api/chat-history/sessions", { user })).json.sessions;
        return list.some((s) => s.title.includes(text));
      },
      180_000,
      `prompt as ${user.email} lands (${text})`,
    );
  };

  test.beforeEach(async ({ browser }) => {
    const mk = async (user) => {
      const context = await browser.newContext();
      await context.addCookies([
        {
          name: "paas_session",
          value: signSession({ ...user, exp: Math.floor(Date.now() / 1000) + 3600 }, SECRET),
          url: BASE,
          httpOnly: true,
          sameSite: "Lax",
        },
      ]);
      const page = await context.newPage();
      await pinLocaleEn(page);
      await page.goto(`${BASE}/chat/`);
      await expect(page.getByTestId("status-text")).toHaveText("Connected", { timeout: 15_000 });
      return { context, page };
    };
    // Two durable contexts across the serial tests: attribution and leak
    // checks read their stores.
    if (!alicePage) {
      const a = await mk(ALICE);
      alicePage = a.page;
    }
    if (!bobPage) {
      const b = await mk(BOB);
      bobPage = b.page;
    }
  });

  test("each user's prompt mints an owner-stamped session; lists are disjoint; admin sees all", async () => {
    // Each user's message records at dispatch (the dead LLM only affects the
    // reply), so landing the row proves the prompt was accepted and stamped.
    await promptAs(alicePage, ALICE, "alice owns this session");
    await promptAs(bobPage, BOB, "bob owns that session");

    // Re-read after both turns: lists are disjoint and own-scoped.
    const aliceList = (await api("/api/chat-history/sessions", { user: ALICE })).json.sessions;
    const bobList = (await api("/api/chat-history/sessions", { user: BOB })).json.sessions;
    const adminList = (await api("/api/chat-history/sessions", { user: ADMIN })).json.sessions;
    expect(aliceList.some((s) => s.title.includes("bob owns"))).toBe(false);
    expect(bobList.some((s) => s.title.includes("alice owns"))).toBe(false);
    expect(adminList.some((s) => s.title.includes("alice owns"))).toBe(true);
    expect(adminList.some((s) => s.title.includes("bob owns"))).toBe(true);

    // The sidebar agrees with the scoped list. Reload both pages for a
    // deterministic snapshot: the dispatch-time broadcast predates the row's
    // title/workspace stamp (the sidebar groups by workspace, so a titleless
    // row lands in the collapsed Ungrouped group), and the next natural
    // refresh only fires when the dead-LLM turn idles.
    for (const page of [alicePage, bobPage]) {
      await page.reload();
      await expect(page.getByTestId("status-text")).toHaveText("Connected", { timeout: 15_000 });
    }
    await expect(alicePage.getByTestId("session-row")).toHaveCount(1, { timeout: 15_000 });
    await expect(bobPage.getByTestId("session-row")).toHaveCount(1, { timeout: 15_000 });
    await expect(alicePage.locator('[data-testid="session-row"]')).toContainText("alice owns");
    await expect(bobPage.locator('[data-testid="session-row"]')).toContainText("bob owns");
  });

  let aliceSessionId;
  let bobSessionId;

  test("foreign REST read and delete are 403; own read is 200", async () => {
    const aliceList = (await api("/api/chat-history/sessions", { user: ALICE })).json.sessions;
    const bobList = (await api("/api/chat-history/sessions", { user: BOB })).json.sessions;
    aliceSessionId = aliceList.find((s) => s.title.includes("alice owns")).id;
    bobSessionId = bobList.find((s) => s.title.includes("bob owns")).id;

    expect((await api(`/api/chat-history/sessions/${bobSessionId}`, { user: ALICE })).status).toBe(403);
    expect((await api(`/api/chat-history/sessions/${bobSessionId}`, { user: ALICE, method: "DELETE" })).status).toBe(403);
    expect((await api(`/api/chat-history/sessions/${aliceSessionId}`, { user: BOB })).status).toBe(403);
    // Alice reading her own session returns it (200 + messages).
    const own = await api(`/api/chat-history/sessions/${aliceSessionId}`, { user: ALICE });
    expect(own.status).toBe(200);
    expect(own.json.messages.some((m) => m.content?.includes("alice owns"))).toBe(true);
    // Admin reads across the boundary.
    expect((await api(`/api/chat-history/sessions/${bobSessionId}`, { user: ADMIN })).status).toBe(200);
  });

  test("foreign WS switch is rejected; own switch loads; foreign clients never flip", async () => {
    // Bob's page raw-WS probe: switching into alice's session is refused.
    const foreignSwitch = await bobPage.evaluate(
      (id) =>
        new Promise((resolve) => {
          const ws = new WebSocket(window.location.origin.replace(/^http/, "ws") + "/");
          let sent = false;
          const timer = setTimeout(() => {
            ws.close();
            resolve({ timeout: true });
          }, 15_000);
          ws.onmessage = (ev) => {
            const msg = JSON.parse(ev.data);
            if (!sent && msg.type === "sessions") {
              ws.send(JSON.stringify({ type: "switch_session", id }));
              sent = true;
              return;
            }
            if (sent && msg.type === "error") {
              clearTimeout(timer);
              ws.close();
              resolve({ error: msg.message });
            }
            if (sent && msg.type === "session_loaded") {
              clearTimeout(timer);
              ws.close();
              resolve({ loaded: msg.id });
            }
          };
        }),
      aliceSessionId,
    );
    expect(foreignSwitch.error).toMatch(/do not have access/i);

    // Alice enters her own session via her sidebar (after the reload the
    // deployment-global live session is bob's, so her page correctly sits on
    // the welcome state until she navigates).
    await alicePage.getByTestId("session-row").click();
    await expect(alicePage.getByTestId("composer-input")).toBeVisible();
    await expect
      .poll(() => alicePage.evaluate(() => window.__chatStore.getState().currentSessionId), { timeout: 15_000 })
      .toBe(aliceSessionId);

    // Bob's own switch via the sidebar loads HIS session in HIS page only.
    await bobPage.getByTestId("session-row").click();
    await expect(bobPage.getByTestId("composer-input")).toBeVisible();
    await expect
      .poll(() => bobPage.evaluate(() => window.__chatStore.getState().currentSessionId), { timeout: 15_000 })
      .toBe(bobSessionId);
    // …and alice's page did not receive bob's session_loaded.
    const aliceAfter = await alicePage.evaluate(() => window.__chatStore.getState().currentSessionId);
    expect(aliceAfter).toBe(aliceSessionId);
  });

  test("a user's turn events never reach the other user's transcript", async () => {
    // Alice continues HER session this time — the message lands as a new turn
    // in the existing row (polled by message content), not a new row. Her
    // events stream to that session's viewers only; bob's transcript (he
    // views his own session) must not grow a turn from alice's message.
    const bobTurnsBefore = await bobPage.evaluate(() => window.__chatStore.getState().turns.length);
    await promptAs(alicePage, ALICE, "alice second secret", aliceSessionId);
    // Give any leaked event a moment, then assert bob's transcript is clean.
    await bobPage.waitForTimeout(1500);
    const bobTurnsAfter = await bobPage.evaluate(() => window.__chatStore.getState().turns.length);
    expect(bobTurnsAfter).toBe(bobTurnsBefore);
    // And bob never sees alice's continuation text anywhere in his own scope.
    const bobList = (await api("/api/chat-history/sessions", { user: BOB })).json.sessions;
    expect(bobList.some((s) => s.id === aliceSessionId)).toBe(false);
  });
});
