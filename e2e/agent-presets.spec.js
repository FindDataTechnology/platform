import { test, expect } from "@playwright/test";
import { execSync } from "node:child_process";
import { gotoChat, waitForIdle } from "./helpers.js";

// Agent presets (agent modes): the dsh runtime composes each session's
// capabilities from one of four shipped presets (standard/code/minimal/cordis)
// plus any user-authored ones. The picker lives on the welcome (blank) state —
// dsh refuses to recompose a session that has produced turns — and an active
// session shows a read-only header label instead.
//
// Test order matters: the fast suite's LLM gateway is unreachable, so the
// streaming-guard test's probe turn stays open server-side for a while (dsh
// retries the dead gateway) — it runs LAST so it contaminates nothing. The
// switching test before it restores the deployment default in afterEach.
//
// The empty-roster deployment shape is exercised through the e2e store seam
// (the UI contract: render nothing, never block chat).

const SHIPPED = ["standard", "code", "minimal", "cordis"];

// English pinned via pinLocaleEn; the web bundle owns localized names for the
// four shipped ids (their preset.yml metadata is zh-only).
const SHIPPED_EN_NAMES = {
  standard: "Standard mode",
  code: "PTC mode",
  minimal: "Minimal mode",
  cordis: "Creative mode",
};

async function openPicker(page) {
  await page.getByTestId("agent-preset-picker").click();
  await expect(page.getByTestId("agent-preset-picker-menu")).toBeVisible();
}

// Restore the deployment's preset through a raw WS connection (the page's
// main socket is not reachable from the test). Resolves once the server
// confirms with current_preset.
async function restorePreset(page, id) {
  return page.evaluate(
    (presetId) =>
      new Promise((resolve, reject) => {
        const ws = new WebSocket(window.location.origin.replace(/^http/, "ws") + "/");
        const timer = setTimeout(() => {
          ws.close();
          reject(new Error("set_preset timeout"));
        }, 60000);
        ws.onmessage = (ev) => {
          const msg = JSON.parse(ev.data);
          // Ignore the connect-time sync; only a post-send confirmation counts.
          if (msg.type === "error" && sent) {
            clearTimeout(timer);
            ws.close();
            reject(new Error(msg.message));
          }
          if (msg.type === "current_preset" && msg.id === presetId && sent) {
            clearTimeout(timer);
            ws.close();
            resolve(msg.id);
          }
        };
        let sent = false;
        ws.onopen = () => {
          ws.send(JSON.stringify({ type: "set_preset", id: presetId }));
          sent = true;
        };
      }),
    id,
  );
}

test.describe("agent presets", () => {
  let switchedTo = null;

  test.afterEach(async ({ page }) => {
    // Leave the shared server on the deployment default: the persisted
    // `agent.preset` preference survives into later tests (and the smoke run).
    await waitForIdle(page, 5000).catch(() => {});
    if (switchedTo && switchedTo !== "standard") {
      await restorePreset(page, "standard");
    }
    switchedTo = null;
  });

  test("welcome picker renders the four shipped modes with the active one marked", async ({ page }) => {
    await gotoChat(page);
    await expect(page.getByTestId("chat-welcome")).toBeVisible();
    await expect(page.getByTestId("agent-preset-picker")).toBeVisible({ timeout: 10000 });

    await openPicker(page);
    const options = page.getByTestId("agent-preset-option");
    await expect(options).toHaveCount(4);
    const ids = await options.evaluateAll((rows) => rows.map((r) => r.dataset.presetId));
    expect(new Set(ids)).toEqual(new Set(SHIPPED));
    // Localized (en) display names + descriptions from the web bundle.
    for (const id of SHIPPED) {
      const row = page.locator(`[data-testid="agent-preset-option"][data-preset-id="${id}"]`);
      await expect(row).toContainText(SHIPPED_EN_NAMES[id]);
      await expect(row.locator("span").nth(1)).not.toBeEmpty();
    }
    // The deployment default is visually marked.
    await expect(page.locator('[data-testid="agent-preset-option"][aria-checked="true"]')).toHaveAttribute(
      "data-preset-id",
      "standard",
    );
    // None of the shipped presets is broken.
    await expect(page.locator('[data-testid="agent-preset-option"][data-broken="true"]')).toHaveCount(0);
  });

  test("empty roster renders no picker and never blocks chat", async ({ page }) => {
    await gotoChat(page);
    await expect(page.getByTestId("agent-preset-picker")).toBeVisible({ timeout: 10000 });
    // A deployment that composes no roster answers list_presets with [] —
    // the same state the store reaches after the server's empty roster lands.
    await page.evaluate(() =>
      window.__chatStore.setState({ presets: [], currentPreset: null }),
    );
    await expect(page.getByTestId("agent-preset-picker")).toHaveCount(0);
    // Chat itself is unaffected: the composer is still usable.
    await expect(page.getByTestId("composer-input")).toBeVisible();
    await expect(page.getByTestId("composer-input")).toBeEnabled();
  });

  test("active session shows its preset as a read-only header label", async ({ page }) => {
    await gotoChat(page);
    await expect(page.getByTestId("agent-preset-picker")).toBeVisible({ timeout: 10000 });

    // Open an in-session view without an LLM round-trip: the /model command
    // with the ACTIVE model id short-circuits (no restart) and still emits a
    // command_use turn, which swaps welcome → transcript + header.
    const modelId = await page.evaluate(() => window.__chatStore.getState().currentModel);
    await page.getByTestId("composer-input").fill(`/model ${modelId}`);
    await page.getByTestId("composer-send").click();
    await expect(page.getByTestId("chat-header")).toBeVisible({ timeout: 20000 });
    await waitForIdle(page);

    // The picker is gone mid-session; the header names the preset instead.
    await expect(page.getByTestId("agent-preset-picker")).toHaveCount(0);
    const label = page.getByTestId("agent-preset-label");
    await expect(label).toBeVisible();
    // The session named no preset (blank = deployment default): the label
    // resolves the CURRENT preset against the roster.
    const currentPreset = await page.evaluate(() => window.__chatStore.getState().currentPreset);
    await expect(label).toHaveText(SHIPPED_EN_NAMES[currentPreset]);
    // Read-only chrome: a span, not a button — interacting cannot switch.
    expect(await label.evaluate((el) => el.tagName)).toBe("SPAN");
  });

  test("selecting a mode emits set_preset, blocks the composer while pending, then applies", async ({ page }) => {
    test.setTimeout(120_000);
    await gotoChat(page);
    await expect(page.getByTestId("agent-preset-picker")).toBeVisible({ timeout: 10000 });

    await openPicker(page);
    await page.locator('[data-testid="agent-preset-option"][data-preset-id="minimal"]').click();
    switchedTo = "minimal";

    // Pending is set synchronously on click and cleared only by the server's
    // current_preset broadcast (after the dsh child restarts). Read it once,
    // immediately — the restart window is seconds, the state itself is the
    // contract, and the send button additionally gates on draft text so it is
    // no good as a pendingConfig probe.
    const pending = await page.evaluate(() => window.__chatStore.getState().pendingConfig);
    expect(pending).toBe("preset");
    await expect(page.getByTestId("agent-preset-picker")).toHaveAttribute("data-pending", "true");

    // The server restarts the child and confirms with current_preset.
    await expect
      .poll(() => page.evaluate(() => window.__chatStore.getState().currentPreset), {
        timeout: 60_000,
      })
      .toBe("minimal");
    await expect
      .poll(() => page.evaluate(() => window.__chatStore.getState().pendingConfig))
      .toBe(null);
    await expect(page.getByTestId("agent-preset-picker")).not.toHaveAttribute("data-pending", "true");
    // With the restart settled and a draft present, the composer sends again.
    await page.getByTestId("composer-input").fill("hello");
    await expect(page.getByTestId("composer-send")).toBeEnabled();
    await page.getByTestId("composer-input").fill("");
    await expect(page.getByTestId("agent-preset-picker")).toContainText("Minimal mode");

    // Reopening shows minimal as the marked row.
    await openPicker(page);
    await expect(page.locator('[data-testid="agent-preset-option"][aria-checked="true"]')).toHaveAttribute(
      "data-preset-id",
      "minimal",
    );
  });

  test("pick while the agent is responding is rejected by the server", async ({ page }) => {
    await gotoChat(page);
    await waitForIdle(page);
    const before = await page.evaluate(() => window.__chatStore.getState().currentPreset);
    const target = SHIPPED.find((id) => id !== before);

    // One raw socket: `prompt` then `set_preset` back-to-back. The server sets
    // isStreaming synchronously while admitting the prompt, so the preset
    // switch hits the same guard as set_model — deterministically, without
    // waiting on any real model output. The connect-time sync ALSO carries a
    // current_preset (id = the unchanged default), which is not a switch —
    // only events observed after our messages were sent count.
    const outcome = await page.evaluate(
      (presetId) =>
        new Promise((resolve) => {
          const ws = new WebSocket(window.location.origin.replace(/^http/, "ws") + "/");
          const errors = [];
          let sent = false;
          let flipped = null;
          const timer = setTimeout(() => {
            ws.close();
            resolve({ flipped, errors });
          }, 20000);
          ws.onmessage = (ev) => {
            const msg = JSON.parse(ev.data);
            if (msg.type === "error") errors.push(msg.message);
            if (msg.type === "current_preset" && sent) flipped = msg.id;
            if (msg.type === "done" && sent) {
              clearTimeout(timer);
              ws.close();
              resolve({ flipped, errors });
            }
          };
          ws.onopen = () => {
            ws.send(JSON.stringify({ type: "prompt", text: "preset guard probe" }));
            ws.send(JSON.stringify({ type: "set_preset", id: presetId }));
            sent = true;
          };
        }),
      target,
    );

    // The guard rejected the switch: the error goes to the requesting socket
    // only, and the only current_preset it observes is the connect-time sync
    // of the UNCHANGED default — never the requested id.
    expect(outcome.errors.some((m) => /responding/i.test(m))).toBe(true);
    expect(outcome.flipped ?? before).toBe(before);
    expect(outcome.flipped).not.toBe(target);
    await expect
      .poll(() => page.evaluate(() => window.__chatStore.getState().currentPreset))
      .toBe(before);

    // End the probe's turn NOW instead of leaving it to dsh's LLM retry
    // ladder (~15s+ of jitter against the dead gateway, during which the
    // server rejects new_session/set_preset — enough to poison later specs).
    // dsh has no interrupt RPC, so kill the child: the bridge's crash path
    // broadcasts error+done (streaming resets) and respawns a fresh child
    // with backoff. Poll `list_presets` (read-only, side-effect-free) until
    // the respawned child answers again.
    execSync('pkill -f "dsh --profile platform" || true');
    await expect(async () => {
      const r = await page.evaluate(
        () =>
          new Promise((resolve) => {
            const ws = new WebSocket(window.location.origin.replace(/^http/, "ws") + "/");
            const timer = setTimeout(() => {
              ws.close();
              resolve("timeout");
            }, 4000);
            ws.onmessage = (ev) => {
              const msg = JSON.parse(ev.data);
              // A non-empty roster proves the BRIDGE is ready again: while it
              // is down, the server answers list_presets with [] instead of
              // an error, which would read as a false-positive recovery.
              if (sent && msg.type === "presets" && msg.presets.length > 0) {
                clearTimeout(timer);
                ws.close();
                resolve("ok");
              }
              if (sent && msg.type === "error") {
                clearTimeout(timer);
                ws.close();
                resolve(msg.message);
              }
            };
            let sent = false;
            ws.onopen = () => {
              ws.send(JSON.stringify({ type: "list_presets" }));
              sent = true;
            };
          }),
      );
      if (r !== "ok") throw new Error(`runtime not recovered: ${r}`);
    }).toPass({ timeout: 60000 });

    // Delete the probe's session row: every session a spec leaves pushes the
    // sidebar's group list toward its preview limit, and a current session
    // hidden behind the "Show 1 more" cut breaks later specs' lookups. Mint a
    // throwaway current session first — the probe session is the active one
    // and the API 409s deleting it.
    await page.evaluate(
      () =>
        new Promise((resolve) => {
          const ws = new WebSocket(window.location.origin.replace(/^http/, "ws") + "/");
          ws.onmessage = (ev) => {
            const msg = JSON.parse(ev.data);
            if (msg.type === "sessions") {
              ws.close();
              resolve(msg.current);
            }
          };
          ws.onopen = () => ws.send(JSON.stringify({ type: "new_session" }));
        }),
    );
    const sessions = await page.request.get("/api/chat-history/sessions").then((r) => r.json());
    const probe = (sessions.sessions || []).find((s) => s.title === "preset guard probe");
    if (probe) {
      const del = await page.request.delete(`/api/chat-history/sessions/${encodeURIComponent(probe.id)}`);
      if (!del.ok) console.warn(`cleanup: probe session delete returned ${del.status}`);
    }
  });
});
