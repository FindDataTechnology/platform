import { test, expect } from "@playwright/test";
import { gotoChat } from "./helpers.js";

// @smoke - reconnect resync (add-reconnect-resync). Two real chat turns
// (one LLM call each), driven through the exact failure the change fixes:
// a mobile-style socket drop mid-stream used to stamp a false "Interrupted"
// marker and swallow the rest of the run; the server keeps executing, the
// reconnect re-syncs the session, and the view converges without ever
// claiming the answer was cut off.
//
// Asserts:
//   1. Drop mid-run → transient connection-lost marker (NOT interrupted),
//      streaming state kept; reconnect → marker clears, run completes,
//      final text is a superset of what was visible before the drop.
//   2. Run completing while offline → reconnect replaces the view with the
//      persisted full answer (running:false truthful finalization).

const LONG_PROMPT = "Count from 1 to 100, one number per line, no other words.";

// Kill the page's live WS deterministically. Chromium's offline emulation
// does NOT tear down an ESTABLISHED WebSocket, so setOffline alone leaves the
// socket streaming; drive the drop through the app's own reconnect hook (the
// connection banner's retry button dispatches the same event): the live
// socket is superseded, its replacement cannot connect while the network is
// offline, and the client reports disconnected. Network back + `online`
// fires the immediate reconnect the hook listens for.
async function dropSocket(page) {
  await page.context().setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event("platform:reconnect")));
}

// Drop the moment the run is demonstrably mid-stream (first text on the last
// turn). The transient marker only renders on a streaming turn, so dropping
// after completion would vacuously fail; the long prompt keeps the run alive
// through the offline assertions that follow.
async function waitForMidStream(page) {
  await page.waitForFunction(() => {
    const els = document.querySelectorAll('[data-testid="turn-assistant"]');
    const el = els[els.length - 1];
    if (!el || el.getAttribute("data-streaming") !== "true") return false;
    const clone = el.cloneNode(true);
    clone.querySelectorAll('[data-testid="thinking-block"]').forEach((n) => {
      n.remove();
    });
    return (clone.textContent || "").trim().length > 3;
  }, { timeout: 30000 });
}

async function restoreNetwork(page) {
  await page.context().setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
}

async function sendPrompt(page, text) {
  await page.getByTestId("composer-input").fill(text);
  await page.getByTestId("composer-send").click();
}

async function streamingTurnText(page) {
  return page.getByTestId("turn-assistant").last().evaluate((el) => {
    const clone = el.cloneNode(true);
    clone.querySelectorAll('[data-testid="thinking-block"]').forEach((n) => {
      n.remove();
    });
    return (clone.textContent || "").trim();
  });
}

test("@smoke drop mid-run shows a transient state and recovers on reconnect", async ({ page }) => {
  await gotoChat(page);
  await sendPrompt(page, LONG_PROMPT);

  const turn = page.getByTestId("turn-assistant").last();
  await expect(turn).toBeVisible({ timeout: 30000 });
  await expect(turn).toHaveAttribute("data-streaming", "true", { timeout: 10000 });
  await waitForMidStream(page);

  // Kill the network + socket mid-stream. The page-level banner and the
  // turn-level transient marker appear — and the false interrupted marker
  // must NOT.
  await dropSocket(page);
  await expect(page.getByTestId("connection-banner")).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId("turn-connection-lost")).toBeVisible({ timeout: 10000 });
  await expect(page.getByTestId("turn-interrupted")).toHaveCount(0);
  await expect(turn).toHaveAttribute("data-streaming", "true");

  const textAtDrop = await streamingTurnText(page);

  // Network back: the browser fires `online`, the WS hook reconnects
  // immediately, onOpen re-syncs the session, and the run continues (replay
  // or live tail). The transient markers clear and the turn completes.
  await restoreNetwork(page);

  await expect(page.getByTestId("connection-banner")).toHaveCount(0, { timeout: 15000 });
  await expect(page.getByTestId("turn-connection-lost")).toHaveCount(0, { timeout: 15000 });
  await expect(turn).toHaveAttribute("data-streaming", "false", { timeout: 45000 });
  await expect(page.getByTestId("turn-interrupted")).toHaveCount(0);

  // No visible content loss, measured on the prompt's semantics (the DOM
  // text of a streaming turn carries UI chrome — cursor, labels — that the
  // settled view drops, so raw char counts are not comparable): every number
  // the user had already read at the moment of the drop survives, and the
  // converged view carries the full answer (the prompt counts to 40).
  const numbersIn = (s) => (s.match(/\d+/g) || []).map(Number);
  const dropMax = Math.max(0, ...numbersIn(textAtDrop));
  const finalText = await streamingTurnText(page);
  const finalNums = numbersIn(finalText);
  expect(Math.max(0, ...finalNums), `at-drop=${textAtDrop} final=${finalText}`).toBeGreaterThanOrEqual(dropMax);
  expect(finalNums, "the converged view carries the full answer").toContain(100);
  expect(finalText.length).toBeGreaterThan(10);
});

test("@smoke run finishing during the blackout finalizes truthfully on reconnect", async ({ page, request }) => {
  await gotoChat(page);
  await sendPrompt(page, "Reply with only the word: done");

  const turn = page.getByTestId("turn-assistant").last();
  await expect(turn).toBeVisible({ timeout: 30000 });
  await expect(turn).toHaveAttribute("data-streaming", "true", { timeout: 10000 });
  await waitForMidStream(page);

  // Drop and let the server finish the run while the client is offline. The
  // API request context is NOT tied to the page's offline emulation, so it
  // can observe the persistence landing.
  await dropSocket(page);
  await expect(page.getByTestId("turn-connection-lost")).toBeVisible({ timeout: 15000 });

  const assistantPersisted = async () => {
    const list = await (await request.get("/api/chat-history/sessions")).json();
    if (!list.current) return "";
    const session = await (await request.get(`/api/chat-history/sessions/${list.current}`)).json();
    const asst = (session.messages || []).filter((m) => m.role === "assistant");
    return asst.length ? asst[asst.length - 1].content || "" : "";
  };
  await expect.poll(assistantPersisted, { timeout: 45000 }).not.toBe("");

  // Reconnect: the resync answer reports running:false and the view takes
  // the persisted full answer — the truthful finalization, no marker.
  await restoreNetwork(page);
  await expect(turn).toHaveAttribute("data-streaming", "false", { timeout: 30000 });
  await expect(page.getByTestId("turn-interrupted")).toHaveCount(0);
  await expect(page.getByTestId("turn-connection-lost")).toHaveCount(0, { timeout: 15000 });
  const finalText = await streamingTurnText(page);
  expect(finalText.toLowerCase()).toContain("done");
});
