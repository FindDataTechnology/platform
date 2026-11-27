// Live-service test helpers.
//
// The `live` Playwright project targets the *deployed* public entry
// (https://platform.finddatatech.cloud by default) instead of a locally-launched
// `node server.js`. The old default pointed at an internal NodePort that has
// since gone dark, and keeping it made every live run fail as if the product
// were broken (2026-11-14). These tests are read-only: they assert the deployed app
// boots, routes resolve, the WS connects, and the embedded panels mount -
// without writing chat history, uploading documents, or spending LLM tokens
// (the @live-smoke chat-turn is gated behind LIVE_SMOKE=1).
//
// Re-exports the navigation helpers from helpers.js so the live suite uses the
// exact same contract (status-text "Connected", testids) as the local suite.

export const LIVE_SERVICE_URL =
  process.env.LIVE_SERVICE_URL || "https://platform.finddatatech.cloud";

// Truthy when the @live-smoke chat-turn should run (spends one LLM token).
// Read lazily so a `LIVE_SMOKE=1` set on the playwright CLI is honored.
export function liveSmokeEnabled() {
  return process.env.LIVE_SMOKE === "1" || process.env.LIVE_SMOKE === "true";
}

// Skip guard for the @live-smoke test. Use inside the test body so the test is
// reported as skipped (not absent) when LIVE_SMOKE is unset.
//
//   test("live chat-turn @live-smoke", async ({ page }) => {
//     test.skip(!liveSmokeEnabled(), "set LIVE_SMOKE=1 to run the live chat-turn");
//     ...
//   });
export { gotoChat, gotoDashboard, gotoDocuments, pinLocaleEn } from "./helpers.js";

/**
 * Log in through Logto against the deployed entry, and wait for the app shell.
 *
 * This lives here rather than in one spec file because two live specs need it
 * now (the meeting lane and the client-entry lane), and a fragile fixture that
 * exists twice drifts silently — one copy gets the retry-on-blank-page fix and
 * the other keeps failing as if the product were broken.
 *
 * Logto's form is not always rendered: two fresh contexts signing in the same
 * account within seconds can leave the click on a blank page (the identifier
 * field never appears for 30s). That is a fixture fragility, not a product
 * path, so it gets exactly one retry.
 */
export async function logtoSignIn(page, { identifier, password, baseUrl = LIVE_SERVICE_URL }) {
  await page.goto(`${baseUrl}/`, { waitUntil: "domcontentloaded" });
  const appOrigin = new URL(page.url()).origin;
  const sso = page.getByTestId("sso-login");
  await sso.waitFor({ state: "visible", timeout: 30_000 });
  await sso.click();
  const identifierInput = page.locator('input[name="identifier"]').first();
  try {
    await identifierInput.waitFor({ state: "visible", timeout: 20_000 });
  } catch {
    await page.goto(`${baseUrl}/`, { waitUntil: "domcontentloaded" });
    await sso.waitFor({ state: "visible", timeout: 30_000 });
    await sso.click();
    await identifierInput.waitFor({ state: "visible", timeout: 30_000 });
  }
  for (const [field, value] of [["identifier", identifier], ["password", password]]) {
    const input = page.locator(`input[name="${field}"]`).first();
    await input.waitFor({ state: "visible", timeout: 30_000 });
    await input.fill(value);
    await page.locator('button[name="submit"]').first().click();
  }
  // The consent screen races the app shell: only one of them appears.
  const status = page.getByTestId("status-text");
  const consent = page.locator('button[name="submit"]').first();
  await Promise.race([
    status.waitFor({ state: "visible", timeout: 60_000 }),
    consent.waitFor({ state: "visible", timeout: 60_000 }),
  ]).catch(() => {});
  if (new URL(page.url()).origin !== appOrigin) {
    await consent.click({ timeout: 30_000 }).catch(() => {});
  }
  await status.waitFor({ state: "visible", timeout: 60_000 });
}
