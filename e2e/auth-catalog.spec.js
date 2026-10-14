import { test, expect } from "@playwright/test";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { spawnTestServer } from "./helpers.js";


// Forward-auth + agent/app catalog e2e. Two targets:
//  - the shared webServer (AUTH_MODE unset): default behavior unchanged and
//    the connect broker refuses without forward auth.
//  - a second `node server.js` spawned here with AUTH_MODE=forward_auth and
//    AGENTS_CONFIG_URL pointing at an in-process fixture server that serves
//    the cloud catalog doc, a mock OpenAI-compat SSE endpoint, and a stubbed
//    Nango /connect/sessions.

// ── Shared server (auth off) ─────────────────────────────────────────────────

test.describe("default AUTH_MODE (auth off)", () => {
  test("/api/auth/me reports mode none; catalog stays open", async ({ request }) => {
    const me = await request.get("/api/auth/me");
    expect(me.ok()).toBeTruthy();
    expect(await me.json()).toEqual({
      mode: "none",
      email: null,
      groups: null,
      authenticated: false,
      adminGroups: ["admin"],
      loginUrl: "/oauth2/start",
      logoutUrl: "/oauth2/sign_out",
      ssoConfigured: false,
      ssoAuthenticated: false,
      ssoEmail: null,
      ssoGroups: null,
    });

    const cat = await request.get("/api/catalog");
    expect(cat.ok()).toBeTruthy();
    const json = await cat.json();
    expect(json.agents.some((a) => a.id === "local")).toBe(true);
    expect(Array.isArray(json.apps)).toBe(true);
  });

  test("auth-off mode keeps the existing open shell", async ({ page }) => {
    await page.goto("/login");
    await expect(page).toHaveURL(/\/chat/);
    await expect(page.getByTestId("status-text")).toHaveText("Connected", { timeout: 15000 });
  });

  test("connect broker is 400 without forward auth", async ({ request }) => {
    const r = await request.post("/api/apps/whatever/connect");
    expect(r.status()).toBe(400);
  });
});

// ── Forward-auth server (spawned) ────────────────────────────────────────────

const ADMIN = { "x-forwarded-email": "admin@corp.com", "x-forwarded-groups": "admin" };
const USER = { "x-forwarded-email": "bob@corp.com", "x-forwarded-groups": "users" };

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
  });
}

async function waitFor(predicate, ms = 10_000) {
  const start = Date.now();
  // Await: predicates may be async (polling fetch) — a raw Promise is truthy
  // and would exit the loop immediately.
  while (!(await predicate())) {
    if (Date.now() - start > ms) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 100));
  }
}

let AUTH_PORT;
let BASE;
let child;
let server;
let fixtureServer;
let fixtureDoc;
const mock = { lastChat: null, lastConnect: null };
let bootLog = "";
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "paas-auth-e2e-"));

function openWs(headers) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${AUTH_PORT}/`, { headers });
    const msgs = [];
    ws.on("message", (raw) => msgs.push(JSON.parse(raw.toString())));
    ws.on("open", () => resolve({ ws, msgs }));
    ws.on("error", reject);
  });
}

test.describe("AUTH_MODE=forward_auth", () => {
  // beforeAll boots a second server.js — give the whole group headroom.
  test.describe.configure({ timeout: 120_000 });

  test.beforeAll(async () => {
    // Fixture server: cloud catalog + mock OpenAI-compat SSE + Nango stub.
    const fixturePort = await freePort();
    const FIXTURE = `http://127.0.0.1:${fixturePort}`;
    fixtureDoc = {
      agents: [
        // cloud wins by id — overrides the built-in local entry's name
        { id: "local", type: "agent-local", name: "Cloud Local Override" },
        { id: "remote-chat", type: "agent-remote", mode: "chat", baseUrl: `${FIXTURE}/v1`, model: "mock-model", apiKeyEnv: "REMOTE_AGENT_KEY" },
        // `local: false` = the operator declaring a real remote service: no
        // persona preset, the turn forks to its endpoint instead.
        { id: "remote-fork", type: "agent-remote", mode: "chat", local: false, baseUrl: `${FIXTURE}/v1`, model: "mock-model", apiKeyEnv: "REMOTE_AGENT_KEY" },
        { id: "admin-agent", type: "agent-remote", mode: "chat", baseUrl: `${FIXTURE}/v1`, model: "mock-model", roles: ["admin"] },
        { id: "link-agent", type: "agent-remote", mode: "link", url: "https://example.com/agent" },
        // invalid (chat mode without baseUrl) — must be dropped
        { id: "bad-agent", type: "agent-remote", mode: "chat", model: "no-base-url" },
      ],
      apps: [
        { id: "doc-app", type: "app", kind: "link", url: "https://example.com/docs" },
        { id: "nango-app", type: "app", kind: "nango-connect", nangoUrl: `${FIXTURE}/nango` },
      ],
    };
    fixtureServer = http.createServer((req, res) => {
      const readBody = () =>
        new Promise((resolve) => {
          let body = "";
          req.on("data", (c) => (body += c));
          req.on("end", () => resolve(body));
        });
      if (req.method === "GET" && req.url === "/config") {
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify(fixtureDoc));
      }
      if (req.method === "POST" && req.url === "/v1/chat/completions") {
        readBody().then((body) => {
          mock.lastChat = { auth: req.headers.authorization, body: JSON.parse(body) };
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          for (const piece of ["Hello ", "remote ", "world"]) {
            res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
          }
          res.write("data: [DONE]\n\n");
          res.end();
        });
        return;
      }
      if (req.method === "POST" && req.url === "/nango/connect/sessions") {
        readBody().then((body) => {
          mock.lastConnect = { auth: req.headers.authorization, tags: JSON.parse(body).tags };
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ token: "stub-session-token" }));
        });
        return;
      }
      res.writeHead(404);
      res.end("{}");
    });
    await new Promise((r) => fixtureServer.listen(fixturePort, "127.0.0.1", r));

    // Second server.js with forward auth on; isolated stores; no OC.
    AUTH_PORT = await freePort();
    BASE = `http://127.0.0.1:${AUTH_PORT}`;
    server = spawnTestServer({
      env: {
        ...process.env,
        PORT: String(AUTH_PORT),
        HOST: "127.0.0.1",
        AUTH_MODE: "forward_auth",
        AUTH_LOGIN_PATH: "//evil.example/start",
        AUTH_LOGOUT_PATH: "https://evil.example/sign_out",
        AGENTS_CONFIG_URL: `${FIXTURE}/config`,
        CATALOG_REFRESH_SECS: "0", // deterministic: refresh only via POST
        NANGO_SECRET_KEY: "test-nango-secret",
        REMOTE_AGENT_KEY: "test-remote-key",
        CHAT_HISTORY_STORE_DIR: path.join(tmpRoot, "chat"),
        DOCUMENTS_STORE_DIR: path.join(tmpRoot, "docs"),
        SESSIONS_STORE_DIR: path.join(tmpRoot, "sessions"),
        DB_PATH: path.join(tmpRoot, "app.db"),
        // Isolate this spawned server's dsh home (see prepareTempStoreDirs):
        // workers do not inherit the webServer's DSH_HOME, so without this the
        // child composes against — and rewrites — the developer's real ~/.dsh.
        DSH_HOME: path.join(tmpRoot, "dsh-home"),
        DSH_SHARED_HOME: process.env.DSH_SHARED_HOME || path.join(os.homedir(), ".dsh"),
      },
    });
    child = server.child;
    child.stdout.on("data", (d) => (bootLog += d));
    child.stderr.on("data", (d) => (bootLog += d));

    const start = Date.now();
    let lastErr;
    while (Date.now() - start < 90_000) {
      try {
        const r = await fetch(`${BASE}/api/auth/me`);
        if (r.status === 401 || r.ok) break; // up and gated
        lastErr = new Error(`HTTP ${r.status}`);
      } catch (e) {
        lastErr = e;
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    if (Date.now() - start >= 90_000) {
      throw new Error(`forward-auth server not ready: ${lastErr?.message}\n${bootLog.slice(-2000)}`);
    }
    // /api/auth/me answers from the listen-first boot, before the async work
    // finishes: the cloud catalog merges, then the deployment composes one local
    // persona preset per chat-mode entry and restarts the idle runtime so its
    // roster carries them. Wait for the spec's own data (catalog entries AND the
    // preset they generate) so no test runs against a half-booted server — a
    // fresh worker can spawn this child and reach the tests within a second.
    try {
      const probe = await openWs(ADMIN);
      try {
        await waitFor(async () => {
          probe.msgs.length = 0;
          probe.ws.send(JSON.stringify({ type: "list_presets" }));
          await new Promise((r) => setTimeout(r, 250));
          const roster = probe.msgs.findLast((m) => m.type === "presets")?.presets ?? [];
          return roster.some((p) => p.id === "remote-chat");
        }, 60_000);
      } finally {
        probe.ws.close();
      }
    } catch (e) {
      throw new Error(`forward-auth persona presets not ready: ${e.message}\n${bootLog.slice(-2000)}`);
    }
  });

  test.afterAll(async () => {
    if (server) await server.stop();
    child = null;
    if (fixtureServer) await new Promise((r) => fixtureServer.close(r));
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  test("HTTP: public identity, protected APIs, and safe SSO paths", async () => {
    const anon = await fetch(`${BASE}/api/auth/me`);
    expect(anon.status).toBe(200);
    expect(await anon.json()).toEqual({
      mode: "forward_auth",
      email: null,
      groups: null,
      authenticated: false,
      adminGroups: ["admin"],
      loginUrl: "/oauth2/start",
      logoutUrl: "/oauth2/sign_out",
      // Optional SSO is a mode-none-only overlay; under forward_auth it stays off.
      ssoConfigured: false,
      ssoAuthenticated: false,
      ssoEmail: null,
      ssoGroups: null,
    });

    const login = await fetch(`${BASE}/login`);
    expect(login.status).toBe(200);
    const asset = await fetch(`${BASE}/assets/does-not-exist.js`);
    expect(asset.status).not.toBe(401);

    const protectedApi = await fetch(`${BASE}/api/catalog`);
    expect(protectedApi.status).toBe(401);

    const me = await fetch(`${BASE}/api/auth/me`, { headers: ADMIN });
    expect(me.ok).toBeTruthy();
    expect(await me.json()).toEqual({
      mode: "forward_auth",
      email: "admin@corp.com",
      groups: ["admin"],
      authenticated: true,
      adminGroups: ["admin"],
      loginUrl: "/oauth2/start",
      logoutUrl: "/oauth2/sign_out",
      ssoConfigured: false,
      ssoAuthenticated: false,
      ssoEmail: null,
      ssoGroups: null,
    });
  });

  test("login page is public and starts the default SSO flow", async ({ page }) => {
    await page.goto(`${BASE}/chat`);
    await expect(page).toHaveURL(`${BASE}/login`);
    await expect(page.getByTestId("login-page")).toBeVisible();

    const login = page.getByTestId("sso-login");
    await expect(login).toBeVisible();
    const href = await login.getAttribute("href");
    expect(href).toContain("/oauth2/start?rd=");
    expect(href).not.toContain("evil.example");
  });

  test("authenticated account settings show identity and sign-out", async ({ page }) => {
    await page.route("**/api/auth/me", (route) =>
      route.fulfill({
        json: {
          mode: "forward_auth",
          email: "browser@corp.com",
          groups: ["users"],
          authenticated: true,
          loginUrl: "/oauth2/start",
          logoutUrl: "/oauth2/sign_out",
        },
      }),
    );
    await page.goto(`${BASE}/settings/account`);
    await expect(page.getByTestId("settings-account")).toBeVisible();
    await expect(page.getByTestId("account-email")).toHaveText("browser@corp.com");

    const logout = page.getByTestId("sso-logout");
    await expect(logout).toBeVisible();
    const href = await logout.getAttribute("href");
    expect(href).toContain("/oauth2/sign_out?rd=");
    expect(href).toContain("login");
  });

  test("WS: upgrade rejected without headers; agents list is role-filtered", async () => {
    await expect(openWs({})).rejects.toThrow(/401/);

    const admin = await openWs(ADMIN);
    // The catalog boots local-first and merges the cloud asynchronously —
    // poll list_agents until the cloud-sourced remote agent arrives.
    await waitFor(() => {
      admin.ws.send(JSON.stringify({ type: "list_agents" }));
      return admin.msgs.some((m) => m.type === "agents" && m.agents.some((a) => a.id === "remote-chat"));
    });
    const ids = admin.msgs.findLast((m) => m.type === "agents").agents.map((a) => a.id);
    expect(ids).toContain("remote-chat"); // chat-mode remote is switchable
    expect(ids).toContain("admin-agent"); // admin sees the role-gated agent
    expect(ids).not.toContain("link-agent"); // link agents are pages, not chat targets
    admin.ws.close();

    const user = await openWs(USER);
    await waitFor(() => {
      user.ws.send(JSON.stringify({ type: "list_agents" }));
      return user.msgs.some((m) => m.type === "agents" && m.agents.some((a) => a.id === "remote-chat"));
    });
    expect(user.msgs.findLast((m) => m.type === "agents").agents.map((a) => a.id)).not.toContain("admin-agent");
    user.ws.close();
  });

  test("catalog GET is role-filtered, validated, cloud-wins, and redacted", async () => {
    // Cloud merges asynchronously after the local-first boot — wait for it.
    let adminCat;
    await waitFor(async () => {
      adminCat = await (await fetch(`${BASE}/api/catalog`, { headers: ADMIN })).json();
      return adminCat.agents.some((a) => a.id === "remote-chat");
    });
    const agentIds = adminCat.agents.map((a) => a.id);
    expect(agentIds).toContain("admin-agent");
    expect(agentIds).toContain("link-agent"); // catalog lists link agents (unlike the WS switcher)
    expect(agentIds).not.toContain("bad-agent"); // invalid entry dropped
    expect(adminCat.agents.find((a) => a.id === "local").name).toBe("Cloud Local Override"); // cloud wins by id
    expect(adminCat.apps.map((a) => a.id)).toEqual(expect.arrayContaining(["doc-app", "nango-app"]));

    // Secrets never reach the client.
    const blob = JSON.stringify(adminCat);
    expect(blob).not.toContain("test-remote-key");
    expect(blob).not.toContain("REMOTE_AGENT_KEY");
    expect(adminCat.agents.find((a) => a.id === "remote-chat")).not.toHaveProperty("apiKey");

    const userCat = await (await fetch(`${BASE}/api/catalog`, { headers: USER })).json();
    expect(userCat.agents.map((a) => a.id)).not.toContain("admin-agent");
    expect(userCat.agents.map((a) => a.id)).toContain("remote-chat");
  });

  test("refresh is admin-gated; cloud change broadcasts catalog_changed", async () => {
    const forbidden = await fetch(`${BASE}/api/catalog/refresh`, { method: "POST", headers: USER });
    expect(forbidden.status).toBe(403);

    const admin = await openWs(ADMIN);
    await waitFor(() => admin.msgs.some((m) => m.type === "agents"));
    fixtureDoc.agents.push({ id: "added-agent", type: "agent-remote", mode: "link", url: "https://example.com/added" });
    const r = await fetch(`${BASE}/api/catalog/refresh`, { method: "POST", headers: ADMIN });
    expect(r.ok).toBeTruthy();
    await waitFor(() => admin.msgs.some((m) => m.type === "catalog_changed"));
    admin.ws.close();

    const cat = await (await fetch(`${BASE}/api/catalog`, { headers: ADMIN })).json();
    expect(cat.agents.map((a) => a.id)).toContain("added-agent");
  });

  test("a catalog chat agent is served locally with a persona preset, not forked", async () => {
    mock.lastChat = null;
    const user = await openWs(USER);
    await waitFor(() => user.msgs.some((m) => m.type === "agents"));

    // Selecting it is a preset switch: the entry's own id becomes the session's
    // agent mode (the deployment generated a persona preset for it), which is
    // what keeps the turn on the local runtime — its tools, MCP servers and
    // history — instead of a bare remote model.
    user.ws.send(JSON.stringify({ type: "set_agent", id: "remote-chat" }));
    await waitFor(() => user.msgs.some((m) => m.type === "agent_changed" && m.id === "remote-chat"));
    await waitFor(() => user.msgs.some((m) => m.type === "current_preset" && m.id === "remote-chat"));

    user.ws.send(JSON.stringify({ type: "prompt", text: "hi" }));
    // Local turns need a provider; the assertion that matters here is the
    // ROUTING, so accept either outcome (a reply, or the local provider's
    // error in a keyless CI run) — both prove the fork did not happen.
    await waitFor(() =>
      user.msgs.some((m) => m.type === "done") || user.msgs.some((m) => m.type === "error"),
      30_000,
    );
    expect(mock.lastChat).toBeNull(); // the entry's endpoint was never called

    // Switching back to `local` must drop the pack persona. The pack's id IS
    // the persisted preference while it is selected (that is what a restart
    // composes), so the pick made before it has to survive somewhere — reading
    // `agent.preset` back would otherwise re-select the pack and the picker
    // would name an agent the persona is not.
    user.msgs.length = 0;
    user.ws.send(JSON.stringify({ type: "set_agent", id: "local" }));
    await waitFor(() => user.msgs.some((m) => m.type === "agent_changed" && m.id === "local"));
    await waitFor(() => user.msgs.some((m) => m.type === "current_preset" && m.id === "standard"));
    user.ws.close();
  });

  test("a `local: false` chat agent forks to its OpenAI-compatible endpoint with the conversation", async () => {
    mock.lastChat = null;
    const user = await openWs(USER);
    await waitFor(() => user.msgs.some((m) => m.type === "agents"));
    // The opt-out entry has no persona preset, so this switch is not a preset
    // change and streams from the mock instead.
    user.ws.send(JSON.stringify({ type: "set_agent", id: "remote-fork" }));
    await waitFor(() => user.msgs.some((m) => m.type === "agent_changed" && m.id === "remote-fork"));
    user.ws.send(JSON.stringify({ type: "prompt", text: "hi" }));
    await waitFor(() => user.msgs.some((m) => m.type === "done"));

    const text = user.msgs.filter((m) => m.type === "text").map((m) => m.delta).join("");
    expect(text).toBe("Hello remote world");
    // apiKeyEnv was resolved server-side and used as the bearer.
    expect(mock.lastChat.auth).toBe("Bearer test-remote-key");
    expect(mock.lastChat.body.model).toBe("mock-model");
    expect(mock.lastChat.body.messages[0].content).toBe("hi");

    // A second prompt carries the mirrored conversation: a fork has no
    // server-side session, so without this replay every turn starts from
    // nothing (the reported "the agent has no memory" bug).
    user.msgs.length = 0;
    user.ws.send(JSON.stringify({ type: "prompt", text: "and again" }));
    await waitFor(() => user.msgs.some((m) => m.type === "done"));
    // The tail is this session's exchange; earlier mirrored turns (from the
    // tests before this one) ride along too, which is the point.
    const sent = mock.lastChat.body.messages.map((m) => `${m.role}:${m.content}`);
    expect(sent.slice(-3)).toEqual(["user:hi", "assistant:Hello remote world", "user:and again"]);
    expect(sent.length).toBeGreaterThan(3);
    user.ws.close();
  });

  test("connect broker mints a Nango session server-side", async () => {
    const r = await fetch(`${BASE}/api/apps/nango-app/connect`, { method: "POST", headers: USER });
    expect(r.status).toBe(200);
    const { url } = await r.json();
    expect(url).toContain("session_token=stub-session-token");

    // The stub saw the server-held secret + user-scoped tags; the secret
    // itself never appears in the response.
    expect(mock.lastConnect.auth).toBe("Bearer test-nango-secret");
    expect(mock.lastConnect.tags).toEqual({
      end_user_id: "bob@corp.com",
      end_user_email: "bob@corp.com",
      organization_id: "corp.com",
    });
    expect(JSON.stringify({ url })).not.toContain("test-nango-secret");
  });
});
