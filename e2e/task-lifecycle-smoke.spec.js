import { test, expect } from "@playwright/test";
import { gotoChat, waitForIdle } from "./helpers.js";

// @smoke - real-LLM task lifecycle (spec: task-engine). Two executions:
//   1. done — a one-word task completes and the row shows the done outcome.
//   2. interrupted — a long streaming execution is aborted by a preset switch
//      (the one-dsh-per-cell rule: switching agent = restarting the runtime,
//      which aborts in-flight task turns) and lands `interrupted`, re-run-able.
// Lives in the smoke project (real LLM calls against the configured provider).

async function wsCall(page, { send, collect, timeout = 90_000 }) {
  const started = Date.now();
  for (;;) {
    try {
      return await page.evaluate(
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
        { send, collect, timeout: Math.max(5_000, timeout - (Date.now() - started)) },
      );
    } catch (e) {
      if (/initializing|not ready/i.test(e.message) && Date.now() - started < timeout) {
        await page.waitForTimeout(1_500);
        continue;
      }
      throw e;
    }
  }
}

async function addTask(page, { prompt, preset }) {
  const added = await wsCall(page, {
    send: {
      type: "cron_add",
      cron: "0 3 * * *",
      prompt,
      ...(preset ? { preset } : {}),
      sessionTitle: "Smoke lifecycle probe",
    },
    collect: "cron_added",
  });
  return added.job;
}

test.describe("@smoke task lifecycle", () => {
  test("execution completes → done; mid-turn preset switch → interrupted", async ({ page, request }) => {
    test.setTimeout(300_000);
    await gotoChat(page);
    await waitForIdle(page);

    const presetsMsg = await wsCall(page, {
      send: { type: "list_presets" },
      collect: "presets",
    });
    const current = presetsMsg.current;
    const roster = presetsMsg.presets.filter((p) => !p.broken).map((p) => p.id);
    const other = roster.find((id) => id !== current) ?? current;

    // ── 1. done ────────────────────────────────────────────────────────────
    const doneJob = await addTask(page, { prompt: "Reply with only the word: hello" });
    try {
      await wsCall(page, { send: { type: "cron_run", jobId: doneJob.id }, collect: "cron_run_started" });
      await page.goto("/tasks");
      const row = page.locator(`[data-testid="cron-job"][data-job-id="${doneJob.id}"]`);
      // done falls back to the schedule badge; the lifecycle outcome is read
      // from the payload (history last entry success=true).
      await expect
        .poll(
          async () => {
            const list = await (await request.get("/api/cron")).json();
            const j = (list.jobs || []).find((x) => x.id === doneJob.id);
            return j?.state;
          },
          { timeout: 180_000 },
        )
        .toBe("done");
      await expect(row).toHaveAttribute("data-job-state", "done", { timeout: 30_000 });
    } finally {
      await wsCall(page, { send: { type: "cron_remove", jobId: doneJob.id }, collect: "cron_removed" }).catch(() => {});
      await request.post("/api/chat-history/sessions");
      await request.delete(`/api/chat-history/sessions/${doneJob.sessionId}`).catch(() => {});
    }

    // ── 2. interrupted ─────────────────────────────────────────────────────
    // A long generation keeps the turn streaming long enough to switch the
    // preset mid-turn; the restart aborts the collector (bridge abort →
    // interrupted, not failed).
    const longJob = await addTask(page, {
      prompt: "Write a detailed 600-word story about a lighthouse keeper. Do not stop early.",
    });
    try {
      await wsCall(page, { send: { type: "cron_run", jobId: longJob.id }, collect: "cron_run_started" });
      await page.goto("/tasks");
      const row = page.locator(`[data-testid="cron-job"][data-job-id="${longJob.id}"]`);
      await expect(row).toHaveAttribute("data-job-state", "running", { timeout: 120_000 });

      // Switch the runtime mid-turn: the restart aborts the execution.
      await wsCall(page, { send: { type: "set_preset", id: other }, collect: "current_preset" });
      await expect(row).toHaveAttribute("data-job-state", "interrupted", { timeout: 120_000 });
      await expect(row).toContainText("Interrupted");
      await expect(row.getByTestId("cron-job-rerun")).toBeVisible();
    } finally {
      await wsCall(page, { send: { type: "cron_remove", jobId: longJob.id }, collect: "cron_removed" }).catch(() => {});
      // Restore the deployment's preset and wait out the restart.
      if (other !== current) {
        await wsCall(page, { send: { type: "set_preset", id: current }, collect: "current_preset" }).catch(() => {});
      }
      await request.post("/api/chat-history/sessions");
      await request.delete(`/api/chat-history/sessions/${longJob.sessionId}`).catch(() => {});
      await waitForIdle(page);
    }
  });
});
