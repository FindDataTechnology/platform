import { test, expect } from "@playwright/test";
import { gotoChat } from "./helpers.js";

async function createSession(request) {
  const response = await request.post("/api/chat-history/sessions");
  expect(response.ok()).toBeTruthy();
  const body = await response.json();
  expect(body.id).toBeTruthy();

  await expect.poll(async () => {
    const listResponse = await request.get("/api/chat-history/sessions");
    if (!listResponse.ok()) return false;
    const { sessions } = await listResponse.json();
    return sessions.some((session) => session.id === body.id && session.messageCount === 0);
  }).toBe(true);

  return body.id;
}

function sessionRow(page, id) {
  return page.locator(`[data-testid="session-row"][data-session-id="${id}"]`);
}

function currentRow(page) {
  return page.locator('[data-testid="session-row"][data-current="true"]').first();
}

// Session row right-click → ChatSessionMenu (Delete) → confirmation dialog →
// DELETE /api/chat-history/sessions/:id. Covers:
//   - happy path: row is removed after confirm
//   - active session: Delete is disabled with a tooltip
//   - API: 404 on missing id, 409 on current id (covered by the UI; the
//     409 case is what disables the menu entry)
test.describe("session right-click delete", () => {
  test("deletes a non-active session", async ({ page, request }) => {
    await gotoChat(page);
    const firstId = await createSession(request);
    const inactiveId = await createSession(request);
    await expect(sessionRow(page, firstId)).toBeVisible({ timeout: 5000 });
    await expect(sessionRow(page, inactiveId)).toBeVisible({ timeout: 5000 });

    // Switch via the page's own row click: under per-viewer delivery
    // (add-session-ownership) a switch flips the connection that navigated —
    // a side socket switching no longer rewrites this page's view.
    await sessionRow(page, firstId).click();
    await expect(currentRow(page)).toHaveAttribute("data-session-id", firstId);

    await currentRow(page).click({ button: "right" });
    await expect(page.getByTestId("session-menu-delete")).toBeDisabled();
    await page.keyboard.press("Escape");

    await sessionRow(page, inactiveId).click({ button: "right" });
    await expect(page.getByTestId("session-menu-delete")).toBeEnabled();
    await page.getByTestId("session-menu-delete").click();
    await expect(page.getByTestId("session-delete-dialog")).toBeVisible();
    await page.getByTestId("session-delete-confirm").click();
    await expect(sessionRow(page, inactiveId)).toHaveCount(0);
  });

  test("DELETE endpoint returns 404 for missing id", async ({ request }) => {
    const r = await request.delete("/api/chat-history/sessions/no-such-id-12345");
    expect(r.status()).toBe(404);
  });

  test("DELETE endpoint returns 409 for the current session", async ({ page, request }) => {
    await gotoChat(page);
    const currentId = await currentRow(page).getAttribute("data-session-id");
    expect(currentId).toBeTruthy();
    const r = await request.delete(`/api/chat-history/sessions/${currentId}`);
    expect(r.status()).toBe(409);
  });
});

// Clear lives in the same menu as Delete now (it was a standing sidebar
// button). It clears the DISPLAYED turns, and the store's clearView takes no
// session id — so it is only meaningful for the active session and is disabled
// elsewhere. Without that guard, clearing an inactive row would silently wipe
// the active conversation's view.
test.describe("session menu — clear", () => {
  test("enabled on the active session, disabled on any other", async ({ page, request }) => {
    await gotoChat(page);
    const firstId = await createSession(request);
    const inactiveId = await createSession(request);
    await expect(sessionRow(page, firstId)).toBeVisible({ timeout: 5000 });
    await expect(sessionRow(page, inactiveId)).toBeVisible({ timeout: 5000 });

    // Switch via the page's own row click (per-viewer delivery — see above).
    await sessionRow(page, firstId).click();
    await expect(currentRow(page)).toHaveAttribute("data-session-id", firstId);

    await currentRow(page).click({ button: "right" });
    await expect(page.getByTestId("session-menu-clear")).toBeEnabled();
    await page.keyboard.press("Escape");

    await sessionRow(page, inactiveId).click({ button: "right" });
    await expect(page.getByTestId("session-menu-clear")).toBeDisabled();
  });

  test("clearing the active session empties the log", async ({ page }) => {
    await gotoChat(page);
    await page.evaluate(() => {
      window.__chatStore.setState({
        turns: [{ id: "t1", role: "user", text: "hello", blocks: [] }],
      });
    });
    await expect
      .poll(() => page.evaluate(() => window.__chatStore.getState().turns.length))
      .toBe(1);

    await currentRow(page).click({ button: "right" });
    await page.getByTestId("session-menu-clear").click();

    await expect
      .poll(() => page.evaluate(() => window.__chatStore.getState().turns.length))
      .toBe(0);
  });
});
