import { test, expect } from "@playwright/test";
import { gotoChat, waitForIdle } from "./helpers.js";

// Delegation lifecycle on the fast (dead-LLM) project (spec:
// agent-delegation-tools). The dead gateway makes the delegated child fail
// deterministically, which is exactly the path under test: REST delegate →
// manual task in /tasks → live task card → aggregation turn injected into the
// initiating session naming the failure. The happy path (done + summarized
// output) is the @smoke spec.

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

test.describe("Delegation (fast, dead LLM)", () => {
  test("REST delegate → manual task row → task card → aggregation turn names the failure", async ({ page, request }) => {
    test.setTimeout(240_000);
    await gotoChat(page);
    await waitForIdle(page);

    const presetsMsg = await wsCall(page, { send: { type: "list_presets" }, collect: "presets" });
    const current = presetsMsg.current;
    const roster = presetsMsg.presets.filter((p) => !p.broken).map((p) => p.id);
    expect(roster.length).toBeGreaterThanOrEqual(2);
    const other = roster.find((id) => id !== current);

    // Self-delegation is rejected with a structured error, no task.
    const self = await request.post("/api/delegation/tasks", {
      data: { persona: current, prompt: "self probe" },
    });
    expect(self.status()).toBe(400);

    // Delegate to another persona through the bridge (the MCP child's path).
    const created = await request.post("/api/delegation/tasks", {
      data: { persona: other, prompt: "delegation probe: reply with one word", name: "Delegation probe" },
    });
    expect(created.status()).toBe(201);
    const task = (await created.json()).task;
    expect(task.trigger).toBe("manual");
    expect(task.state).toBe("queued");
    expect(task.target.ref).toBe(other);

    try {
      // /tasks lists the manual-trigger task; the dead gateway fails the
      // child (after the runtime switches to the target persona).
      await page.goto("/tasks");
      const row = page.locator(`[data-testid="cron-job"][data-job-id="${task.id}"]`);
      await expect(row).toBeVisible({ timeout: 30_000 });
      await expect(row).toHaveAttribute("data-job-state", "failed", { timeout: 120_000 });
      await expect(row).toContainText("Delegated", { exact: false });

      // The result endpoint names the failure gist (dead gateway).
      const result = await (await request.get(`/api/delegation/tasks/${task.id}/result`)).json();
      expect(result.state).toBe("failed");
      expect(result.error?.length).toBeGreaterThan(0);

      // Back in the conversation: the aggregation turn lands in the
      // initiating session, task-authored (styled, not a user bubble), naming
      // the failure — even though the summary's own model call fails on the
      // dead gateway, the injected turn is already recorded and echoed.
      await page.goto(`/chat/${task.initiator}`);
      const summary = page.getByTestId("turn-task-summary");
      await expect(summary).toBeVisible({ timeout: 120_000 });
      await expect(summary).toContainText(other);
    } finally {
      await wsCall(page, { send: { type: "cron_remove", jobId: task.id }, collect: "cron_removed" }).catch(() => {});
      await request.post("/api/chat-history/sessions");
      await request.delete(`/api/chat-history/sessions/${task.sessionId}`).catch(() => {});
      // The aggregation prompt ran under the restored initiator preset; the
      // engine's own switch already restored it — only re-switch if drifted.
      if (other !== current) {
        await wsCall(page, { send: { type: "set_preset", id: current }, collect: "current_preset" }).catch(() => {});
      }
      await waitForIdle(page);
    }
  });

  test("a delegate_task tool invocation renders as a live task card", async ({ page, request }) => {
    await gotoChat(page);
    await waitForIdle(page);

    const presetsMsg = await wsCall(page, { send: { type: "list_presets" }, collect: "presets" });
    const current = presetsMsg.current;
    const roster = presetsMsg.presets.filter((p) => !p.broken).map((p) => p.id);
    const other = roster.find((id) => id !== current) ?? current;

    const created = await request.post("/api/delegation/tasks", {
      data: { persona: other, prompt: "card probe: one word", name: "Card probe" },
    });
    const task = (await created.json()).task;

    try {
      // Inject the tool turn the way dsh would have streamed it (the
      // cron-tools spec's seam) — the card binds the live record by id.
      await page.evaluate(
        (id) => {
          const s = window.__chatStore;
          s.getState().apply({ type: "agent_start" });
          s.getState().apply({
            type: "tool_start",
            toolCallId: "delegation-card-1",
            name: "mcp__delegation__delegate_task",
            args: { persona: "legal-case", prompt: "card probe: one word" },
          });
          s.getState().apply({
            type: "tool_end",
            toolCallId: "delegation-card-1",
            name: "mcp__delegation__delegate_task",
            result: `Task delegated.\n- id: ${id}\n- persona: probe-persona\n- state: queued\n`,
          });
          s.getState().apply({ type: "done" });
        },
        task.id,
      );
      await page.evaluate(() => window.__chatStore.getState().toggleAllGroups());

      const card = page.getByTestId("task-card");
      await expect(card).toBeVisible({ timeout: 15_000 });
      await expect(card).not.toContainText('"persona"');
      // Live record bound: the state chip tracks the engine's broadcasts.
      await expect(card.getByTestId("task-card-state")).not.toContainText("Queued", { timeout: 120_000 });
    } finally {
      await wsCall(page, { send: { type: "cron_remove", jobId: task.id }, collect: "cron_removed" }).catch(() => {});
      await request.post("/api/chat-history/sessions");
      await request.delete(`/api/chat-history/sessions/${task.sessionId}`).catch(() => {});
      await wsCall(page, { send: { type: "set_preset", id: current }, collect: "current_preset" }).catch(() => {});
    }
  });
});
