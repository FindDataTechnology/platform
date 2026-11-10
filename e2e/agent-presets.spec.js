import { test, expect } from "@playwright/test";
import { execSync } from "node:child_process";
import { E2E_PORT, gotoChat, waitForIdle } from "./helpers.js";

// Agent presets (agent modes): the dsh runtime composes each session's
// capabilities from the platform's `standard` composition (unify-dsh-generation
// retired dsh 0.1's shipped code/minimal/cordis rows; 0.2.0 ships ONE platform
// preset and every catalog / custom persona joins the roster as a generated
// entry) plus any user-authored ones. simplify-chat-and-agents-ia merges the
// picker into the unified「与谁对话」selector: ONE control on the welcome state
// AND in the session header (composition rows disable once the session has
// turns — dsh refuses to recompose), fed by the agent roster as primary source
// with the preset roster contributing composition modes only.
//
// Test order matters: the fast suite's LLM gateway is unreachable, so the
// streaming-guard test's probe turn stays open server-side for a while (dsh
// retries the dead gateway) — it runs LAST so it contaminates nothing. The
// switching test before it restores the deployment default in afterEach.
//
// The empty-roster deployment shape is exercised through the e2e store seam
// (the UI contract: render nothing, never block chat).

const _SHIPPED = ["standard"];

// English pinned via pinLocaleEn; the web bundle owns the localized name.
const SHIPPED_EN_NAMES = {
  standard: "Standard mode",
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

  test("welcome picker renders the platform preset with the active one marked", async ({ page }) => {
    await gotoChat(page);
    await expect(page.getByTestId("chat-welcome")).toBeVisible();
    await expect(page.getByTestId("agent-preset-picker")).toBeVisible({ timeout: 10000 });

    await openPicker(page);
    // The merged selector: the platform preset row plus the agent roster's
    // personas (the catalog persona joins as an agent row — one entity, one
    // row), and NO retired composition modes (D1: standard only unless the
    // layout opts in).
    const options = page.getByTestId("agent-preset-option");
    const ids = await options.evaluateAll((rows) => rows.map((r) => r.dataset.presetId));
    expect(ids).toContain("standard");
    for (const retired of ["code", "minimal", "cordis"]) {
      expect(ids).not.toContain(retired);
    }
    const stdRow = page.locator('[data-testid="agent-preset-option"][data-preset-id="standard"]');
    // Localized (en) display name + description from the web bundle.
    await expect(stdRow).toContainText(SHIPPED_EN_NAMES.standard);
    await expect(stdRow.locator("span").nth(1)).not.toBeEmpty();
    // The deployment default (standard composition + local persona) is marked.
    await expect(stdRow).toHaveAttribute("aria-checked", "true");
    // The platform preset is not broken.
    await expect(page.locator('[data-testid="agent-preset-option"][data-broken="true"]')).toHaveCount(0);

    // D1's client-side half is testable independent of the server roster
    // (which already retired the modes server-side): inject a retired mode
    // into the roster and it must STILL stay off the picker.
    await page.evaluate(() => {
      const { presets } = window.__chatStore.getState();
      window.__chatStore.setState({
        presets: [...presets, { id: "code", name: "PTC", description: "", trust: "system" }],
      });
    });
    await expect(
      page.locator('[data-testid="agent-preset-option"][data-preset-id="code"]'),
    ).toHaveCount(0);
  });

  test("empty roster renders no picker and never blocks chat", async ({ page }) => {
    await gotoChat(page);
    await expect(page.getByTestId("agent-preset-picker")).toBeVisible({ timeout: 10000 });
    // Nothing left to choose between: an empty preset roster AND a
    // single-agent roster (the old picker hid on presets === [] alone; the
    // merged selector hides only when no choice exists at all).
    await page.evaluate(() =>
      window.__chatStore.setState({
        presets: [],
        currentPreset: null,
        agents: [{ id: "local", name: "Local" }],
        currentAgent: "local",
      }),
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

    // The header names the running composition as read-only chrome…
    const label = page.getByTestId("agent-preset-label");
    await expect(label).toBeVisible();
    // The session named no preset (blank = deployment default): the label
    // resolves the CURRENT preset against the roster.
    const currentPreset = await page.evaluate(() => window.__chatStore.getState().currentPreset);
    await expect(label).toHaveText(SHIPPED_EN_NAMES[currentPreset]);
    // Read-only chrome: a span, not a button — interacting cannot switch.
    expect(await label.evaluate((el) => el.tagName)).toBe("SPAN");

    // …and the unified picker lives in the header now: persona switches
    // stay reachable mid-session, while composition rows lock (dsh refuses
    // to recompose a session with turns).
    await page.getByTestId("agent-preset-picker").click();
    await expect(page.getByTestId("agent-preset-picker-menu")).toBeVisible();
    const stdRow = page.locator('[data-testid="agent-preset-option"][data-preset-id="standard"]');
    await expect(stdRow).toBeDisabled();
  });

  test("selecting a mode emits set_preset, blocks the composer while pending, then applies", async ({ page }) => {
    test.setTimeout(120_000);
    await gotoChat(page);
    await expect(page.getByTestId("agent-preset-picker")).toBeVisible({ timeout: 10000 });

    // A generated catalog entry joins the AGENT roster as a persona — the
    // merged selector renders it as an agent row (the preset roster's
    // materialized twin dedupes away), and picking it switches persona via
    // set_agent (a local persona is a preset switch under the hood).
    const agentRoster = await page.evaluate(() => window.__chatStore.getState().agents);
    const other = agentRoster.find((a) => a.id !== "local");
    test.skip(!other, "no second persona in this deployment's agent roster");

    await openPicker(page);
    await page.locator(`[data-testid="agent-preset-option"][data-preset-id="${other.id}"]`).click();
    switchedTo = other.id;

    // Pending is set synchronously on click and cleared only by the server's
    // broadcasts (after the dsh child restarts). Read it once, immediately —
    // the restart window is seconds, the state itself is the contract, and
    // the send button additionally gates on draft text so it is no good as a
    // pendingConfig probe.
    const pending = await page.evaluate(() => window.__chatStore.getState().pendingConfig);
    expect(pending).toBe("agent");
    await expect(page.getByTestId("agent-preset-picker")).toHaveAttribute("data-pending", "true");

    // The server restarts the child and confirms with current_preset.
    await expect
      .poll(() => page.evaluate(() => window.__chatStore.getState().currentPreset), {
        timeout: 60_000,
      })
      .toBe(other.id);
    await expect
      .poll(() => page.evaluate(() => window.__chatStore.getState().pendingConfig))
      .toBe(null);
    await expect(page.getByTestId("agent-preset-picker")).not.toHaveAttribute("data-pending", "true");
    // With the restart settled and a draft present, the composer sends again.
    await page.getByTestId("composer-input").fill("hello");
    await expect(page.getByTestId("composer-send")).toBeEnabled();
    await page.getByTestId("composer-input").fill("");

    // Reopening shows the picked persona as the marked row.
    await openPicker(page);
    await expect(page.locator('[data-testid="agent-preset-option"][aria-checked="true"]')).toHaveAttribute(
      "data-preset-id",
      other.id,
    );
  });

  test("pick while the agent is responding is rejected by the server", async ({ page }) => {
    await gotoChat(page);
    await waitForIdle(page);
    const before = await page.evaluate(() => window.__chatStore.getState().currentPreset);
    // Any roster entry other than the current one: the guard fires on the
    // switch ATTEMPT, not on a particular preset id.
    const roster = await page.evaluate(() => window.__chatStore.getState().presets);
    const target = roster.find((p) => p.id !== before)?.id ?? null;
    test.skip(target === null, "no second preset in this deployment's roster");

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
    // The real cmdline is "node …/@deepseek-ai/dsh/lib/bin.js --profile
    // platform --patch <store>/dsh-home/…", so the old "dsh --profile
    // platform" pattern matched nothing and this kill was a silent no-op.
    // Scope to this run's store root so a developer's concurrently-running
    // dsh (profile platform too) is never hit.
    execSync(`pkill -f "dsh.*--profile platform.*e2e-store-${E2E_PORT}/dsh-home" || true`);
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
