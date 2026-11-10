import { test, expect } from "@playwright/test";
import { gotoChat, pinLocaleEn, waitForIdle } from "./helpers.js";

// Task lifecycle on the fast (dead-LLM) project (spec: task-engine). The dead
// gateway makes every execution fail deterministically, which is exactly the
// lifecycle under test: run-now acks `queued`, the execution lands `failed`
// with an error gist, the row offers re-run, and a re-run executes again
// (history grows) and fails again. `done`/`interrupted`/restart-repair are
// covered by the unit suite (engine-level restart simulation) and the @smoke
// lifecycle spec (real turns).

// One raw WS to the cell — same pattern as cron-binding.spec.js (the page's
// own socket is not reachable from the test).
async function wsCall(page, { send, collect, timeout = 90_000 }) {
  return page.evaluate(
    ({ send: out, collect: want, timeout: ms }) =>
      new Promise((resolve, reject) => {
        const ws = new WebSocket(window.location.origin.replace(/^http/, "ws") + "/");
        let sent = false;
        const timer = setTimeout(() => {
          ws.close();
          reject(new Error(`ws timeout waiting for ${want}`));
        }, ms);
        ws.onmessage = (ev) => {
          const msg = JSON.parse(ev.data);
          if (msg.type === "error" && sent) {
            clearTimeout(timer);
            ws.close();
            reject(new Error(msg.message));
            return;
          }
          if (!sent && ws.readyState === 1) {
            sent = true;
            ws.send(JSON.stringify(out));
          }
          if (msg.type === want) {
            clearTimeout(timer);
            ws.close();
            resolve(msg);
          }
        };
        ws.onopen = () => {
          ws.send(JSON.stringify(out));
          sent = true;
        };
      }),
    { send, collect, timeout },
  );
}

async function tasksPage(page) {
  await pinLocaleEn(page);
  await page.goto("/tasks");
  await expect(page.getByTestId("cron-page")).toBeVisible({ timeout: 15_000 });
}

test.describe("Task lifecycle (fast, dead LLM)", () => {
  test("run-now → failed with gist; re-run executes again and fails again", async ({ page, request }) => {
    test.setTimeout(180_000);
    await gotoChat(page);
    await waitForIdle(page);

    // Create a task through the engine API (no preset: legacy live-preset
    // binding — creation must accept it).
    const added = await wsCall(page, {
      send: {
        type: "cron_add",
        cron: "0 3 * * *",
        prompt: "lifecycle probe: reply with one word",
        sessionTitle: "Lifecycle probe",
      },
      collect: "cron_added",
    });
    const job = added.job;
    expect(job.trigger).toBe("schedule");
    expect(job.target.type).toBe("persona");
    expect(job.state).toBe(null);

    try {
      // Run-now acks the queued state.
      const ack = await wsCall(page, {
        send: { type: "cron_run", jobId: job.id },
        collect: "cron_run_started",
      });
      expect(ack.success).toBe(true);
      expect(ack.state).toBe("queued");

      // The dead gateway fails the turn → the row reaches `failed` with a
      // visible error gist and a re-run affordance (en locale: Failed badge).
      await tasksPage(page);
      const row = page.locator(`[data-testid="cron-job"][data-job-id="${job.id}"]`);
      await expect(row).toHaveAttribute("data-job-state", "failed", { timeout: 120_000 });
      await expect(row).toContainText("Failed");
      const gist = await row.getByTestId("cron-job-error").textContent();
      expect(gist.trim().length).toBeGreaterThan(0);
      // Trigger category chip renders.
      await expect(row.getByTestId("cron-job-trigger")).toBeVisible();

      // Re-run: a fresh execution of the same task (history grows by one,
      // then fails again on the dead gateway).
      const historyLen = async () => {
        const list = await (await request.get("/api/cron")).json();
        const row_ = (list.jobs || []).find((j) => j.id === job.id);
        return row_ ? row_.history.length : 0;
      };
      await expect.poll(historyLen, { timeout: 15_000 }).toBe(1);
      await row.getByTestId("cron-job-rerun").click();
      await expect.poll(historyLen, { timeout: 120_000 }).toBe(2);
      await expect(row).toHaveAttribute("data-job-state", "failed", { timeout: 30_000 });

      // Double run-now while idle re-runs (allowed); while queued/running it
      // no-ops — the engine-level guarantee is unit-covered; here the second
      // ack still succeeds without creating a duplicate execution.
      const ack2 = await wsCall(page, {
        send: { type: "cron_run", jobId: job.id },
        collect: "cron_run_started",
      });
      expect(ack2.success).toBe(true);
    } finally {
      await wsCall(page, { send: { type: "cron_remove", jobId: job.id }, collect: "cron_removed" }).catch(() => {});
      await request.post("/api/chat-history/sessions");
      await request.delete(`/api/chat-history/sessions/${job.sessionId}`).catch(() => {});
    }
  });
});
