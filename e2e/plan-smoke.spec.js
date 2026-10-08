import { test, expect } from "@playwright/test";
import { gotoChat, waitForIdle } from "./helpers.js";

// @smoke - the plan surfaces driven by a REAL model turn. Lives in the smoke
// project (excluded from `npm run test:e2e`, included in `npm run test:e2e:smoke`)
// because it makes one LLM call.
//
// The fast suite drives the store seam instead; this is the only test that
// proves the whole path — model calls `todo_write` → dsh emits `todo/write` →
// the server caches and broadcasts → the panel renders → the plan is restored
// from the server's cache on reload and on switching back.
//
// It doubles as the adoption check: if the model stops calling the tool, this
// test fails loudly rather than letting the panel quietly rot.

test.describe("Plan progress (live model)", () => {
  test("@smoke a real turn writes a plan that survives reload and session switches", async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000);
    await gotoChat(page);

    await waitForIdle(page, 30_000);
    await page
      .getByTestId("composer-input")
      .fill(
        "Use the todo_write tool to record exactly three tasks: (1) alpha, (2) beta, (3) gamma. " +
          "Do not use any other tool. Then reply with only the word: done",
      );
    await page.getByTestId("composer-send").click();

    // Assert the TURN first: without this, a live provider that never answers
    // reports as "no plan panel", which reads like a plan-pipeline bug.
    const turn = page.getByTestId("turn-assistant").last();
    await expect(turn).toBeVisible({ timeout: 30_000 });
    await expect(turn).toHaveAttribute("data-streaming", "false", { timeout: 90_000 });

    // The plan arrives as its own broadcast, independent of the reply text.
    const panel = page.getByTestId("plan-panel");
    await expect(panel).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("plan-item")).toHaveCount(3);
    await expect(page.getByTestId("plan-count")).toHaveText("0/3");
    await expect(panel).toContainText("alpha");

    // The transcript carries the compact summary line, not raw JSON. The
    // tool blocks live inside the activity group; expand them first.
    await page.evaluate(() => window.__chatStore.getState().toggleAllGroups());
    const planBlock = page.locator('[data-testid="tool-block"][data-tool-name="todo_write"]');
    await expect(planBlock).toContainText("Updated the plan (0/3)");

    await waitForIdle(page, 60_000);

    // The live session id, so the reload deep-links back into this session.
    const list = await (await request.get("/api/chat-history/sessions")).json();
    const sessionId = list.current;
    expect(sessionId).toBeTruthy();

    // Reload: the transcript and the plan both come back — the plan from the
    // server's per-session cache (no model call happens here).
    await page.goto(`/chat/${sessionId}`);
    await expect(page.getByTestId("plan-panel")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("plan-count")).toHaveText("0/3");
    await expect(page.getByTestId("plan-list")).toContainText("gamma");

    // A new chat clears it…
    await page.getByTestId("new-chat-btn").click();
    await expect(page.getByTestId("plan-panel")).toHaveCount(0);

    // …and switching back restores it.
    await page.goto(`/chat/${sessionId}`);
    await expect(page.getByTestId("plan-panel")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("plan-item")).toHaveCount(3);
  });
});
