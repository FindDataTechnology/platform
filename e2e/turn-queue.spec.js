import { test, expect } from "@playwright/test";
import { startSlowServer, waitForRuntimeIdle } from "./slow-server.js";

// Turn queue (concurrent-chat-sessions): a prompt submitted while another
// session's turn is live is ACCEPTED and queued — never rejected as "still
// responding", never dispatched alongside, and dispatched automatically when
// the running turn closes.
//
// This spec owns a server with a deliberately slow model
// (e2e/slow-server.js): the shared e2e webServer's LLM endpoint is unreachable,
// so its turns close instantly and a queue is never observable.

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

// Each test drives at least two full slow turns plus the hub's dispatch
// handoff, so the default 60s is too tight.
test.describe.configure({ mode: "serial", timeout: 180_000 });

test.beforeEach(async ({ page }) => {
  await waitForRuntimeIdle(base);
  await page.goto(`${base}/chat`);
  await page.waitForFunction(() => window.__chatStore?.getState()?.status === "connected", null, {
    timeout: 60_000,
  });
});

// Raw-WS probes: the queue is a hub-level behavior, so the probe speaks the
// protocol directly — it holds one session's turn open, submits into another,
// and records the exact event stream (queued → dequeued → user → agent_start →
// done) the UI renders from.

test("a prompt for another session is queued, not rejected", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const url = window.location.origin.replace(/^http/, "ws") + "/";
    const open = () =>
      new Promise((resolve) => {
        const ws = new WebSocket(url);
        const events = [];
        ws.onmessage = (ev) => events.push(JSON.parse(ev.data));
        ws.onopen = () => resolve({ ws, events });
      });
    const waitFor = (events, type, timeout = 60_000) =>
      new Promise((resolve, reject) => {
        const t0 = Date.now();
        const tick = () => {
          const hit = events.find((e) => e.type === type);
          if (hit) return resolve(hit);
          if (Date.now() - t0 > timeout) return reject(new Error(`no ${type} within ${timeout}ms`));
          setTimeout(tick, 100);
        };
        tick();
      });

    // A: a prompt whose answer the gateway holds.
    const a = await open();
    a.ws.send(JSON.stringify({ type: "prompt", text: "A: hold the runtime" }));
    await waitFor(a.events, "agent_start", 40_000);
    const sidA = a.events.find((e) => e.type === "agent_start")?.sessionId ?? null;

    // B on its OWN socket: a fresh session, then a prompt.
    const b = await open();
    b.ws.send(JSON.stringify({ type: "new_session" }));
    const loaded = await waitFor(b.events, "session_loaded", 40_000);
    b.ws.send(JSON.stringify({ type: "prompt", text: "B: queued behind A" }));
    const queued = await Promise.race([
      waitFor(b.events, "queued", 20_000),
      waitFor(b.events, "error", 20_000).then((e) => {
        throw new Error(`prompt was rejected instead of queued: ${e.message}`);
      }),
    ]);
    const out = {
      sidA,
      sidB: loaded.id,
      queued: { text: queued.text, position: queued.position, waitingOn: queued.waitingOn },
    };
    a.ws.close();
    b.ws.close();
    return out;
  });

  expect(result.queued.text).toBe("B: queued behind A");
  expect(result.queued.position).toBe(1);
  // A is the web session whose turn is open — the bubble names it.
  expect(result.queued.waitingOn?.id).toBe(result.sidA);
});

test("the queued prompt dispatches on its own when the running turn closes", async ({ page }) => {
  const out = await page.evaluate(async () => {
    const url = window.location.origin.replace(/^http/, "ws") + "/";
    const open = () =>
      new Promise((resolve) => {
        const ws = new WebSocket(url);
        const events = [];
        ws.onmessage = (ev) => events.push(JSON.parse(ev.data));
        ws.onopen = () => resolve({ ws, events });
      });
    const waitFor = (events, type, timeout = 90_000) =>
      new Promise((resolve, reject) => {
        const t0 = Date.now();
        const tick = () => {
          const hit = events.find((e) => e.type === type);
          if (hit) return resolve(hit);
          if (Date.now() - t0 > timeout) return reject(new Error(`no ${type}`));
          setTimeout(tick, 100);
        };
        tick();
      });

    const a = await open();
    a.ws.send(JSON.stringify({ type: "prompt", text: "A closes eventually" }));
    await waitFor(a.events, "agent_start", 40_000);

    const b = await open();
    b.ws.send(JSON.stringify({ type: "new_session" }));
    const loaded = await waitFor(b.events, "session_loaded", 40_000);
    b.ws.send(JSON.stringify({ type: "prompt", text: "B waits then runs" }));
    await waitFor(b.events, "queued", 20_000);

    // No client action from here: the server must advance the queue.
    const dequeued = await waitFor(b.events, "dequeued", 90_000);
    const started = await waitFor(b.events, "agent_start", 90_000);
    await waitFor(b.events, "done", 90_000);
    const result = { reason: dequeued.reason, startedSession: started.sessionId, sidB: loaded.id };
    a.ws.close();
    b.ws.close();
    return result;
  });

  expect(out.reason).toBe("dispatched");
  expect(out.startedSession).toBe(out.sidB);
});

test("cancelling a queued prompt leaves no history row", async ({ page, request }) => {
  const out = await page.evaluate(async () => {
    const url = window.location.origin.replace(/^http/, "ws") + "/";
    const open = () =>
      new Promise((resolve) => {
        const ws = new WebSocket(url);
        const events = [];
        ws.onmessage = (ev) => events.push(JSON.parse(ev.data));
        ws.onopen = () => resolve({ ws, events });
      });
    const waitFor = (events, type, timeout = 60_000) =>
      new Promise((resolve, reject) => {
        const t0 = Date.now();
        const tick = () => {
          const hit = events.find((e) => e.type === type);
          if (hit) return resolve(hit);
          if (Date.now() - t0 > timeout) return reject(new Error(`no ${type}`));
          setTimeout(tick, 100);
        };
        tick();
      });

    const a = await open();
    a.ws.send(JSON.stringify({ type: "prompt", text: "A holds again" }));
    await waitFor(a.events, "agent_start", 40_000);

    const b = await open();
    b.ws.send(JSON.stringify({ type: "new_session" }));
    const loaded = await waitFor(b.events, "session_loaded", 40_000);
    b.ws.send(JSON.stringify({ type: "prompt", text: "CANCEL-ME this must never run" }));
    await waitFor(b.events, "queued", 20_000);

    b.ws.send(JSON.stringify({ type: "stop_turn", id: loaded.id }));
    const dequeued = await waitFor(b.events, "dequeued", 20_000);

    // Give the hub a beat to (incorrectly) dispatch it, then read history.
    await new Promise((r) => setTimeout(r, 1500));
    const startedAfterCancel = b.events.some((e) => e.type === "agent_start");
    const result = { reason: dequeued.reason, sidB: loaded.id, startedAfterCancel };
    a.ws.close();
    b.ws.close();
    return result;
  });

  expect(out.reason).toBe("cancelled");
  expect(out.startedAfterCancel).toBe(false);

  const res = await request.get(`${base}/api/chat-history/sessions/${encodeURIComponent(out.sidB)}`);
  const body = await res.json();
  const texts = (body.messages ?? []).map((m) => m.content).join("\n");
  expect(texts).not.toContain("CANCEL-ME");
});
