import { test, expect } from "@playwright/test";
import { startSlowServer, waitForRuntimeIdle } from "./slow-server.js";

// Session navigation while a turn is live (concurrent-chat-sessions).
//
// The OLD contract — asserted by this spec until the change — was "navigating
// stops the live turn". It is gone: a switch, a new chat, or another
// connection's navigation must leave every in-flight turn running.
//
// The spec owns a server with a deliberately slow model (e2e/slow-server.js):
// the shared e2e webServer's LLM endpoint is unreachable, so its turns close
// instantly and a running turn is never observable.

const MODEL_DELAY_MS = 8000;

let h;
let base;

test.beforeAll(async () => {
  h = await startSlowServer({ delayMs: MODEL_DELAY_MS });
  base = h.base;
});

test.afterAll(async () => {
  if (h) await h.stop();
});

test.describe.configure({ mode: "serial", timeout: 180_000 });

// Open a raw WS, send a probe prompt, and resolve on the turn's terminal event.
function streamingProbe(page, text, targetSessionId) {
  return page.evaluate(
    ({ promptText, sid }) =>
      new Promise((resolve) => {
        const ws = new WebSocket(window.location.origin.replace(/^http/, "ws") + "/");
        const errors = [];
        let sent = false;
        let switched = !sid;
        const terminal = { done: false, error: null, sawAgentStart: false, sessionId: null, text: false };
        const timer = setTimeout(() => {
          ws.close();
          resolve({ errors, terminal, timedOut: true });
        }, 90_000);
        const finish = () => {
          clearTimeout(timer);
          ws.close();
          resolve({ errors, terminal, timedOut: false });
        };
        ws.onopen = () => {
          if (sid) ws.send(JSON.stringify({ type: "switch_session", id: sid }));
        };
        ws.onmessage = (ev) => {
          const msg = JSON.parse(ev.data);
          // A fresh socket is auto-adopted into the deployment's live session;
          // point it at the session under test and WAIT for that load before
          // prompting, or the turn runs somewhere the page is not watching.
          if (sid && !switched && msg.type === "session_loaded" && msg.id === sid) {
            switched = true;
            ws.send(JSON.stringify({ type: "prompt", text: promptText }));
            sent = true;
            return;
          }
          if (!sent) return;
          if (typeof msg.sessionId === "string" && msg.type !== "sessions") terminal.sessionId = msg.sessionId;
          if (msg.type === "agent_start") terminal.sawAgentStart = true;
          if (msg.type === "text") terminal.text = true;
          if (msg.type === "error") {
            errors.push(msg.message);
            terminal.error = msg.message;
          }
          if (msg.type === "done") {
            terminal.done = true;
            finish();
          }
        };
      }),
    { promptText: text, sid: targetSessionId ?? null },
  );
}

async function currentSessionId(page) {
  await expect
    .poll(() => page.evaluate(() => window.__chatStore?.getState().currentSessionId), { timeout: 15_000 })
    .toBeTruthy();
  return page.evaluate(() => window.__chatStore.getState().currentSessionId);
}

// The sidebar row's server-computed status — visible proof of a turn running in
// a session the page is NOT viewing.
async function turnStatusOf(page, id) {
  return page.evaluate(
    (sid) => window.__chatStore?.getState().sessions.find((s) => s.id === sid)?.turnStatus ?? null,
    id,
  );
}

async function deleteSessionIfPresent(page, id) {
  if (!id) return;
  const del = await page.request.delete(`/api/chat-history/sessions/${encodeURIComponent(id)}`);
  const code = typeof del.status === "function" ? del.status() : del.status;
  expect([200, 202, 404, 409]).toContain(code);
}

test.beforeEach(async ({ page }) => {
  await waitForRuntimeIdle(base);
  await page.goto(`${base}/chat`);
  await page.waitForFunction(() => window.__chatStore?.getState()?.status === "connected", null, {
    timeout: 60_000,
  });
});

test("new chat leaves the live turn running", async ({ page }) => {
  await page.getByTestId("new-chat-btn").click();
  const probeId = await currentSessionId(page);

  const probe = streamingProbe(page, "keep running while I open a new chat", probeId);
  await expect.poll(() => turnStatusOf(page, probeId), { timeout: 40_000 }).toBe("running");

  await page.getByTestId("new-chat-btn").click();
  // The new session's id is minted server-side, so the view only changes when
  // its load lands. Poll for the CHANGE rather than reading once.
  await expect
    .poll(() => page.evaluate(() => window.__chatStore?.getState().currentSessionId), { timeout: 30_000 })
    .not.toBe(probeId);
  const afterNav = await currentSessionId(page);
  // The outgoing session keeps its indicator: the hub did not stop it.
  expect(await turnStatusOf(page, probeId)).toBe("running");

  const outcome = await probe;
  expect(outcome.timedOut).toBe(false);
  expect(outcome.terminal.sawAgentStart).toBe(true);
  expect(outcome.terminal.done).toBe(true);
  expect(outcome.errors.some((m) => /still responding|still the agent is responding/i.test(m))).toBe(false);
  expect(await currentSessionId(page)).toBe(afterNav);

  await deleteSessionIfPresent(page, probeId);
});

test("switching to another chat leaves the live turn running", async ({ page }) => {
  const targetId = await currentSessionId(page);
  await page.getByTestId("new-chat-btn").click();
  const probeId = await currentSessionId(page);

  const probe = streamingProbe(page, "keep running while I switch away", probeId);
  await expect.poll(() => turnStatusOf(page, probeId), { timeout: 40_000 }).toBe("running");

  await page.locator(`[data-testid="session-row"][data-session-id="${targetId}"]`).click();
  await expect
    .poll(() => page.evaluate(() => window.__chatStore?.getState().currentSessionId), { timeout: 20_000 })
    .toBe(targetId);
  expect(await turnStatusOf(page, probeId)).toBe("running");

  const outcome = await probe;
  expect(outcome.timedOut).toBe(false);
  expect(outcome.terminal.done).toBe(true);
  expect(outcome.errors.some((m) => /still responding/i.test(m))).toBe(false);

  await page.getByTestId("new-chat-btn").click();
  await currentSessionId(page);
  await deleteSessionIfPresent(page, probeId);
});

test("switching back to a running session rejoins its live turn", async ({ page }) => {
  await page.getByTestId("new-chat-btn").click();
  const probeId = await currentSessionId(page);

  const probe = streamingProbe(page, "rejoin me after I leave", probeId);
  await expect.poll(() => turnStatusOf(page, probeId), { timeout: 40_000 }).toBe("running");

  await page.getByTestId("new-chat-btn").click();
  await currentSessionId(page);
  await page.locator(`[data-testid="session-row"][data-session-id="${probeId}"]`).click();

  // The load reports the turn as running (reconnect-resync contract) rather
  // than a paused/aborted transcript.
  await expect
    .poll(() => page.evaluate(() => window.__chatStore?.getState().isStreaming), { timeout: 30_000 })
    .toBe(true);

  const outcome = await probe;
  expect(outcome.terminal.done).toBe(true);

  await deleteSessionIfPresent(page, probeId);
});
