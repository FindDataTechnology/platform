import { test, expect } from "@playwright/test";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import WebSocket from "ws";
import Database from "better-sqlite3";
import { baseURL } from "./helpers.js";

// Optional SSO (SSO_ENABLED=true) layered on AUTH_MODE=none.
//
// A second `node server.js` is spawned with SSO_ENABLED=true and isolated
// stores/DB/dsh home, so the shared webServer keeps exercising the default (no
// SSO) path and its dsh profile is never touched by this spec.

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
  });
}

async function waitFor(predicate, ms = 10_000, label = "condition") {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > ms) throw new Error(`waitFor timeout: ${label}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "paas-sso-e2e-"));
const DB_FILE = path.join(tmpRoot, "app.db");

// Case deliberately mixed: the server normalizes to lowercase before keying.
const ALICE = { "x-forwarded-email": "Alice@Corp.COM" };
const BOB = { "x-forwarded-email": "bob@corp.com" };

let child;
let BASE;
let bootLog = "";

async function api(pathname, { method = "GET", headers = {}, body } = {}) {
  const res = await fetch(`${BASE}${pathname}`, {
    method,
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    // Non-JSON (e.g. an HTML error page) — the status is the signal.
  }
  return { status: res.status, json };
}

// Collect every message a socket receives, optionally sending one first.
function openSocket(headers = {}, send) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${new URL(BASE).port}/`, { headers });
    const msgs = [];
    ws.on("message", (raw) => msgs.push(JSON.parse(raw.toString())));
    ws.on("open", () => {
      if (send) ws.send(JSON.stringify(send));
      resolve({ ws, msgs, types: () => msgs.map((m) => m.type) });
    });
    ws.on("error", reject);
  });
}

function mcpNames(binding) {
  return (binding.mcp || []).find((m) => m.name === "memory");
}

test.describe("SSO_ENABLED optional identity + user runtime bindings", () => {
  // beforeAll boots a second server.js — give the whole group headroom.
  test.describe.configure({ timeout: 180_000 });

  test.beforeAll(async () => {
    const port = await freePort();
    BASE = `http://127.0.0.1:${port}`;
    // Same seed names as the fast suite (see e2e/seed-fixtures.js) plus one
    // spare row that this spec marks locked in its own DB.
    const mcpPath = path.join(tmpRoot, "mcp.json");
    fs.writeFileSync(
      mcpPath,
      JSON.stringify({
        mcpServers: {
          memory: { command: "node", args: ["-e", "process.exit(0)"] },
          extra: { command: "node", args: ["-e", "process.exit(0)"] },
        },
      }),
    );

    child = spawn(process.execPath, ["server.js"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PORT: String(port),
        HOST: "127.0.0.1",
        AUTH_MODE: "none",
        SSO_ENABLED: "true",
        AGENTS_CONFIG_URL: "",
        CATALOG_REFRESH_SECS: "0",
        MCP_CONFIG_PATH: mcpPath,
        CHAT_HISTORY_STORE_DIR: path.join(tmpRoot, "chat"),
        DOCUMENTS_STORE_DIR: path.join(tmpRoot, "docs"),
        SESSIONS_STORE_DIR: path.join(tmpRoot, "sessions"),
        LLM_PROVIDERS_STORE: path.join(tmpRoot, "llm-providers.json"),
        LLM_DEFAULT_STORE: path.join(tmpRoot, "llm-default.json"),
        DB_PATH: DB_FILE,
        // Isolate this spawned server's dsh home (see prepareTempStoreDirs):
        // workers do not inherit the webServer's DSH_HOME, so without this the
        // child composes against — and rewrites — the developer's real ~/.dsh.
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

    // `extra` is a bundled-style locked row: the packager forbids disabling it.
    // Written straight into this spec's throwaway DB — the extension store
    // re-reads rows on every call, so no restart is needed.
    const db = new Database(DB_FILE);
    db.prepare("UPDATE extension_configs SET locked = 1 WHERE name = 'extra'").run();
    db.close();
  });

  test.afterAll(async () => {
    try {
      if (child) {
        child.kill("SIGKILL");
        child = null;
      }
      // Legacy cleanup from when this spec shared the webServer's dsh home:
      // re-enable the memory MCP on the shared server. Harmless no-op now
      // that the spawned server writes only to its own isolated home.
      await fetch(`${baseURL}/api/extensions/mcp/memory/enable`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      });
    } catch {
      // Best-effort cleanup; the next run rewrites the patch anyway.
    }
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  test("anonymous access stays open and reports the SSO surface", async () => {
    const me = await api("/api/auth/me");
    expect(me.status).toBe(200);
    expect(me.json).toMatchObject({
      mode: "none",
      authenticated: false,
      ssoConfigured: true,
      ssoAuthenticated: false,
      ssoEmail: null,
      ssoGroups: null,
    });

    // Open access is unchanged by the overlay: gated-by-nothing endpoints serve
    // anonymous callers exactly as before.
    expect((await api("/api/catalog")).status).toBe(200);
    expect((await api("/api/extensions/mcp")).status).toBe(200);
  });

  test("an identity header is not a login: no admin, and it is never req.user", async () => {
    // A real optional-SSO deployment trusts these headers only because the app
    // is unreachable except through the proxy. Even so, the overlay must not
    // grant the forward-auth `user` role: /api/auth/me keeps email/groups null.
    const me = await api("/api/auth/me", { headers: ALICE });
    expect(me.json).toMatchObject({
      mode: "none",
      email: null,
      groups: null,
      authenticated: false,
      ssoAuthenticated: true,
      ssoEmail: "alice@corp.com",
    });
  });

  test("bindings require an identity and never leak global MCP configuration", async () => {
    expect((await api("/api/users/me/bindings")).status).toBe(401);

    const { status, json } = await api("/api/users/me/bindings", { headers: ALICE });
    expect(status).toBe(200);
    // No personal row yet → the global default is reported as the fallback.
    expect(json.model.source).toBe("global");
    expect(json.model.id).toBeTruthy();

    const memory = mcpNames(json);
    expect(memory).toMatchObject({
      name: "memory",
      globalEnabled: true,
      personalEnabled: null,
      effectiveEnabled: true,
      locked: false,
    });
    // The snapshot is a public shape: names and booleans only. Credentials,
    // URLs and full server configs stay server-side.
    const serialized = JSON.stringify(json);
    for (const secret of ["configJson", "command", "headers", "Authorization", "apiKey", "url"]) {
      expect(serialized).not.toContain(secret);
    }
  });

  test("personal MCP availability is per-email and leaves the global row alone", async () => {
    const off = await api("/api/users/me/mcp/memory/enable", {
      method: "PATCH",
      headers: ALICE,
      body: { enabled: false },
    });
    expect(off.status).toBe(200);
    expect(off.json.ok).toBe(true);

    // Alice sees it off; Bob's snapshot is untouched (separate rows).
    const alice = await api("/api/users/me/bindings", { headers: ALICE });
    expect(mcpNames(alice.json)).toMatchObject({ personalEnabled: false, effectiveEnabled: false });
    const bob = await api("/api/users/me/bindings", { headers: BOB });
    expect(mcpNames(bob.json)).toMatchObject({ personalEnabled: null, effectiveEnabled: true });

    // Global administration is unchanged — a personal toggle is an overlay, not
    // an edit of the shared configuration.
    const global = await api("/api/extensions/mcp");
    const row = global.json.servers.find((s) => s.name === "memory");
    expect(row.enabled).toBe(true);
  });

  test("an unknown MCP name is rejected", async () => {
    const res = await api("/api/users/me/mcp/not-configured/enable", {
      method: "PATCH",
      headers: ALICE,
      body: { enabled: true },
    });
    expect(res.status).toBe(404);
  });

  test("a locked server cannot be disabled, and a globally disabled one cannot be enabled", async () => {
    const locked = await api("/api/users/me/mcp/extra/enable", {
      method: "PATCH",
      headers: ALICE,
      body: { enabled: false },
    });
    expect(locked.status).toBe(400);
    expect(locked.json.error).toContain("locked");

    // Turn `memory` off globally, then try to opt back in personally: accepting
    // that would store a switch that changes nothing.
    const global = await api("/api/extensions/mcp/memory/enable", {
      method: "PATCH",
      headers: ALICE,
      body: { enabled: false },
    });
    expect(global.status).toBe(200);

    const enable = await api("/api/users/me/mcp/memory/enable", {
      method: "PATCH",
      headers: ALICE,
      body: { enabled: true },
    });
    expect(enable.status).toBe(400);
    expect(enable.json.error).toContain("disabled globally");

    // Restore the global row so the remaining tests see an enabled server.
    await api("/api/extensions/mcp/memory/enable", {
      method: "PATCH",
      headers: ALICE,
      body: { enabled: true },
    });
  });

  test("personal model binding persists by normalized email", async () => {
    expect(
      (await api("/api/users/me/model", { method: "PUT", headers: ALICE, body: { providerId: "nope", modelId: "nope" } }))
        .status,
    ).toBe(400);

    const snapshot = await api("/api/users/me/bindings", { headers: ALICE });
    const { id, provider } = snapshot.json.model;

    // Case normalization: write under Alice@Corp.COM, read back under the
    // lowercase form and get the same row.
    const saved = await api("/api/users/me/model", {
      method: "PUT",
      headers: { "x-forwarded-email": "alice@corp.com" },
      body: { providerId: provider, modelId: id },
    });
    expect(saved.status).toBe(200);
    expect(saved.json.ok).toBe(true);

    const mine = await api("/api/users/me/bindings", { headers: ALICE });
    expect(mine.json.model).toMatchObject({ id, provider, source: "personal" });

    // Bob still falls back to the global default.
    const theirs = await api("/api/users/me/bindings", { headers: BOB });
    expect(theirs.json.model.source).toBe("global");
  });

  test("personal snapshots are private; runtime broadcasts stay identity-free", async () => {
    // An anonymous socket must never receive a bindings snapshot.
    const anon = await openSocket();
    // ...and a broadcast about the shared runtime reaches it without any email.
    const bob = await openSocket(BOB);

    const alice = await openSocket(ALICE, { type: "list_bindings" });
    await waitFor(
      async () => alice.types().includes("user_bindings"),
      5000,
      "alice user_bindings",
    );
    const payload = alice.msgs.find((m) => m.type === "user_bindings");
    expect(payload.model.source).toBe("personal");
    expect(JSON.stringify(payload)).not.toContain("alice@corp.com");
    expect(JSON.stringify(payload)).not.toContain("@corp.com");

    // Trigger a real runtime mutation from Alice; Bob's socket sees the
    // resulting global event but no personal data.
    await api("/api/users/me/mcp/memory/enable", {
      method: "PATCH",
      headers: ALICE,
      body: { enabled: false },
    });
    await waitFor(async () => bob.types().includes("runtime_binding"), 10_000, "runtime_binding");
    const runtime = bob.msgs.find((m) => m.type === "runtime_binding");
    expect(JSON.stringify(runtime)).not.toContain("@");

    await new Promise((r) => setTimeout(r, 300));
    expect(anon.types()).not.toContain("user_bindings");

    for (const s of [anon, bob, alice]) s.ws.close();
  });

  test("signing out does not reset the shared runtime", async () => {
    // "Sign out" is the proxy dropping the cookie: the request simply arrives
    // without the header. The shared runtime must keep serving the profile it
    // is already configured with, because other clients are on it too.
    const before = await api("/api/users/me/bindings", { headers: ALICE });
    const after = await api("/api/auth/me");
    expect(after.json.ssoAuthenticated).toBe(false);

    // The binding survives (it is keyed by email, not by a session) and an
    // anonymous client still sees the same runtime model.
    const persisted = await api("/api/users/me/bindings", { headers: ALICE });
    expect(persisted.json.model).toEqual(before.json.model);

    const anon = await openSocket(undefined, { type: "list_models" });
    await waitFor(async () => anon.msgs.length > 0, 10_000, "anon socket messages");
    const current = anon.msgs.find((m) => m.type === "current_model");
    expect(current?.id).toBeTruthy();
    anon.ws.close();
  });
});
