// E2E for wire-dsh-live-runtime-control client behaviors (the store/UI side;
// the bridge RPCs themselves are exercised by the dsh:contracts suite and the
// local smoke):
//   - submit latch: Enter repeats inside the echo blind window send nothing
//   - done carries usage → turn footer + composer context meter
//   - web-search chip: renders on live capability, default off, toggles via
//     set_tool_gate, flips on the tool_gate echo
//   - stop button sends the real stop_turn cancel
//   - model selector stays usable mid-run only when the child declares
//     model/set (legacy children keep the streaming disable)
//
// Drives the window.__chatStore seam (e2e build only) plus a WebSocket.send
// recorder — no real LLM turn is required except where noted.

import { test, expect } from "@playwright/test";
import { gotoChat } from "./helpers.js";

test.describe("live runtime control: latch, usage, web-search toggle", () => {
  test.beforeEach(async ({ page }) => {
    await gotoChat(page);
    await page.evaluate(() => {
      const OrigWS = window.WebSocket;
      window.__sent = [];
      const origSend = OrigWS.prototype.send;
      OrigWS.prototype.send = function (data) {
        try {
          const parsed = JSON.parse(data);
          if (parsed) window.__sent.push(parsed);
        } catch {
          parsed = null;
        }
        return origSend.call(this, data);
      };
    });
    await expect(page.getByTestId("composer-control-strip")).toBeVisible({ timeout: 15000 });
  });

  const sentOfType = (page, type) =>
    page.evaluate((t) => window.__sent.filter((m) => m.type === t), type);

  test("the real e2e child answers platform/capabilities", async ({ page }) => {
    // The connect-time models message carries the server's live flags, which
    // come from probing the REAL dsh child (template materialized by
    // dsh-profile). This is the one assertion that exercises the full D8
    // chain — template → child → probe → flags — everything else above forges
    // the flags through the store seam.
    const live = await page.evaluate(() => window.__chatStore.getState().liveControl);
    expect(live).toEqual({ modelSet: true, cancel: true, toolGate: true });
  });

  test("submit latch swallows Enter repeats until the echo releases it", async ({ page }) => {
    // Arm the latch the way a real submit does (the store seam), then Enter
    // a non-empty draft: nothing leaves — the blind window cannot re-send.
    await page.evaluate(() => window.__chatStore.getState().beginPromptSubmit());
    await expect(page.getByTestId("composer-sending")).toBeVisible();
    const input = page.getByTestId("composer-input");
    await input.fill("latched draft");
    await input.press("Enter");
    await input.press("Enter");
    await page.waitForTimeout(300);
    expect(await sentOfType(page, "prompt")).toEqual([]);
    // The echo releases the latch (the send control returns).
    await page.evaluate(() => window.__chatStore.getState().apply({ type: "user", text: "latched draft" }));
    await expect(page.getByTestId("composer-send")).toBeVisible();
    // A fresh submit now sends for real.
    await input.fill("real send");
    await input.press("Enter");
    await expect
      .poll(() => sentOfType(page, "prompt"), { timeout: 10000 })
      .toEqual([{ type: "prompt", text: "real send" }]);
    // Settle the synthetic turn state so later hooks see idle.
    await page.evaluate(() => window.__chatStore.getState().apply({ type: "done" }));
  });

  test("done usage lands on the turn footer and the context meter", async ({ page }) => {
    await page.evaluate(() => {
      const s = window.__chatStore.getState();
      s.apply({
        type: "models",
        models: [{ id: "e2e-live-model", name: "E2E Live", provider: "volces", contextWindow: 100000 }],
        live: { modelSet: true, cancel: true, toolGate: true },
      });
      s.apply({ type: "current_model", id: "e2e-live-model" });
      s.apply({ type: "user", text: "计数" });
      s.apply({ type: "agent_start" });
      s.apply({ type: "text", delta: "答案" });
    });
    await page.waitForTimeout(150);
    await page.evaluate(() => {
      window.__chatStore.getState().apply({
        type: "done",
        usage: { inputTokens: 50000, outputTokens: 1200 },
      });
    });
    await expect(page.getByTestId("turn-usage")).toBeVisible();
    await expect(page.getByTestId("turn-usage")).toContainText("50k");
    const meter = page.getByTestId("strip-context-meter");
    await expect(meter).toBeVisible();
    await expect(meter).toContainText("50");
    // A second done WITHOUT usage on a fresh turn omits the footer (no fake 0).
    await page.evaluate(() => {
      const s = window.__chatStore.getState();
      s.apply({ type: "user", text: "再问" });
      s.apply({ type: "agent_start" });
      s.apply({ type: "text", delta: "二" });
      s.apply({ type: "done" });
    });
    await page.waitForTimeout(200);
    await expect(page.getByTestId("turn-usage")).toHaveCount(1);
  });

  test("web-search chip: default off, toggles through set_tool_gate", async ({ page }) => {
    await page.evaluate(() => {
      window.__chatStore.getState().apply({
        type: "models",
        models: [{ id: "e2e-live-model", name: "E2E Live", provider: "volces" }],
        live: { modelSet: true, cancel: true, toolGate: true },
      });
    });
    const chip = page.getByTestId("strip-websearch");
    await expect(chip).toBeVisible();
    await expect(chip).toHaveAttribute("data-enabled", "false");
    await chip.click();
    await expect
      .poll(() => sentOfType(page, "set_tool_gate"), { timeout: 5000 })
      .toEqual([{ type: "set_tool_gate", server: "websearch", enabled: true }]);
    // The server's tool_gate echo (per-session sync) flips the chip.
    const sid = await page.evaluate(() => window.__chatStore.getState().currentSessionId);
    await page.evaluate((sessionId) => {
      window.__chatStore.getState().apply({ type: "tool_gate", sessionId, server: "websearch", enabled: true });
    }, sid);
    await expect(chip).toHaveAttribute("data-enabled", "true");
    // A foreign session's gate state never moves this client's chip.
    await page.evaluate(() => {
      window.__chatStore.getState().apply({ type: "tool_gate", sessionId: "other-session", server: "websearch", enabled: false });
    });
    await expect(chip).toHaveAttribute("data-enabled", "true");
  });

  test("web-search chip hidden without the toolGate capability", async ({ page }) => {
    await page.evaluate(() => {
      window.__chatStore.getState().apply({
        type: "models",
        models: [{ id: "e2e-legacy-model", name: "E2E Legacy", provider: "volces" }],
        live: { modelSet: false, cancel: false, toolGate: false },
      });
    });
    await expect(page.getByTestId("strip-websearch")).toHaveCount(0);
  });

  test("stop button sends the real stop_turn cancel", async ({ page }) => {
    await page.evaluate(() => {
      const s = window.__chatStore;
      s.getState().apply({ type: "agent_start" });
      s.getState().apply({ type: "text", delta: "partial" });
    });
    await expect(page.getByTestId("composer-stop")).toBeVisible();
    await page.getByTestId("composer-stop").click();
    await expect
      .poll(() => sentOfType(page, "stop_turn"), { timeout: 5000 })
      .toEqual([{ type: "stop_turn" }]);
    // The local finalize still applies instantly: interrupted marker, composer back.
    await expect(page.getByTestId("turn-interrupted")).toBeVisible();
    await expect(page.getByTestId("composer-send")).toBeVisible();
    await page.evaluate(() => window.__chatStore.getState().apply({ type: "done" }));
  });

  test("model selector mid-run: live stays open, legacy disables", async ({ page }) => {
    await page.evaluate(() => {
      window.__chatStore.getState().apply({
        type: "models",
        models: [{ id: "e2e-live-model", name: "E2E Live", provider: "volces" }],
        live: { modelSet: true, cancel: true, toolGate: true },
      });
    });
    await page.evaluate(() => window.__chatStore.getState().apply({ type: "agent_start" }));
    // Live: the model menu control remains enabled while streaming.
    await expect(page.getByTestId("strip-model")).toBeEnabled();
    await page.evaluate(() => window.__chatStore.getState().apply({ type: "done" }));
    // Legacy: the strip's switchers disable for the run's duration.
    await page.evaluate(() => {
      window.__chatStore.getState().apply({
        type: "models",
        models: [{ id: "e2e-legacy-model", name: "E2E Legacy", provider: "volces" }],
        live: { modelSet: false, cancel: false, toolGate: false },
      });
    });
    await page.evaluate(() => window.__chatStore.getState().apply({ type: "agent_start" }));
    await expect(page.getByTestId("strip-model")).toBeDisabled();
    await page.evaluate(() => window.__chatStore.getState().apply({ type: "done" }));
  });
});
