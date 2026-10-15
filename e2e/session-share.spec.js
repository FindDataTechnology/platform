import { test, expect } from "@playwright/test";
import { gotoChat } from "./helpers.js";

// Session sharing UI (add-session-share). The local e2e server is a bare
// server.js cell — the share endpoints live on the GATEWAY, which this harness
// does not boot. So these tests stub /api/share* at the network layer and
// assert the WEB UI's behavior (menu items, copied feedback, manage dialog,
// the public /share page states). The gateway's token/read/revoke/rate-limit
// behavior is integration-tested against the real gateway in
// scripts/test-session-share.mjs.

const SESSION = {
  title: "Shared session",
  messages: [
    { role: "user", content: "hello from the owner" },
    { role: "assistant", content: "hi there" },
  ],
};

async function stubShareApi(page) {
  const created = [];
  let revoked = [];
  await page.route("**/api/share**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (req.method() === "POST" && url.pathname === "/api/share") {
      const body = req.postDataJSON();
      created.push(body);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ token: "tok-1", url: "/share/tok-1" }),
      });
      return;
    }
    if (req.method() === "GET" && url.pathname === "/api/share") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          shares: [
            { token: "tok-1", sessionId: "s1", title: "Shared session", createdAt: Date.now() },
            ...(created.length > 1
              ? [{ token: "tok-2", sessionId: "s2", title: "Second", createdAt: Date.now() }]
              : []),
          ].filter((s) => !revoked.includes(s.token)),
        }),
      });
      return;
    }
    if (req.method() === "DELETE") {
      const token = url.pathname.split("/").pop();
      revoked.push(token);
      await route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' });
      return;
    }
    await route.fulfill({ status: 405, contentType: "application/json", body: "{}" });
  });
  return { created, revokedRef: () => revoked };
}

// Stub the PUBLIC read separately: it must work with no session at all.
async function stubPublicRead(page, body, status = 200) {
  await page.route("**/api/share/tok-*", (route) =>
    route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) }),
  );
}

async function enterSessionState(page) {
  // The header (and its overflow menu) render only once the transcript has
  // turns; make one via the store seam — no LLM involved.
  await page.evaluate(() => {
    const s = window.__chatStore.getState();
    s.apply({ type: "user", text: "share me" });
    s.apply({ type: "agent_start" });
    s.apply({ type: "text", delta: "a modest answer" });
    s.apply({ type: "done" });
  });
  await expect(page.getByTestId("chat-header-overflow")).toBeVisible();
}

test.describe("session share", () => {
  test.beforeEach(async ({ page }) => {
    // Clipboard is a browser permission; replace it with a recorder instead.
    await page.addInitScript(() => {
      window.__copied = [];
      Object.defineProperty(navigator, "clipboard", {
        value: {
          writeText: (t) => {
            window.__copied.push(t);
            return Promise.resolve();
          },
        },
      });
    });
    await gotoChat(page);
    await enterSessionState(page);
  });

  test("share menu item creates a share and copies the public URL", async ({ page }) => {
    const stubs = await stubShareApi(page);
    await page.getByTestId("chat-header-overflow").click();
    await page.getByTestId("session-menu-share").click();

    await expect(page.getByTestId("session-menu-share-note")).toContainText("Link copied");
    const copied = await page.evaluate(() => window.__copied);
    expect(copied[0]).toBe(`${new URL(page.url()).origin}/share/tok-1`);
    expect(stubs.created).toEqual([{ sessionId: expect.any(String) }]);
  });

  test("manage dialog lists shares and revocation removes the row", async ({ page }) => {
    const stubs = await stubShareApi(page);
    await page.getByTestId("chat-header-overflow").click();
    await page.getByTestId("session-menu-manage-shares").click();

    const list = page.getByTestId("share-manage-list");
    await expect(list).toContainText("Shared session");
    await list.getByTestId("share-revoke-btn").first().click();
    await expect(list.getByTestId("share-revoke-btn")).toHaveCount(0);
    expect(stubs.revokedRef()).toEqual(["tok-1"]);
  });

  test("public /share page renders a valid token logged-out-style (no login redirect)", async ({ page }) => {
    await stubPublicRead(page, SESSION);
    await page.goto("/share/tok-1");
    await expect(page.getByTestId("share-page")).toBeVisible();
    await expect(page.getByTestId("share-title")).toHaveText("Shared session");
    await expect(page.getByTestId("share-page")).toContainText("hello from the owner");
    await expect(page.getByTestId("share-page")).toContainText("hi there");
  });

  test("public /share page shows the not-available state for a dead token", async ({ page }) => {
    await stubPublicRead(page, { error: "Share not available" }, 404);
    await page.goto("/share/tok-dead");
    await expect(page.getByTestId("share-page")).toContainText("no longer available");
  });
});
