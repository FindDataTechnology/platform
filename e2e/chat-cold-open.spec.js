import { test, expect } from "@playwright/test";
import { pinLocaleEn } from "./helpers.js";

// Regression coverage for fix-cold-open-stuck-skeleton (openspec change of the
// same name, tasks 3.1–3.4).
//
// The lived bug: a `sessions` list broadcast landing BETWEEN a switch and its
// `session_loaded` rewrote the view's currentSessionId (the frame's `current`
// names the deployment's live session, not this client's), so the switch's own
// load failed the stale-load guard — cache-only — and pendingSession was never
// cleared: a skeleton that never resolves.
//
// These drive the real frame order over a real socket. routeWebSocket lets the
// real server answer everything else, and each test injects only the frames
// the bug needs, so the timing is deterministic (the live repro needs an active
// cron round, which is exactly why it only showed up on some cold opens).
//
// The store seam (window.__chatStore) exists in the e2e build
// (VITE_E2E_SEAM=1); assertions read it directly so they describe store state,
// not incidental DOM.

const SID = "deep-link-target-1";

// Pass-through every WS frame; keep the client socket so a test can push frames
// the real server would not have sent at that moment.
async function tapSocket(page) {
  let client = null;
  await page.routeWebSocket(/.*/, (ws) => {
    client = ws;
    const server = ws.connectToServer();
    ws.onMessage((d) => server.send(d));
    server.onMessage((d) => ws.send(d));
  });
  return { send: (msg) => client?.send(JSON.stringify(msg)), ready: () => client !== null };
}

const store = (page) =>
  page.evaluate(() => {
    const s = window.__chatStore?.getState?.();
    if (!s) return null;
    return {
      currentSessionId: s.currentSessionId,
      pendingSession: s.pendingSession,
      pendingNewSession: s.pendingNewSession,
      turns: s.turns.length,
      status: s.status,
    };
  });

async function waitConnected(page) {
  await expect(page.getByTestId("status-text")).toHaveText("Connected", { timeout: 15000 });
  await expect.poll(async () => (await store(page)) !== null).toBe(true);
}

test.beforeEach(async ({ page }) => {
  await pinLocaleEn(page);
});

test("a sessions broadcast between switch and load does not strand the skeleton", async ({ page }) => {
  const sock = await tapSocket(page);
  await page.goto(`/chat/${SID}`);
  await waitConnected(page);

  // A deep link no longer ARMS an optimistic switch by itself: since
  // `add-session-ownership` the client sends switch_session and waits for the
  // server's `session_loaded` (the id has to pass accessSession() first, so a
  // literal id could not even be assumed to exist). The store method that DOES
  // arm one is activateSession — the click-a-sidebar-row path — and that is
  // exactly the state this test is about (`scripts/test-chat-store-cold-open.mjs`
  // drives it the same way). Arm it explicitly instead of inferring it from the
  // URL.
  // Let the deep link's own load land first: arming on top of an in-flight
    // load makes the two loads race, and the test would occasionally see the
    // deep link's resolve clear OUR arm instead of its own.
    await expect.poll(async () => (await store(page))?.pendingSession, { timeout: 15000 }).toBe(null);
    await page.evaluate((id) => window.__chatStore.getState().activateSession(id), SID);
  await expect.poll(async () => (await store(page))?.pendingSession, { timeout: 10000 }).toBe(SID);
  sock.send({ type: "sessions", sessions: [{ id: SID, title: "target" }, { id: "live-session-x", title: "x" }], current: "live-session-x" });

  const after = await store(page);
  expect(after.currentSessionId, "the settling view is not stolen").toBe(SID);
  expect(after.pendingSession, "the switch stays armed").toBe(SID);

  // The resolving frame is the server's `session_loaded` for this id. The arm
  // above was a direct store call (no switch_session went out), so push that
  // frame ourselves — the point under test is that it RESOLVES, not who sent it.
  sock.send({ type: "session_loaded", id: SID, title: "target", messages: [] });
  await expect.poll(async () => (await store(page))?.pendingSession, { timeout: 15000 }).toBe(null);
  await expect(page.getByTestId("session-pending-skeleton")).toHaveCount(0);
});

test("an unrelated session_loaded cannot outrank the switch target", async ({ page }) => {
  const sock = await tapSocket(page);
  await page.goto(`/chat/${SID}`);
  await waitConnected(page);
  // Let the deep link's own load land first: arming on top of an in-flight
    // load makes the two loads race, and the test would occasionally see the
    // deep link's resolve clear OUR arm instead of its own.
    await expect.poll(async () => (await store(page))?.pendingSession, { timeout: 15000 }).toBe(null);
    await page.evaluate((id) => window.__chatStore.getState().activateSession(id), SID);
  await expect.poll(async () => (await store(page))?.pendingSession, { timeout: 10000 }).toBe(SID);

  // A stray load for another session arrives first.
  sock.send({ type: "session_loaded", id: "some-other-session", title: "z", messages: [] });
  const mid = await store(page);
  expect(mid.currentSessionId, "Z does not replace the view").toBe(SID);
  expect(mid.pendingSession, "the switch is still armed").toBe(SID);

  // ...and the real target's load is what resolves it (the stray above must
  // have changed nothing, which is why it is still armed here).
  sock.send({ type: "session_loaded", id: SID, title: "target", messages: [] });
  await expect.poll(async () => (await store(page))?.pendingSession, { timeout: 15000 }).toBe(null);
  expect((await store(page)).currentSessionId).toBe(SID);
});

test("with no switch settling, a sessions broadcast still updates the view", async ({ page }) => {
  const sock = await tapSocket(page);
  await page.goto(`/chat/${SID}`);
  await waitConnected(page);
  await expect.poll(async () => (await store(page))?.pendingSession, { timeout: 15000 }).toBe(null);

  // Another device switched the deployment's session — this client follows.
  sock.send({ type: "sessions", sessions: [{ id: SID, title: "target" }, { id: "other-device-session", title: "o" }], current: "other-device-session" });
  await expect.poll(async () => (await store(page))?.currentSessionId, { timeout: 5000 }).toBe("other-device-session");
});

test("new session: a sessions broadcast mid-handshake does not steal the arrival", async ({ page }) => {
  const sock = await tapSocket(page);
  await page.goto("/chat");
  await waitConnected(page);
  await expect.poll(async () => (await store(page))?.status, { timeout: 15000 }).toBe("connected");

  // Start a fresh chat; the handshake is armed until the load arrives.
  await page.evaluate(() => window.__chatStore.getState().beginNewSession());
  await expect.poll(async () => (await store(page))?.pendingNewSession).toBe(true);

  sock.send({ type: "sessions", sessions: [{ id: "live-session-x", title: "x" }], current: "live-session-x" });
  expect((await store(page)).pendingNewSession, "the new-session handshake survives").toBe(true);
});
