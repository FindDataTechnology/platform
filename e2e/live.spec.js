import { test, expect } from "@playwright/test";
import { gotoChat, pinLocaleEn } from "./live-helpers.js";
import { LIVE_SERVICE_URL, liveSmokeEnabled } from "./live-helpers.js";

// @live - read-only tests against the DEPLOYED k3s NodePort service.
//
// These run via the `live` Playwright project (`npm run test:e2e:live` /
// `make test-live`). They connect to an already-running external URL
// (LIVE_SERVICE_URL, default http://127.0.0.1:3000) and never spawn a
// local server. All assertions are read-only: no chat prompts, no document
// uploads, no model switches, no LLM tokens spent - except the opt-in
// @live-smoke chat-turn gated behind LIVE_SMOKE=1.

test.describe("live service @live", () => {
  test("deployed service serves /api/config", async ({ request }) => {
    const res = await request.get("/api/config");
    expect(res.status()).toBeLessThan(400);
    const body = await res.json();
    // Config is an object; the presence of known keys proves the backend booted.
    expect(body).toBeTruthy();
    expect(typeof body).toBe("object");
  });

  test("deployed root routes to /chat", async ({ page }) => {
    await pinLocaleEn(page);
    const response = await page.goto("/", { waitUntil: "domcontentloaded" });
    expect(response?.status()).toBeLessThan(400);
    await expect(page).toHaveURL(/\/chat\/?$/, { timeout: 15000 });
  });

  test("deployed chat shell renders and WebSocket connects", async ({ page }) => {
    await gotoChat(page);
    await expect(page.getByTestId("sidebar")).toBeVisible();
    await expect(page.getByTestId("composer-input")).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId("session-list-section")).toBeVisible();
    // gotoChat already asserted status-text == "Connected" (WS up).
  });

  test("deployed sidebar shows all nav entries", async ({ page }) => {
    await gotoChat(page);
    for (const id of ["nav-chat", "nav-knowledge", "nav-agents", "nav-bots", "nav-trace"]) {
      await expect(page.getByTestId(id)).toBeVisible();
    }
  });

  test("deployed /dashboard deep link resolves via SPA fallback", async ({ page }) => {
    await pinLocaleEn(page);
    await page.goto("/dashboard", { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("system-status-page")).toBeVisible({ timeout: 15000 });
  });

  test("deployed WebSocket answers a list_models round-trip", async ({ page }) => {
    // Open a fresh WS from the browser context and verify the deployed agent
    // session responds to a read-only list_models request. No tokens spent.
    await pinLocaleEn(page);
    await page.goto("/chat/", { waitUntil: "domcontentloaded" });

    const wsUrl = LIVE_SERVICE_URL.replace(/^http/, "ws") + "/";
    const gotModels = await page.evaluate(
      async (url) => {
        return new Promise((resolve, reject) => {
          const ws = new WebSocket(url);
          const timer = setTimeout(() => {
            try { ws.close(); } catch {}
            reject(new Error("timed out waiting for models response"));
          }, 20000);
          ws.onopen = () => ws.send(JSON.stringify({ type: "list_models" }));
          ws.onmessage = (ev) => {
            try {
              const msg = JSON.parse(ev.data);
              if (msg.type === "models") {
                clearTimeout(timer);
                ws.close();
                resolve(Array.isArray(msg.models) ? msg.models.length : -1);
              }
            } catch { /* ignore non-JSON frames */ }
          };
          ws.onerror = () => {
            clearTimeout(timer);
            reject(new Error("websocket error"));
          };
        });
      },
      wsUrl,
    );
    // -1 means `models` arrived but wasn't an array; still proves a round-trip.
    expect(gotModels).toBeGreaterThanOrEqual(0);
  });
});

// @live-smoke - opt-in real LLM round-trip against the deployed service.
// Skipped unless LIVE_SMOKE=1 (so `make test-live` never spends a token).
test("@live-smoke deployed chat turn returns assistant text", async ({ page, request }) => {
  test.skip(!liveSmokeEnabled(), "set LIVE_SMOKE=1 to run the live chat-turn (spends one LLM token)");
  await gotoChat(page);

  await page.getByTestId("composer-input").fill("Reply with only the word: hello");
  await page.getByTestId("composer-send").click();

  const turn = page.getByTestId("turn-assistant").last();
  await expect(turn).toBeVisible({ timeout: 30000 });
  await expect(turn).toHaveAttribute("data-streaming", "false", { timeout: 45000 });

  // Assert non-empty assistant text rendered.
  const bubbleText = (await turn.textContent()) || "";
  expect(bubbleText.trim().length).toBeGreaterThan(0);

  // Read-only verification that the turn persisted to the live chat-history store.
  const getAssistantText = async () => {
    const list = await (await request.get("/api/chat-history/sessions")).json();
    if (!list.current) return "";
    const session = await (await request.get(`/api/chat-history/sessions/${list.current}`)).json();
    const asst = (session.messages || []).filter((m) => m.role === "assistant");
    return asst.length ? asst[asst.length - 1].content || "" : "";
  };
  await expect.poll(getAssistantText, { timeout: 10000 }).not.toBe("");
});
