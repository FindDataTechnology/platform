// Live-service test helpers.
//
// The `live` Playwright project targets the *deployed* k3s NodePort
// (http://23.144.68.246:30950 by default) instead of a locally-launched
// `node server.js`. These tests are read-only: they assert the deployed app
// boots, routes resolve, the WS connects, and the embedded panels mount -
// without writing chat history, uploading documents, or spending LLM tokens
// (the @live-smoke chat-turn is gated behind LIVE_SMOKE=1).
//
// Re-exports the navigation helpers from helpers.js so the live suite uses the
// exact same contract (status-text "Connected", testids) as the local suite.

export const LIVE_SERVICE_URL =
  process.env.LIVE_SERVICE_URL || "http://23.144.68.246:30950";

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
