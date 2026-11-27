import { test, expect } from "@playwright/test";
import { gotoChat, waitForIdle } from "./helpers.js";

// Pack usage telemetry (add-pack-usage-telemetry 5.1): a completed turn lands
// a usage row, and the ops-gated aggregate reads it back. The fast lane's
// gateway is dead, so the turn itself errors — that still finishes (finishTurn
// fires on the idle/error settle) and the row records with outcome=error,
// which is exactly the fact under test: every completed turn counts.

test("a finished turn lands a usage row the ops aggregate reads back", async ({ page }) => {
  test.setTimeout(90_000);
  await gotoChat(page);
  await page.getByTestId("composer-input").fill("usage telemetry probe");
  await page.getByTestId("composer-send").click();

  // Dead-gateway turns settle via the retry ladder (~15-20s). Wait for the
  // turn to START (isStreaming flips true on dispatch) before waiting for the
  // settle — waitForIdle alone would pass before the turn began.
  await page.waitForFunction(
    () => window.__chatStore && window.__chatStore.getState().isStreaming === true,
    null,
    { timeout: 10_000 },
  );
  await waitForIdle(page, 60_000);

  // The ops surface: token from the e2e server env (playwright config).
  const res = await page.request.get("/api/ops/pack-usage?days=7", {
    headers: { Authorization: "Bearer e2e-pack-usage-token" },
  });
  expect(res.status()).toBe(200);
  const doc = await res.json();
  expect(Array.isArray(doc.rows)).toBe(true);
  // The probe's turn is in the 7-day window as a packless line (the fast lane
  // runs the local persona — pack origin NULL, never a pack inflation).
  const packless = doc.rows.find((r) => r.packId === null);
  expect(packless).toBeTruthy();
  expect(packless.turns).toBeGreaterThanOrEqual(1);

  // Gate: no credential, no data.
  const anon = await page.request.get("/api/ops/pack-usage?days=7");
  expect(anon.status()).toBe(401);
});
