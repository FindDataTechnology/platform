import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { baseURL, gotoExtensions, tempStoreDirs } from "./helpers.js";

// registry-sso-credentials, task 3.3 — the Store's connect flow and the
// registry-shaped install:
//   * the connection panel reports state and its paste fallback stores a row
//   * the silent-SSO popup flow (login → mint → postMessage → backend) connects
//     with NO credential typing — against the hermetic registry stub
//     (e2e/registry-stub.js), which CORS-allows this origin with credentials
//     exactly as the real registry's ops config must
//   * a registry-origin entry's install form has no credential field while a
//     live credential exists (task 3.1), and routes to connect when it does not
//   * the installed record references the credential and the EFFECTIVE PROFILE
//     dsh loads carries the injected Authorization header (task 3.2)
//
// The live-registry + real-Logto pass is task 5.1 (needs fd-prod); this spec
// proves the same code paths against a stand-in.

const REGISTRY_STUB = process.env.E2E_REGISTRY_URL || "http://127.0.0.1:4599";
const REGISTRY_MCP = "e2e-registry-mcp";

// Path-only (never prepareTempStoreDirs here: a spec module is collected by
// the runner process, where the wipe guard does not apply).
const stores = tempStoreDirs();

function mcpPatchPath() {
  return path.join(stores.dshHome, "profiles", process.env.DSH_PROFILE || "platform", "mcp.patch.yml");
}

function readPatch() {
  const file = mcpPatchPath();
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
}

async function disconnect(request) {
  await request.delete(`${baseURL}/api/registry/connection`);
}

// A real 7-day token from the stub, minted exactly the way the popup mints one
// (login → CSRF → mint, session-cookie bound). Used to prove the paste path
// stores a decodable token and reports its expiry.
async function mintViaStub(request) {
  await request.get(`${REGISTRY_STUB}/login?redirect_uri=/`);
  const csrf = await request.get(`${REGISTRY_STUB}/api/auth/csrf-token`);
  expect(csrf.ok()).toBeTruthy();
  const { csrf_token } = await csrf.json();
  const minted = await request.post(`${REGISTRY_STUB}/api/tokens/generate`, {
    headers: { "x-csrf-token": csrf_token },
    data: { expires_in_hours: 168 },
  });
  expect(minted.ok()).toBeTruthy();
  const { access_token } = await minted.json();
  expect(access_token.split(".")).toHaveLength(3);
  return access_token;
}

async function gotoStore(page) {
  await gotoExtensions(page);
  await page.getByRole("button", { name: /store/i }).click();
  await expect(page.getByTestId("mcp-market-section")).toBeVisible();
}

// Two panels can be on screen at once (the Store's and the install dialog's);
// each scopes its own by the context attribute the component sets.
const sectionPanel = (page) => page.getByTestId("mcp-market-section").getByTestId("registry-connect-panel");
const dialogPanel = (page) => page.locator('[data-testid="registry-connect-panel"][data-registry-compact="true"]');

test.describe("MCP market credential", () => {
  test.beforeEach(async ({ request }) => {
    // Each test starts from "not connected" so the state transitions it
    // asserts are its own.
    await disconnect(request);
  });

  test("panel reports state; the paste fallback stores a credential", async ({ page, request }) => {
    await gotoStore(page);

    const panel = sectionPanel(page);
    await expect(panel).toBeVisible();
    await expect(panel).toHaveAttribute("data-registry-state", "disconnected");
    await expect(panel.getByTestId("registry-state-badge")).toContainText(/not connected/i);

    // Paste fallback (task 4.1): a token typed by hand writes the same row,
    // reports its parsed expiry, and is reported token-free by the API.
    const token = await mintViaStub(request);

    await panel.getByTestId("registry-paste-toggle").click();
    await panel.getByTestId("registry-token-input").fill(token);
    await panel.getByTestId("registry-paste-save").click();

    await expect(panel).toHaveAttribute("data-registry-state", "connected");
    await expect(panel.getByTestId("registry-state-badge")).toContainText(/connected/i);
    await expect(panel.getByTestId("registry-expiry")).toBeVisible();

    const status = await request.get(`${baseURL}/api/registry/connection`);
    expect(status.ok()).toBeTruthy();
    const body = await status.json();
    expect(body.connected).toBe(true);
    expect(body.expiresAt).toBeTruthy();
    expect(JSON.stringify(body)).not.toContain(token);
  });

  test("silent connect completes with no credential typing", async ({ page }) => {
    await gotoStore(page);
    await expect(sectionPanel(page)).toHaveAttribute("data-registry-state", "disconnected");

    // One click: popup → registry login (stub redirects straight back) → mint
    // with the session cookie → postMessage → POST /api/registry/credential.
    await sectionPanel(page).getByTestId("registry-connect").click();

    await expect(sectionPanel(page)).toHaveAttribute("data-registry-state", "connected", { timeout: 20000 });
    // The minted JWT's expiry is surfaced (7 days by the stub's default TTL).
    await expect(sectionPanel(page).getByTestId("registry-expiry")).toBeVisible();
  });

  test("registry install: no credential field with a live credential, header injected into the profile", async ({ page, request }) => {
    // Connect first through the API (the popup flow has its own test above).
    const connect = await request.post(`${baseURL}/api/registry/credential`, {
      data: { token: "opaque-e2e-token", source: "paste" },
    });
    expect(connect.ok()).toBeTruthy();

    await gotoStore(page);
    const card = page.locator(`[data-testid="mcp-market-card"][data-market-name="${REGISTRY_MCP}"]`);
    await expect(card).toBeVisible();
    await expect(card.getByTestId("mcp-registry-badge")).toBeVisible();

    await card.getByRole("button", { name: /install/i }).click();
    const dialog = page.getByRole("heading", { name: /add mcp/i });
    await expect(dialog).toBeVisible();

    // No fillable credential field, and Add is enabled immediately.
    await expect(dialogPanel(page)).toHaveAttribute("data-registry-state", "connected");
    await expect(page.getByLabel("Authorization")).toHaveCount(0);
    await expect(page.getByTestId("form-submit")).toBeEnabled();

    await page.getByTestId("form-submit").click();
    await expect(dialog).not.toBeVisible();

    // The stored record references the credential; it embeds no secret. The
    // effective profile dsh loads carries the resolved header (task 3.2).
    const servers = await request.get(`${baseURL}/api/extensions/mcp`).then((r) => r.json());
    const installed = servers.servers.find((s) => s.name === REGISTRY_MCP);
    expect(installed.config.credentialRef).toBe("registry");
    expect(installed.config.headers).toBeUndefined();

    await expect
      .poll(() => readPatch().includes("Authorization: Bearer opaque-e2e-token"), { timeout: 15000 })
      .toBe(true);

    // Cleanup: the row is shared with the other specs.
    await request.delete(`${baseURL}/api/extensions/mcp/${REGISTRY_MCP}`);
  });

  test("registry install without a credential routes to connect and keeps Add disabled", async ({ page }) => {
    await gotoStore(page);
    const card = page.locator(`[data-testid="mcp-market-card"][data-market-name="${REGISTRY_MCP}"]`);
    await expect(card).toBeVisible();
    await card.getByRole("button", { name: /install/i }).click();

    const dialog = page.getByRole("heading", { name: /add mcp/i });
    await expect(dialog).toBeVisible();

    // The install dialog offers the connect flow (and the paste fallback), and
    // does not let the install through.
    const panel = dialogPanel(page);
    await expect(panel).toHaveAttribute("data-registry-state", "disconnected");
    await expect(panel.getByTestId("registry-connect")).toBeVisible();
    await expect(panel.getByTestId("registry-paste-toggle")).toBeVisible();
    await expect(page.getByLabel("Authorization")).toHaveCount(0);
    await expect(page.getByTestId("form-submit")).toBeDisabled();

    // Connecting from inside the dialog (paste path — the popup has its own
    // test) releases Add without reopening anything.
    await panel.getByTestId("registry-paste-toggle").click();
    await panel.getByTestId("registry-token-input").fill("opaque-e2e-token");
    await panel.getByTestId("registry-paste-save").click();
    await expect(panel).toHaveAttribute("data-registry-state", "connected");
    await expect(page.getByTestId("form-submit")).toBeEnabled();

    await page.getByRole("button", { name: /cancel/i }).click();
    await expect(dialog).not.toBeVisible();
  });

  test("disconnect removes the credential and the row drops out of the profile", async ({ page, request }) => {
    await request.post(`${baseURL}/api/registry/credential`, { data: { token: "opaque-e2e-token", source: "paste" } });
    await request.post(`${baseURL}/api/extensions/mcp`, {
      data: { name: REGISTRY_MCP, config: { url: `${REGISTRY_STUB}/${REGISTRY_MCP}/mcp`, credentialRef: "registry" } },
    });
    await expect.poll(() => readPatch().includes(REGISTRY_MCP), { timeout: 15000 }).toBe(true);

    await gotoStore(page);
    await expect(sectionPanel(page)).toHaveAttribute("data-registry-state", "connected");
    await sectionPanel(page).getByTestId("registry-disconnect").click();
    await expect(sectionPanel(page)).toHaveAttribute("data-registry-state", "disconnected");

    // The installed record survives (it is not uninstalled), but the effective
    // profile no longer carries it.
    await expect.poll(() => readPatch().includes(REGISTRY_MCP), { timeout: 15000 }).toBe(false);
    const servers = await request.get(`${baseURL}/api/extensions/mcp`).then((r) => r.json());
    expect(servers.servers.some((s) => s.name === REGISTRY_MCP)).toBe(true);

    await request.delete(`${baseURL}/api/extensions/mcp/${REGISTRY_MCP}`);
  });
});
