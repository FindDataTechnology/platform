import { test, expect } from "@playwright/test";
import { gotoChat, waitForIdle } from "./helpers.js";

// @smoke - real-LLM delegation round trip (spec: agent-delegation-tools).
// The child task runs on the real model (one word), lands `done`, and the
// aggregation turn arrives in the initiating session — the summary itself is
// the initiator persona's real model call. The front half of the acceptance
// picture, serial edition.

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

test("@smoke delegation: child done → summary turn lands in the initiating session", async ({ page, request }) => {
  test.setTimeout(300_000);
  await gotoChat(page);
  await waitForIdle(page);

  const presetsMsg = await wsCall(page, { send: { type: "list_presets" }, collect: "presets" });
  const current = presetsMsg.current;
  const roster = presetsMsg.presets.filter((p) => !p.broken).map((p) => p.id);
  expect(roster.length).toBeGreaterThanOrEqual(2);
  const other = roster.find((id) => id !== current);

  const created = await request.post("/api/delegation/tasks", {
    data: { persona: other, prompt: "Reply with only the word: hello", name: "Smoke delegation" },
  });
  expect(created.status()).toBe(201);
  const task = (await created.json()).task;

  try {
    // The child executes on the real model under the target persona.
    await expect
      .poll(
        async () => {
          const list = await (await request.get("/api/cron")).json();
          return (list.jobs || []).find((j) => j.id === task.id)?.state;
        },
        { timeout: 240_000 },
      )
      .toBe("done");

    // The recorded output is the child session's last assistant text.
    const result = await (await request.get(`/api/delegation/tasks/${task.id}/result`)).json();
    expect(result.state).toBe("done");
    expect((result.output || "").trim().length).toBeGreaterThan(0);

    // The aggregation turn lands in the initiating session (task-authored
    // style), and the initiator persona's summary follows as a real turn.
    await page.goto(`/chat/${task.initiator}`);
    const summary = page.getByTestId("turn-task-summary");
    await expect(summary).toBeVisible({ timeout: 180_000 });
    await expect(summary).toContainText(other);
  } finally {
    await wsCall(page, { send: { type: "cron_remove", jobId: task.id }, collect: "cron_removed" }).catch(() => {});
    await request.post("/api/chat-history/sessions");
    await request.delete(`/api/chat-history/sessions/${task.sessionId}`).catch(() => {});
    if (other !== current) {
      await wsCall(page, { send: { type: "set_preset", id: current }, collect: "current_preset" }).catch(() => {});
    }
    await waitForIdle(page);
  }
});
