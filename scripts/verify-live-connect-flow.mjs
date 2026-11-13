// Live end-to-end walk-through of the registry-sso-credentials flow on a
// deployed instance (registry-sso-credentials task 5.1).
//
//   LOGTO_EMAIL=… LOGTO_PASSWORD=… node scripts/verify-live-connect-flow.mjs
//
// Runs the real thing against https://craw.finddatatech.cloud (PLATFORM_URL_LIVE
// overrides): sign in to the platform, connect the MCP market with ONE click
// (the silent-SSO path — no credential is typed in the platform), install a
// registry-origin server, then verify the installed record references the
// credential and that the EFFECTIVE PROFILE dsh loads carries the resolved
// Authorization header. Finally one chat turn, so the deploy's LLM + agent path
// is exercised too.
//
// The environment is restored: the installed MCP server is removed again; the
// credential row is left connected (it belongs to the account that ran this).
//
// The profile check reads the pod's dsh home through the host that mounts it
// (PROFILE_HOST=cheap1 by default, then on to the node running the pod).
import { chromium } from "@playwright/test";
import { execFile } from "node:child_process";

const PLATFORM = process.env.PLATFORM_URL_LIVE || "https://craw.finddatatech.cloud";
const EMAIL = process.env.LOGTO_EMAIL;
const PASSWORD = process.env.LOGTO_PASSWORD;
// Empty = pick at runtime (see step 4). Do not pin a server this deployment
// already serves — it is not ours to install or remove.
const INSTALL_MCP = process.env.INSTALL_MCP || "";
const PROFILE_HOST = process.env.PROFILE_HOST || "cheap1";
const PROFILE_NODE = process.env.PROFILE_NODE || "root@100.64.0.12";
const PROFILE_PATH = process.env.PROFILE_PATH || "/opt/patch-dsh-home/profiles/platform/mcp.patch.yml";
const CONNECT_TIMEOUT_MS = Number(process.env.CONNECT_TIMEOUT_MS || 120_000);
const CHAT_TIMEOUT_MS = Number(process.env.CHAT_TIMEOUT_MS || 180_000);
if (!EMAIL || !PASSWORD) throw new Error("LOGTO_EMAIL/LOGTO_PASSWORD not set");

const results = [];
const ok = (m) => { results.push(`PASS  ${m}`); console.log(`✓ ${m}`); };
const bad = (m) => { results.push(`FAIL  ${m}`); console.log(`✗ ${m}`); };

function exec(cmd, args, timeout = 30_000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout }, (err, stdout, stderr) =>
      err ? reject(new Error(`${err.message}\n${stderr || ""}`)) : resolve(stdout));
  });
}

// The pod's dsh home is a hostPath on the node it runs on; reach it through the
// host whose ssh config already knows the way there (cheap1 → the node).
async function readProfile() {
  const remote = `ssh -o BatchMode=yes -o StrictHostKeyChecking=no ${PROFILE_NODE} 'cat ${PROFILE_PATH}'`;
  return exec("ssh", ["-o", "BatchMode=yes", PROFILE_HOST, remote], 30_000);
}

// Logto's hosted login, in whatever frame it appears: only the fields that are
// actually on screen are filled, so this works both when the platform redirects
// and when the registry window stops there first.
async function fillLogtoForm(page, timeoutMs = 30_000) {
  const identifier = page.locator('input[name="identifier"]');
  if (await identifier.isVisible().catch(() => false)) {
    await identifier.fill(EMAIL);
    await identifier.press("Enter");
  }
  const password = page.locator('input[name="password"]');
  await password.waitFor({ state: "visible", timeout: timeoutMs });
  await password.fill(PASSWORD);
  await password.press("Enter");
}

async function signInPlatform(page) {
  await page.goto(`${PLATFORM}/login`, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await page.waitForTimeout(3000);
  // With AUTH_MODE=logto the page is a landing card, not a redirect: it takes
  // the "Sign in with SSO" click to reach the identity provider.
  if (!/auth\.finddatatech\.cloud/.test(page.url())) {
    const sso = page.getByRole("link", { name: /sign in with sso/i });
    if (await sso.isVisible().catch(() => false)) {
      await sso.click();
      await page.waitForTimeout(4000);
    }
  }
  if (!/auth\.finddatatech\.cloud/.test(page.url())) return page.url();
  await fillLogtoForm(page);
  await page
    .waitForURL((u) => !/auth\.finddatatech\.cloud/.test(u.href), { timeout: 90_000 })
    .catch(() => {});
  await page.waitForTimeout(2000);
  return page.url();
}

// The registry window either closes itself (a registry session already lives in
// this browser) or lands on the registry's own login page, which offers exactly
// one button: "Continue with Logto". Clicking it completes the SSO sign-in with
// NO credential typed (the platform's sign-in already established the Logto
// session) and sets the registry's own SameSite=None session cookie, which is
// what the platform-side mint then rides on.
//
// It runs concurrently with the state poll, and it NEVER throws: the platform
// closes this window itself the moment the mint lands, so "the window went away
// mid-sentence" is the success path, not an error.
async function driveRegistryWindow(popup) {
  if (!popup) return "no window at all (registry session already live) — one click";
  try {
    await popup.waitForLoadState("domcontentloaded", { timeout: 30_000 }).catch(() => {});
    // The registry's login card renders "No login methods are currently
    // configured" when its own /api/auth/providers call loses the race against
    // whatever else the browser is loading — observed while the platform SPA was
    // still fetching its bundle. Reloading it clears it, so retry rather than
    // report a registry hiccup as a connect failure.
    let hasLogos = false;
    for (let attempt = 1; attempt <= 3 && !hasLogos; attempt++) {
      hasLogos = await popup
        .getByRole("button", { name: /continue with logto/i })
        .isVisible({ timeout: 12_000 })
        .catch(() => false);
      if (!hasLogos && attempt < 3) {
        await popup.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
        await popup.waitForTimeout(3000);
      }
    }
    if (hasLogos) {
      await popup.getByRole("button", { name: /continue with logto/i }).click();
      if (/auth\.finddatatech\.cloud/.test(popup.url())) {
        // Only reachable if Logto itself asks: report it, because it contradicts
        // the "nothing typed" claim.
        await fillLogtoForm(popup, 20_000).catch(() => {});
        return "the registry window went through Logto WITH a form — finding";
      }
      return `"Continue with Logto" clicked on the registry's own page (still nothing typed) — two clicks`;
    }
    if (/auth\.finddatatech\.cloud/.test(popup.url())) {
      await fillLogtoForm(popup, 20_000).catch(() => {});
      return "the registry window had to sign in to Logto (credentials typed) — finding";
    }
    const text = await popup.locator("body").innerText().catch(() => "");
    return `nothing to click at ${popup.url().slice(0, 60)} — page said "${text.replace(/\s+/g, " ").slice(0, 80)}"`;
  } catch (err) {
    return `window was closed by the platform while it was being driven (${String(err.message).split("\n")[0].slice(0, 60)}) — the mint had landed`;
  }
}

const browser = await chromium.launch({ args: ["--proxy-server=direct://"] });
// A throwaway context, so forcing the UI language is not a change to anyone's
// account: the text lookups below ("Store", "Install") are English.
const ctx = await browser.newContext();
await ctx.addInitScript(() => {
  try { localStorage.setItem("platform.locale", "en"); } catch { /* ignore */ }
});
const page = await ctx.newPage();

try {
  // ── 1. sign in to the platform ───────────────────────────────────────────
  const landed = await signInPlatform(page);
  if (/auth\.finddatatech\.cloud/.test(landed)) throw new Error(`login did not leave Logto (at ${landed})`);
  ok(`signed in to ${new URL(landed).origin} as ${EMAIL}`);

  // ── 2. reset the connection so this run is self-contained ────────────────
  const reset = await page.evaluate(async () => {
    await fetch("/api/registry/connection", { method: "DELETE" });
    return fetch("/api/registry/connection").then((r) => r.json());
  });
  if (reset.connected !== false) throw new Error(`could not reset the credential: ${JSON.stringify(reset)}`);
  ok("credential state reset (disconnected)");

  // ── 3. one click connects the market ────────────────────────────────────
  await page.goto(`${PLATFORM}/settings/mcp`, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await page.getByTestId("extensions-page").waitFor({ state: "visible", timeout: 45_000 });
  // Let the SPA finish loading before opening the registry window: its login
  // card gives up on its own provider list if it loses the race for the
  // browser's connections to whatever is still in flight here.
  await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
  await page.getByRole("button", { name: /store/i }).click();
  const panel = page.getByTestId("mcp-market-section").getByTestId("registry-connect-panel");
  await panel.waitFor({ state: "visible", timeout: 45_000 });
  ok(`Store panel visible, state=${await panel.getAttribute("data-registry-state")}`);

  const popupPromise = ctx.waitForEvent("page", { timeout: 15_000 }).catch(() => null);
  await panel.getByTestId("registry-connect").click();
  // Drive the window and poll the state at the same time: the click that opens
  // the SSO pass-through and the mint that follows it are one continuous race,
  // and the window disappears the instant the mint lands.
  const howPromise = popupPromise.then((popup) => driveRegistryWindow(popup));

  const deadline = Date.now() + CONNECT_TIMEOUT_MS;
  let state = await panel.getAttribute("data-registry-state");
  while (Date.now() < deadline && state !== "connected") {
    await page.waitForTimeout(1500);
    state = await panel.getAttribute("data-registry-state");
  }
  ok(`registry window: ${await howPromise}`);
  if (state !== "connected") throw new Error(`one-click connect did not complete (state=${state})`);
  const conn = await page.evaluate(() => fetch("/api/registry/connection").then((r) => r.json()));
  if (!conn.connected || !conn.expiresAt) throw new Error(`unexpected connection payload: ${JSON.stringify(conn)}`);
  if (/access_token|bearer/i.test(JSON.stringify(conn))) throw new Error("the connection payload leaked a token");
  ok(`connected with no credential typed in the platform — expires ${conn.expiresAt} (source=${conn.source})`);

  // ── 4. install a registry-origin server ─────────────────────────────────
  // The deployment already serves several registry servers (group-injected),
  // so pick a registry entry that is NOT installed: installing over one of
  // those, or removing it afterwards, would edit the environment rather than
  // observe it. INSTALL_MCP pins the choice; otherwise the first free one wins.
  const pick = await page.evaluate(async (pinned) => {
    const [market, installed] = await Promise.all([
      fetch("/api/extensions/market").then((r) => r.json()),
      fetch("/api/extensions/mcp").then((r) => r.json()),
    ]);
    const have = new Set((installed.servers || []).map((s) => s.name));
    const free = (market.mcpServers || []).filter((s) => s.origin === "registry" && !have.has(s.name));
    const chosen = pinned ? free.find((s) => s.name === pinned) : free[0];
    return {
      chosen: chosen?.name || null,
      endpoint: chosen?.configTemplate?.url || null,
      free: free.map((s) => s.name).slice(0, 8),
      have: [...have],
    };
  }, INSTALL_MCP || null);
  if (!pick.chosen) {
    throw new Error(`no free registry entry to install (installed: ${pick.have.join(", ")}; free: ${pick.free.join(", ")})`);
  }
  const target = pick.chosen;
  ok(`install target: ${target} (already installed, untouched: ${pick.have.join(", ")})`);

  const card = page.locator(`[data-testid="mcp-market-card"][data-market-name="${target}"]`);
  await card.scrollIntoViewIfNeeded();
  await card.getByRole("button", { name: /install/i }).click();
  const dialogPanel = page.locator('[data-testid="registry-connect-panel"][data-registry-compact="true"]');
  await dialogPanel.waitFor({ state: "visible", timeout: 30_000 });
  if ((await dialogPanel.getAttribute("data-registry-state")) !== "connected") {
    throw new Error("the install dialog does not see the live credential");
  }
  if ((await page.getByLabel("Authorization").count()) !== 0) {
    throw new Error("the install dialog still asks for a credential");
  }
  if (!(await page.getByTestId("form-submit").isEnabled())) throw new Error("Add is disabled despite a live credential");
  ok("install dialog: no credential field, Add enabled immediately");

  await page.getByTestId("form-submit").click();
  // The install round-trips through the DB, the profile write and a market
  // refresh, so poll for the record rather than guessing one sleep.
  let installed = null;
  const installDeadline = Date.now() + 30_000;
  while (Date.now() < installDeadline && !installed) {
    await page.waitForTimeout(1500);
    const servers = await page.evaluate(() => fetch("/api/extensions/mcp").then((r) => r.json()));
    installed = (servers.servers || []).find((s) => s.name === target) || null;
  }
  if (!installed) throw new Error(`${target} was not installed`);
  if (installed.config?.credentialRef !== "registry") {
    throw new Error(`no credentialRef on the record: ${JSON.stringify(installed.config)}`);
  }
  if (installed.config?.headers) {
    throw new Error(`the record embeds headers: ${JSON.stringify(installed.config.headers)}`);
  }
  ok(`installed ${target}: the record references the credential, no secret inside`);

  // ── 5. the effective profile carries the resolved header ────────────────
  const patch = await readProfile();
  if (/Bearer <your_token>|Bearer your_/i.test(patch)) throw new Error("the profile still carries a placeholder header");
  // The deployment's own group-injected servers carry managed tokens, so look
  // at THIS entry only: from its serverName to the next list item.
  const flat = patch.replace(/\s+/g, " ");
  const at = flat.indexOf(`serverName: ${target}`);
  if (at < 0) {
    throw new Error(`${target} is not in the profile the pod loads (names present: ${[...patch.matchAll(/serverName: ([^\s]+)/g)].map((m) => m[1]).join(", ")})`);
  }
  const rest = flat.slice(at);
  const nextItem = rest.indexOf("- id: ", 10);
  const entry = nextItem > 0 ? rest.slice(0, nextItem) : rest;
  // Folded scalars put the ">-" marker between the key and the value.
  const bearer = entry.match(/Authorization: (?:>-\s*)?Bearer\s+([A-Za-z0-9._~+/-]+=*)/);
  if (!bearer) {
    // Never echo the entry itself: it would print a live token.
    throw new Error(
      `${target}'s profile entry carries no resolved Authorization header (entry: ${entry.replace(/Bearer\s+\S+/g, "Bearer <redacted>").slice(0, 200)})`,
    );
  }

  // The header must be the user's own stored credential — cross-check the token
  // itself against the connection's reported expiry (a token-free comparison:
  // only the JWT's claims are read, and they are not printed).
  const claims = JSON.parse(Buffer.from(bearer[1].split(".")[1] || "", "base64url").toString("utf8"));
  const expected = Math.floor(Date.parse(conn.expiresAt) / 1000);
  if (!claims.exp || Math.abs(claims.exp - expected) > 60) {
    throw new Error(`the injected token is not the stored credential (exp ${claims.exp} vs ${expected})`);
  }
  ok(`effective profile entry for ${target} injects the user's own credential at write time (JWT exp matches ${conn.expiresAt}, ${bearer[1].length} chars)`);

  // ── 5b. that credential actually opens the server ───────────────────────
  // The same handshake dsh performs at startup, with the same header the
  // profile injects: initialize + tools/list against the registry's MCP
  // endpoint. This is the "MCP call succeeds" half of the task-5.1 runbook.
  const mcpUrl = pick.endpoint || `${new URL(conn.registryUrl).origin}/${target}/mcp`;
  const rpc = async (body, sessionId) => {
    const res = await fetch(mcpUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${bearer[1]}`,
        ...(sessionId ? { "mcp-session-id": sessionId } : {}),
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, sessionId: res.headers.get("mcp-session-id"), text };
  };
  const parseRpc = (text) => {
    const line = text.split(/\r?\n/).find((l) => l.startsWith("data: "));
    return JSON.parse(line ? line.slice(6) : text);
  };
  const init = await rpc({
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "paas-verify", version: "1" } },
  });
  if (init.status !== 200) throw new Error(`MCP initialize returned ${init.status}: ${init.text.slice(0, 200)}`);
  const server = parseRpc(init.text)?.result?.serverInfo?.name || "unknown";
  const list = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, init.sessionId);
  const tools = parseRpc(list.text)?.result?.tools || [];
  if (list.status !== 200 || tools.length === 0) {
    throw new Error(`MCP tools/list returned ${list.status} with ${tools.length} tools: ${list.text.slice(0, 200)}`);
  }
  ok(`the injected credential opens ${target}: initialize → "${server}", tools/list → ${tools.length} tools (e.g. ${tools[0].name})`);

  // ── 6. one chat turn through the deployed instance ──────────────────────
  await page.goto(`${PLATFORM}/chat`, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await page.getByTestId("composer-input").waitFor({ state: "visible", timeout: 45_000 });
  const before = await page.getByTestId("turn-assistant").count();
  await page.getByTestId("composer-input").fill("只回复两个字：收到");
  await page.getByTestId("composer-send").click();
  await page.waitForFunction(
    (n) => {
      const turns = document.querySelectorAll('[data-testid="turn-assistant"]');
      const last = turns[turns.length - 1];
      return turns.length > n && last && last.getAttribute("data-streaming") === "false";
    },
    before,
    { timeout: CHAT_TIMEOUT_MS },
  );
  const answer = (await page.getByTestId("turn-assistant").last().innerText()).replace(/\s+/g, " ").trim();
  if (!answer) throw new Error("the assistant turn came back empty");
  ok(`chat turn answered: "${answer.slice(0, 70)}"`);

  // ── 7. restore ──────────────────────────────────────────────────────────
  const status = await page.evaluate(
    (name) => fetch(`/api/extensions/mcp/${encodeURIComponent(name)}`, { method: "DELETE" }).then((r) => r.status),
    target,
  );
  const left = await page.evaluate(() => fetch("/api/extensions/mcp").then((r) => r.json()));
  const gone = !(left.servers || []).some((s) => s.name === target);
  ok(`cleanup: ${gone ? "uninstalled" : "FAILED to uninstall"} ${target} (HTTP ${status}); the credential itself is left connected`);
  if (!gone) process.exitCode = 1;
} catch (err) {
  bad(err?.message || String(err));
  process.exitCode = 1;
} finally {
  console.log("\n── summary ──");
  for (const r of results) console.log(r);
  await browser.close();
}
