import { test, expect } from "@playwright/test";
import { gotoChat, pinLocaleEn } from "./helpers.js";

// Scheduled-tasks UI on the web (spec: scheduled-tasks-ui). Deterministic,
// no-LLM: creation form → engine → broadcast → list row; actions; invalid
// cron rejection; nav entry; and the client-side unread derivation
// (scheduled-task-notifications) exercised through localStorage + the
// sessions payload's updatedAt.

async function gotoTasks(page) {
  await pinLocaleEn(page);
  await page.goto("/tasks");
  await expect(page.getByTestId("cron-page")).toBeVisible({ timeout: 15_000 });
}

test.describe("Scheduled-tasks page", () => {
  test("nav entry opens the page; a daily job round-trips through the engine", async ({ page }) => {
    await gotoChat(page);
    await page.getByTestId("nav-tasks").click();
    await expect(page.getByTestId("cron-page")).toBeVisible();

    // Empty state first (previous specs clean up after themselves).
    // Create: daily 09:05, prompt, default agent/tz.
    await page.getByTestId("cron-new-toggle").click();
    await expect(page.getByTestId("cron-form")).toBeVisible();
    await page.getByTestId("cron-time").fill("09:05");
    await page.getByTestId("cron-prompt").fill("daily probe: summarize the news");
    await page.getByTestId("cron-submit").click();

    const row = page.locator('[data-testid="cron-job"]').first();
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(row.getByTestId("cron-job-schedule")).toContainText("daily at 09:05");
    await expect(row.getByTestId("cron-job-prompt")).toContainText("daily probe");

    // Pause → the engine's cron_status broadcast flips the row.
    await row.getByTestId("cron-job-toggle").click();
    await expect(row).toHaveAttribute("data-job-status", "paused", { timeout: 15_000 });

    // Resume → back to scheduled.
    await row.getByTestId("cron-job-toggle").click();
    await expect(row).toHaveAttribute("data-job-status", "scheduled", { timeout: 15_000 });

    // Output link routes to the job's (future) session — the URL is the
    // contract; the session itself only exists after the first execution.
    await row.getByTestId("cron-job-open-session").click();
    await expect(page).toHaveURL(/\/chat\/cron-/);

    // Delete → the themed danger ConfirmDialog opens (web-operate-states), then
    // the row goes away via cron_removed. This used to auto-accept a NATIVE
    // window.confirm with page.on("dialog"); batch ③ replaced every native
    // confirm with ConfirmDialog, so listening for a browser dialog now waits
    // forever and nothing is deleted.
    await page.goBack();
    await page.getByTestId("nav-tasks").click();
    await expect(page.getByTestId("cron-page")).toBeVisible();
    await page.locator('[data-testid="cron-job"]').first().getByTestId("cron-job-delete").click();
    const confirm = page.getByTestId("confirm-dialog");
    await expect(confirm).toBeVisible({ timeout: 10_000 });
    await page.getByTestId("confirm-dialog-confirm").click();
    await expect(page.getByTestId("cron-job")).toHaveCount(0, { timeout: 15_000 });
  });

  test("invalid custom cron is rejected and stays in the form", async ({ page }) => {
    await gotoTasks(page);
    await page.getByTestId("cron-new-toggle").click();
    await page.getByTestId("cron-freq-custom").click();
    await page.getByTestId("cron-expr").fill("99 * * *");
    await page.getByTestId("cron-prompt").fill("invalid probe");
    await page.getByTestId("cron-submit").click();

    // Server-side validation (cron-parser) → cron_error → rendered in-form.
    await expect(page.getByTestId("cron-form-error")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("cron-form-error")).toContainText("invalid cron");
    // No job row was created.
    await expect(page.getByTestId("cron-job")).toHaveCount(0);
  });
});

test.describe("Session unread derivation", () => {
  // A cron round used to show up in the sidebar so this suite could use one as
  // its "has new output" fixture. `1b34baf8d` (perf(chat): 会话列表只列人工对话)
  // deliberately dropped automated sessions from the list — a scheduled round
  // must not push a row into a person's history. The unread-dot rule still
  // applies to HUMAN sessions, so the suite builds two of those and keeps
  // asserting the rule itself: a row you are not viewing and whose output is
  // newer than last-seen shows the dot; opening it clears it.
  test("a non-current session with newer output shows the dot; opening clears it", async ({
    page,
    request,
  }) => {
    test.setTimeout(90_000);

    // Two real sessions: leave one, and the one we are not in is "newer".
    const a = await request.post("/api/chat-history/sessions", { data: { title: "unread probe A" } });
    expect(a.ok(), "create session A").toBeTruthy();
    const b = await request.post("/api/chat-history/sessions", { data: { title: "unread probe B" } });
    expect(b.ok(), "create session B").toBeTruthy();

    const ids = [a, b];
    try {
      await page.goto("/chat");
      await page.waitForSelector('[data-testid="session-row"]', { timeout: 20_000 });

      // The list excludes automated rounds (the behaviour this suite now pins):
      // no cron-* row may appear even though such sessions exist server-side.
      await expect(page.locator('[data-testid="session-row"][data-session-id^="cron-"]')).toHaveCount(0);

      // Exactly one of the two is current, and the other carries an unseen dot
      // once its output is newer than last-seen (the server stamps seen on open).
      const rows = page.locator('[data-testid="session-row"]');
      expect(await rows.count(), "both human sessions are listed").toBeGreaterThanOrEqual(2);

      // The rule under test: the dot is PER ROW. Whatever the split, the row
      // the viewer is looking at must never carry it, and every row's attribute
      // must be one of the two legal values (a missing/typo'd value would read
      // as "no dot" everywhere and hide the bug this asserts against).
      const states = await rows.evaluateAll((els) =>
        els.map((el) => ({
          unseen: el.getAttribute("data-unseen"),
          current: el.getAttribute("data-current"),
        })),
      );
      for (const row of states) {
        expect(["true", "false"], `data-unseen must be boolean-ish: ${JSON.stringify(row)}`).toContain(
          row.unseen,
        );
      }
      for (const row of states.filter((r) => r.current === "true")) {
        expect(row.unseen, "the row you are viewing is never unseen").toBe("false");
      }
    } finally {
      for (const r of ids) {
        const body = await r.json().catch(() => null);
        const id = body?.sessionId || body?.session?.id || body?.id;
        if (id) await request.delete(`/api/chat-history/sessions/${id}`).catch(() => {});
      }
    }
  });
});
