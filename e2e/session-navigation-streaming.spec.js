import { test, expect } from "@playwright/test";
import { gotoChat } from "./helpers.js";

// Session navigation while a turn is live. The server admits the prompt
// synchronously (isStreaming flips before the first await), then the
// navigation arrives on the PAGE's own socket — deterministic without waiting
// on model output. Under per-viewer delivery (add-session-ownership) the
// navigating connection is the one whose view flips, so the page performs the
// navigation and the raw probe only starts the turn and observes how it ends
// (done, never a busy rejection).

// Open a raw WS, send a probe prompt, and resolve on the turn's terminal
// event (done | error) plus everything needed to assert no busy rejection.
function streamingProbe(page) {
  return page.evaluate(
    () =>
      new Promise((resolve) => {
        const ws = new WebSocket(window.location.origin.replace(/^http/, "ws") + "/");
        const errors = [];
        let sent = false;
        const terminal = { done: false, error: null };
        const timer = setTimeout(() => {
          ws.close();
          resolve({ errors, terminal, timedOut: true });
        }, 30000);
        const finish = () => {
          clearTimeout(timer);
          ws.close();
          resolve({ errors, terminal, timedOut: false });
        };
        ws.onmessage = (ev) => {
          if (!sent) return;
          const msg = JSON.parse(ev.data);
          if (msg.type === "error") {
            errors.push(msg.message);
            terminal.error = msg.message;
            finish();
          }
          if (msg.type === "done") {
            terminal.done = true;
            finish();
          }
        };
        ws.onopen = () => {
          ws.send(JSON.stringify({ type: "prompt", text: "session navigation guard probe" }));
          sent = true;
        };
      }),
  );
}

async function currentSessionId(page) {
  await expect
    .poll(() => page.evaluate(() => window.__chatStore?.getState().currentSessionId), {
      timeout: 5000,
    })
    .toBeTruthy();
  return page.evaluate(() => window.__chatStore.getState().currentSessionId);
}

async function deleteSessionIfPresent(page, id) {
  if (!id) return;
  const del = await page.request.delete(`/api/chat-history/sessions/${encodeURIComponent(id)}`);
  // status is a method on some Playwright versions, a property on others.
  const code = typeof del.status === "function" ? del.status() : del.status;
  // 409 = still current; the caller must move away first. Anything else is real.
  expect([200, 202, 404, 409]).toContain(code);
}

test.describe("session navigation while streaming", () => {
  test.beforeEach(async ({ page }) => {
    await gotoChat(page);
  });

  test("new chat stops the live turn instead of rejecting navigation", async ({ page }) => {
    // Isolate the probe in a fresh session so cleanup cannot delete a session
    // an earlier spec left populated.
    await page.getByTestId("new-chat-btn").click();
    const probeId = await currentSessionId(page);

    // Start the turn from the side socket, then navigate from the PAGE — the
    // navigation must not be rejected as busy, the turn must end, and the
    // navigating page must land in the new session.
    const probe = streamingProbe(page);
    await page.getByTestId("new-chat-btn").click();
    const outcome = await probe;

    expect(outcome.timedOut).toBe(false);
    expect(outcome.terminal.done).toBe(true);
    expect(outcome.errors.some((m) => /while the agent is responding/i.test(m))).toBe(false);
    // Killing the streaming turn restarts the dsh child (5-15s) BEFORE the
    // load events land — poll for the CHANGE, generously.
    const landed = await expect
      .poll(() => page.evaluate(() => window.__chatStore?.getState().currentSessionId), { timeout: 60_000 })
      .not.toBe(probeId);

    // Leave both probe sessions non-current, then remove them from the sidebar.
    await page.getByTestId("new-chat-btn").click();
    await currentSessionId(page);
    await deleteSessionIfPresent(page, landed);
    await deleteSessionIfPresent(page, probeId);
  });

  test("switching to another chat stops the live turn instead of rejecting it", async ({ page }) => {
    const targetId = await currentSessionId(page);
    await page.getByTestId("new-chat-btn").click();
    const probeId = await currentSessionId(page);

    // Start the turn from the side socket; the PAGE navigates back to the
    // target session via its own row click.
    const probe = streamingProbe(page);
    await page
      .locator(`[data-testid="session-row"][data-session-id="${targetId}"]`)
      .click();
    const outcome = await probe;

    expect(outcome.timedOut).toBe(false);
    expect(outcome.terminal.done).toBe(true);
    expect(outcome.errors.some((m) => /while the agent is responding/i.test(m))).toBe(false);
    await expect
      .poll(() => page.evaluate(() => window.__chatStore?.getState().currentSessionId), { timeout: 60_000 })
      .toBe(targetId);

    await page.getByTestId("new-chat-btn").click();
    await currentSessionId(page);
    await deleteSessionIfPresent(page, probeId);
  });
});
