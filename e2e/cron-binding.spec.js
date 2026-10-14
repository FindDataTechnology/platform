import { test, expect } from "@playwright/test";
import { gotoChat, waitForIdle } from "./helpers.js";

// Scheduled-task firing semantics (spec: cron-module). A job bound to a preset
// fires into its own dedicated session and switches the runtime to that preset
// — the one-dsh-process-per-cell constraint means "switch agent" IS "restart
// the runtime" (server/agent-session.js switchPresetToInner).
//
// No LLM needed: the assertions cover the parts that happen BEFORE the model
// answers — the preset switch (current_preset broadcast), the dedicated
// session's creation (chat-history rows), and the binding fields on the job
// payload. The fast suite's LLM gateway is deliberately unreachable, so the
// fired turn errors out on its own time; this spec never awaits it.

// One raw WS to the cell: send cron/preset commands, collect broadcasts.
// Same pattern as agent-presets.spec.js (the page's own socket is not
// reachable from the test). Retries across reconnects while the runtime is
// mid-restart ("Agent is still initializing") — this spec's cleanup restores
// the preset, and the next command must be able to wait out that restart.
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
                resolve({ reply: msg, seen: [] });
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

test.describe("Cron firing binds to (preset, session)", () => {
  test("job bound to a non-active preset switches the runtime and lands in its own session", async ({
    page,
    request,
  }) => {
    test.setTimeout(150_000);
    await gotoChat(page);
    await waitForIdle(page);

    // Roster + current preset (need a second shipped preset to bind to).
    const { reply: presetsMsg } = await wsCall(page, {
      send: { type: "list_presets" },
      collect: "presets",
    });
    const roster = presetsMsg.presets.filter((p) => !p.broken).map((p) => p.id);
    expect(roster.length).toBeGreaterThanOrEqual(2);
    const current = presetsMsg.current;
    const jobPreset = roster.find((id) => id !== current);

    // Create the bound job.
    const { reply: added } = await wsCall(page, {
      send: {
        type: "cron_add",
        cron: "0 3 * * *",
        prompt: "binding probe: write one word",
        preset: jobPreset,
        tz: "UTC",
        sessionTitle: "Binding probe",
      },
      collect: "cron_added",
    });
    const jobId = added.job.id;
    expect(added.job.preset).toBe(jobPreset);
    expect(added.job.sessionId.startsWith("cron-")).toBe(true);
    const sessionId = added.job.sessionId;

    try {
      // Fire it now. The turn will fail on the dead gateway — irrelevant
      // here; the switch and the session row happen before the model call.
      await wsCall(page, { send: { type: "cron_run", jobId }, collect: "cron_run_started" });

      // (a) The runtime switched to the job's preset: the current_preset
      // broadcast (what switchPresetToInner emits after the restart).
      await page.waitForFunction(
        (want) => window.__chatStore.getState().currentPreset === want,
        jobPreset,
        { timeout: 90_000 },
      );

      // (b) The dedicated session exists in chat history (the runner records
      // the user prompt under the bound session BEFORE prompting).
      const list = await (await request.get("/api/chat-history/sessions")).json();
      const row = (list.sessions || []).find((s) => s.id === sessionId);
      expect(row, "job's dedicated session row exists").toBeTruthy();
      expect(row.title).toBe("Binding probe");
    } finally {
      // Cleanup: remove the job and restore the deployment's preset. The
      // dead-gateway turn runs in the job's own session (collector path), so
      // the web session is NOT streaming and set_preset is not guarded out.
      await wsCall(page, { send: { type: "cron_remove", jobId }, collect: "cron_removed" });
      await wsCall(page, { send: { type: "set_preset", id: current }, collect: "current_preset" });
      await waitForIdle(page);
      // The restore restart settles asynchronously (and can race the catalog
      // poll's own child restart). Wait it out HERE — with this spec first
      // alphabetically, later cron specs otherwise inherit "initializing".
      await page.evaluate(
        () =>
          new Promise((resolve, reject) => {
            const deadline = Date.now() + 120_000;
            const tryOnce = () => {
              const ws = new WebSocket(window.location.origin.replace(/^http/, "ws") + "/");
              const timer = setTimeout(() => {
                ws.close();
                retry("timeout");
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
    }
  });

  test("legacy job without a preset keeps its null binding through the payload round trip", async ({ page }) => {
    test.setTimeout(60_000);
    await gotoChat(page);
    await waitForIdle(page);

    const { reply: presetsMsg } = await wsCall(page, {
      send: { type: "list_presets" },
      collect: "presets",
    });
    const current = presetsMsg.current;

    // Legacy shape: no preset, no tz. Firing it would hang on the dead gateway
    // (and queue behind the previous test's still-draining turn), so this
    // covers the payload contract — the null binding survives create/list and
    // the runner's `if (job.preset)` guard (cron-runner.js) is what keeps the
    // live preset untouched for such jobs.
    const { reply: added } = await wsCall(page, {
      send: {
        type: "cron_add",
        cron: "0 4 * * *",
        prompt: "legacy probe",
        preset: null,
        tz: null,
      },
      collect: "cron_added",
    });
    const jobId = added.job.id;
    expect(added.job.preset).toBeNull();
    expect(added.job.tz).toBeNull();

    const { reply: listed } = await wsCall(page, { send: { type: "cron_list" }, collect: "cron_jobs" });
    const row = listed.jobs.find((j) => j.id === jobId);
    expect(row.preset).toBeNull();

    // The live preset was never touched by any of the above.
    const nowPreset = await page.evaluate(() => window.__chatStore.getState().currentPreset);
    expect(nowPreset).toBe(current);

    await wsCall(page, { send: { type: "cron_remove", jobId }, collect: "cron_removed" });
  });
});
