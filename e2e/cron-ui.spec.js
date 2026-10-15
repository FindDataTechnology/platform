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

    // Delete (confirm dialog auto-accepted) → row goes away via cron_removed.
    page.on("dialog", (d) => d.accept());
    await page.goBack();
    await page.getByTestId("nav-tasks").click();
    await expect(page.getByTestId("cron-page")).toBeVisible();
    await page.locator('[data-testid="cron-job"]').first().getByTestId("cron-job-delete").click();
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
  test("sessions with output newer than last-seen show the dot; opening clears it", async ({
    page,
    request,
  }) => {
    // The readiness probe + run-retry loop need headroom under full-suite load.
    test.setTimeout(150_000);
    await gotoChat(page);

    // Wait out any in-flight runtime restart from earlier specs (preset
    // restores): a run against a restarting bridge records nothing.
    await page.evaluate(
      () =>
        new Promise((resolve, reject) => {
          const deadline = Date.now() + 60_000;
          const tryOnce = () => {
            const ws = new WebSocket(window.location.origin.replace(/^http/, "ws") + "/");
            const timer = setTimeout(() => {
              ws.close();
              retry();
            }, 10_000);
            const fail = (msg) => {
              clearTimeout(timer);
              ws.close();
              retry(msg);
            };
            const retry = (msg) => {
              if (Date.now() > deadline) {
                reject(new Error(msg || "runtime never became ready"));
                return;
              }
              setTimeout(tryOnce, 1_500);
            };
            ws.onerror = () => fail("ws error");
            ws.onmessage = (ev) => {
              const msg = JSON.parse(ev.data);
              if (msg.type === "presets") {
                clearTimeout(timer);
                ws.close();
                resolve();
              } else if (msg.type === "error") {
                fail(msg.message);
              }
            };
            ws.onopen = () => ws.send(JSON.stringify({ type: "list_presets" }));
          };
          tryOnce();
        }),
    );

    // A real scheduled task's session: the runner records the prompt into
    // SQLite BEFORE the model call, so the row exists even though the fast
    // suite's LLM gateway is dead (the turn errors on its own time).
    const created = await page.evaluate(
      () =>
        new Promise((resolve, reject) => {
          const ws = new WebSocket(window.location.origin.replace(/^http/, "ws") + "/");
          const timer = setTimeout(() => {
            ws.close();
            reject(new Error("cron_add timeout"));
          }, 30_000);
          ws.onmessage = (ev) => {
            const msg = JSON.parse(ev.data);
            if (msg.type === "error") {
              clearTimeout(timer);
              ws.close();
              reject(new Error(msg.message));
            }
            if (msg.type === "cron_added") {
              clearTimeout(timer);
              ws.close();
              resolve(msg.job);
            }
          };
          ws.onopen = () =>
            ws.send(
              JSON.stringify({
                type: "cron_add",
                cron: "0 5 * * *",
                prompt: "unread probe",
                sessionTitle: "Unread probe",
              }),
            );
        }),
    );
    await page.evaluate(
      (jobId) =>
        new Promise((resolve, reject) => {
          const ws = new WebSocket(window.location.origin.replace(/^http/, "ws") + "/");
          const timer = setTimeout(() => {
            ws.close();
            reject(new Error("cron_run timeout"));
          }, 30_000);
          ws.onmessage = (ev) => {
            const msg = JSON.parse(ev.data);
            if (msg.type === "cron_run_started" || msg.type === "error") {
              clearTimeout(timer);
              ws.close();
              msg.type === "error" ? reject(new Error(msg.message)) : resolve();
            }
          };
          ws.onopen = () => ws.send(JSON.stringify({ type: "cron_run", jobId }));
        }),
      created.id,
    );

    // The runner records the prompt into the job's session ~1s after the
    // ack — unless the bridge was mid-restart (catalog poll), in which case
    // the run records a failure and no row. Retry the run until the row
    // appears on reload; a readiness probe already covers the common case.
    const targetRow = page.locator(
      `[data-testid="session-row"][data-session-id="${created.sessionId}"]`,
    );
    for (let attempt = 0; attempt < 3; attempt++) {
      await page.waitForTimeout(3_000);
      await page.reload();
      const visible = await targetRow
        .isVisible({ timeout: 15_000 })
        .catch(() => false);
      if (visible) break;
      await request.post(`/api/cron/${created.id}/run`);
    }
    await expect(targetRow).toBeVisible({ timeout: 15_000 });
    // Never seen → unread.
    await expect(targetRow).toHaveAttribute("data-unseen", "true", { timeout: 15_000 });

    // Opening the session stamps seen → the dot clears.
    await targetRow.click();
    await expect(targetRow).toHaveAttribute("data-unseen", "false", { timeout: 15_000 });

    // Cleanup: job + its session.
    await page.evaluate(
      (jobId) =>
        new Promise((resolve) => {
          const ws = new WebSocket(window.location.origin.replace(/^http/, "ws") + "/");
          ws.onopen = () => {
            ws.send(JSON.stringify({ type: "cron_remove", jobId }));
            setTimeout(() => {
              ws.close();
              resolve();
            }, 500);
          };
        }),
      created.id,
    );
    // The turn died with the dead gateway; switch away so DELETE isn't 409'd
    // as the active session, then remove the row.
    await request.post("/api/chat-history/sessions");
    await request.delete(`/api/chat-history/sessions/${created.sessionId}`);
  });
});
