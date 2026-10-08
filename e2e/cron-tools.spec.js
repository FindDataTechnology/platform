import { test, expect } from "@playwright/test";
import { gotoChat, waitForIdle } from "./helpers.js";

// Agent scheduling tools (spec: agent-scheduling-tools). Two halves:
//   1. The REST bridge the MCP child talks to (loopback-exempt /api/cron):
//      create fills the preset binding for internal callers; list round-trips.
//   2. The job card in the conversation: a cron_create tool invocation (name
//      mcp__cron__cron_create) renders as a card whose pause/delete hit the
//      real engine and reconcile via cron_status broadcasts.
//
// The tool block is injected through the store seam (no LLM in the fast
// suite) with the REAL job id parsed into the card — everything downstream of
// the block is live UI ⇄ WS ⇄ engine.

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
            resolve({ reply: msg });
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

test.describe("Cron MCP surface", () => {
  test("REST bridge binds internal creates to the live preset", async ({ page, request }) => {
    await gotoChat(page);
    const { reply: presetsMsg } = await wsCall(page, {
      send: { type: "list_presets" },
      collect: "presets",
    });
    const current = presetsMsg.current;

    // The playwright request fixture connects from loopback, so it enters the
    // same door the MCP child uses.
    const res = await request.post("/api/cron", {
      data: { cron: "*/20 * * * *", prompt: "bridge probe", tz: "UTC" },
    });
    expect(res.status()).toBe(201);
    const { job } = await res.json();
    expect(job.preset).toBe(current);

    const list = await (await request.get("/api/cron")).json();
    expect(list.jobs.some((j) => j.id === job.id)).toBe(true);

    // Invalid cron → 400, no job.
    const bad = await request.post("/api/cron", { data: { cron: "99 * * *", prompt: "x" } });
    expect(bad.status()).toBe(400);

    const del = await request.delete(`/api/cron/${job.id}`);
    expect((await del.json()).ok).toBe(true);
  });

  test("cron_create tool invocation renders a live job card and its actions work", async ({ page }) => {
    await gotoChat(page);
    await waitForIdle(page);

    // Real job (via the page's own WS through the store's socket? No — the
    // page socket is not reachable; use the raw one, same as the UI tests).
    const { reply: added } = await wsCall(page, {
      send: {
        type: "cron_add",
        cron: "0 7 * * *",
        prompt: "card probe: morning brief",
        tz: "UTC",
        sessionTitle: "Card probe",
      },
      collect: "cron_added",
    });
    const jobId = added.job.id;

    try {
      // Inject the tool turn the way dsh would have streamed it.
      await page.evaluate(
        (id) => {
          const s = window.__chatStore;
          s.getState().apply({ type: "agent_start" });
          s.getState().apply({
            type: "tool_start",
            toolCallId: "cron-card-1",
            name: "mcp__cron__cron_create",
            args: { cron: "0 7 * * *", prompt: "card probe: morning brief", tz: "UTC" },
          });
          s.getState().apply({
            type: "tool_end",
            toolCallId: "cron-card-1",
            name: "mcp__cron__cron_create",
            result: `Scheduled task created.\n- id: ${id}\n- schedule: daily at 07:00 (UTC)\n`,
          });
          s.getState().apply({ type: "done" });
        },
        jobId,
      );

      // Tool blocks render inside collapsed activity groups — expand first
      // (same seam plan-smoke uses).
      await page.evaluate(() => window.__chatStore.getState().toggleAllGroups());

      const card = page.getByTestId("cron-tool-card");
      await expect(card).toBeVisible({ timeout: 15_000 });
      // A card, not raw output: schedule phrasing, no JSON dump of the args.
      await expect(card.getByTestId("cron-tool-card-schedule")).toContainText("daily at 07:00");
      await expect(card).not.toContainText('"cron"');

      // Pause from the card → engine → cron_status → card re-renders paused.
      await card.getByTestId("cron-tool-card-toggle").click();
      await expect(card).toContainText("Paused", { timeout: 15_000 });

      // Engine state agrees (the store is fed by the same broadcast).
      const pausedInStore = await page.evaluate(
        (id) => window.__cronStore?.getState?.().jobs.find((j) => j.id === id)?.paused,
        jobId,
      );
      expect(pausedInStore).toBe(true);

      // Delete from the card (confirm auto-accepted) → job gone.
      page.on("dialog", (d) => d.accept());
      await card.getByTestId("cron-tool-card-delete").click();
      await page.waitForFunction(
        (id) => !window.__cronStore?.getState?.().jobs.some((j) => j.id === id),
        jobId,
        { timeout: 15_000 },
      );
    } finally {
      await wsCall(page, { send: { type: "cron_remove", jobId }, collect: "cron_removed" }).catch(
        () => {},
      );
    }
  });
});
