import { test, expect } from "@playwright/test";
import { pinLocaleEn } from "./helpers.js";

// Thinking-level selection (thinking-level-selection). The picker rides the
// /models page next to the active model, and applying a level restarts the dsh
// child — so the round-trip test allows a generous timeout and restores the
// provider default afterwards.

async function gotoModels(page) {
  await pinLocaleEn(page);
  await page.goto("/models");
  await expect(page.getByTestId("models-page")).toBeVisible({ timeout: 15000 });
  // The picker reads reasoningEfforts off the WS `models` payload.
  await expect(page.getByTestId("llm-model-list").first()).toBeVisible({ timeout: 15000 });
}

// The active model's declared levels, straight from the server's own list.
async function activeModelEfforts(page) {
  const [def, providers] = await Promise.all([
    page.request.get("/api/llm/default").then((r) => r.json()),
    page.request.get("/api/llm/providers").then((r) => r.json()),
  ]);
  return { def, providers: providers.providers || [] };
}

test.describe("Thinking level", () => {
  test("picker offers the declared levels for the active model", async ({ page }) => {
    await gotoModels(page);
    const { def } = await activeModelEfforts(page);
    test.skip(!def.activeModelId, "no active model in this environment");

    const select = page.getByTestId("llm-effort-select");
    const declared = def.activeModelId.startsWith("deepseek-v4");
    if (!declared) {
      // Non-reasoning model: no control at all (spec: models payload omits
      // reasoningEfforts → UI renders nothing).
      await expect(select).toHaveCount(0);
      return;
    }
    await expect(select).toBeVisible();
    // "Default" plus every declared level.
    await expect(select.locator("option")).toHaveCount(4);
    await expect(select.locator('option[value="high"]')).toHaveCount(1);
  });

  test("selecting a level round-trips to effort_changed", async ({ page }) => {
    await gotoModels(page);
    const models = await page.evaluate(
      () =>
        new Promise((resolve) => {
          const ws = new WebSocket(`ws://${location.host}/`);
          ws.onmessage = (e) => {
            const m = JSON.parse(e.data);
            if (m.type === "models") {
              ws.close();
              resolve(m.models);
            }
          };
          ws.onopen = () => ws.send(JSON.stringify({ type: "list_models" }));
          setTimeout(() => { ws.close(); resolve([]); }, 10000);
        }),
    );
    const target = models.find((m) => m.reasoningEfforts?.includes("high"));
    test.skip(!target, "no model declares a high thinking level");

    // The dev default model may be non-reasoning, so switch the live session to
    // a declaring model first. Both set_model and set_effort restart the dsh
    // child, hence the long budget; neither spends LLM tokens.
    test.setTimeout(180000);
    const trace = await page.evaluate(
      async ({ targetId, previousId }) => {
        const seen = [];
        const ws = new WebSocket(`ws://${location.host}/`);
        await new Promise((r) => (ws.onopen = r));
        ws.onmessage = (e) => seen.push(JSON.parse(e.data));
        const settle = (pred, ms) =>
          new Promise((resolve) => {
            const started = Date.now();
            const tick = setInterval(() => {
              if (seen.some(pred) || Date.now() - started > ms) {
                clearInterval(tick);
                resolve();
              }
            }, 200);
          });

        ws.send(JSON.stringify({ type: "set_model", id: targetId }));
        await settle((m) => m.type === "model_changed" && m.id === targetId, 60000);
        ws.send(JSON.stringify({ type: "set_effort", effort: "high" }));
        await settle((m) => m.type === "effort_changed" && m.effort === "high", 60000);
        const applied = seen.filter((m) => m.type === "effort_changed");

        // Restore: clear the level, then put the original model back.
        ws.send(JSON.stringify({ type: "set_effort", effort: null }));
        await settle((m) => m.type === "effort_changed" && m.effort === null, 60000);
        if (previousId && previousId !== targetId) {
          ws.send(JSON.stringify({ type: "set_model", id: previousId }));
          await settle((m) => m.type === "model_changed" && m.id === previousId, 60000);
        }
        ws.close();
        return { applied, errors: seen.filter((m) => m.type === "error").map((m) => m.message) };
      },
      { targetId: target.id, previousId: (await activeModelEfforts(page)).def.activeModelId },
    );

    expect(trace.errors).toEqual([]);
    expect(trace.applied.map((m) => m.effort)).toContain("high");
  });

  test("an unsupported level is rejected without changing state", async ({ page }) => {
    await gotoModels(page);
    const { def } = await activeModelEfforts(page);
    test.skip(!def.activeModelId, "no active model in this environment");

    // Drive the WS directly — the UI never offers an undeclared level, so this
    // is the only way to exercise the server-side guard.
    const result = await page.evaluate(
      () =>
        new Promise((resolve) => {
          const ws = new WebSocket(`ws://${location.host}/`);
          const seen = [];
          ws.onmessage = (e) => {
            const m = JSON.parse(e.data);
            if (m.type === "error" || m.type === "effort_changed") seen.push(m);
          };
          ws.onopen = () => ws.send(JSON.stringify({ type: "set_effort", effort: "not-a-level" }));
          setTimeout(() => {
            ws.close();
            resolve(seen);
          }, 4000);
        }),
    );
    expect(result.some((m) => m.type === "effort_changed")).toBe(false);
    expect(result.some((m) => m.type === "error")).toBe(true);
  });
});

// The composer control strip's effort picker. These drive the store seam rather
// than the server: a real set_effort restarts the dsh child (~seconds each), and
// that round-trip is already covered above. What is NOT covered above is the
// composer's own contract — when the control exists, that it renders store state
// instead of its own, and that the restart it triggers blocks sending.
test.describe("Thinking level — composer strip", () => {
  const REASONING = { id: "e2e-reasoning", provider: "e2e", reasoningEfforts: ["low", "medium", "high"] };
  const PLAIN = { id: "e2e-plain", provider: "e2e" };

  // Seed the store with a known model list so the assertions don't depend on
  // whichever catalog this environment happens to serve. The socket only opens
  // once the auth check resolves, so the server's own `models`/`current_model`
  // reply can land after this page load — wait for it, or it clobbers the seed.
  const seed = async (page, currentModel, currentEffort = null) => {
    await expect
      .poll(() => page.evaluate(() => {
        const s = window.__chatStore.getState();
        return s.models.length > 0 && s.currentModel !== null;
      }))
      .toBe(true);
    await page.evaluate(
      ({ models, currentModel, currentEffort }) => {
        window.__chatStore.setState({ models, currentModel, currentEffort, pendingConfig: null });
      },
      { models: [REASONING, PLAIN], currentModel, currentEffort },
    );
  };

  test.beforeEach(async ({ page }) => {
    await pinLocaleEn(page);
    // Record what the composer emits, and swallow the config messages so a
    // click never triggers a real dsh restart. These tests assert the client
    // contract; the server round-trip is covered by the describe above.
    await page.addInitScript(() => {
      window.__sent = [];
      const origSend = WebSocket.prototype.send;
      WebSocket.prototype.send = function (data) {
        let parsed;
        try { parsed = JSON.parse(data); } catch { parsed = null; }
        if (parsed) window.__sent.push(parsed);
        if (parsed && ["set_effort", "set_model", "set_workspace"].includes(parsed.type)) return;
        return origSend.call(this, data);
      };
    });
    await page.goto("/chat");
    await expect(page.getByTestId("composer-control-strip")).toBeVisible({ timeout: 15000 });
  });

  test("effort control appears only for a model that declares levels", async ({ page }) => {
    await seed(page, PLAIN.id);
    await expect(page.getByTestId("strip-effort")).toHaveCount(0);

    await seed(page, REASONING.id);
    await expect(page.getByTestId("strip-effort")).toBeVisible();

    // Switching back removes it — a stale control would offer levels the active
    // model cannot honour.
    await seed(page, PLAIN.id);
    await expect(page.getByTestId("strip-effort")).toHaveCount(0);
  });

  test("menu offers exactly the declared levels and marks the active one", async ({ page }) => {
    await seed(page, REASONING.id, "medium");
    await expect(page.getByTestId("strip-effort")).toContainText("medium");

    await page.getByTestId("strip-effort").click();
    const items = page.getByTestId("strip-effort-menu").getByTestId("strip-menu-item");
    await expect(items).toHaveText(REASONING.reasoningEfforts);
    await expect(items.filter({ hasText: "medium" })).toHaveAttribute("aria-checked", "true");
    await expect(items.filter({ hasText: "low" })).toHaveAttribute("aria-checked", "false");
  });

  test("selecting a level emits set_effort and holds until the server confirms", async ({ page }) => {
    await seed(page, REASONING.id, null);

    await page.getByTestId("composer-input").fill("draft that must not send yet");
    await page.getByTestId("strip-effort").click();
    await page.getByTestId("strip-effort-menu").getByTestId("strip-menu-item")
      .filter({ hasText: "high" }).click();

    // The intent goes out on the wire.
    await expect
      .poll(() => page.evaluate(() => window.__sent.filter((m) => m.type === "set_effort")))
      .toEqual([{ type: "set_effort", effort: "high" }]);

    // Pending: the control still shows the OLD value (no optimistic write) and
    // the composer refuses to send into a restarting runtime.
    await expect(page.getByTestId("strip-effort")).toHaveAttribute("data-pending", "true");
    await expect(page.getByTestId("strip-effort")).not.toContainText("high");
    await expect(page.getByTestId("composer-send")).toBeDisabled();

    // The server's confirming broadcast is what moves the UI.
    await page.evaluate(() =>
      window.__chatStore.getState().apply({ type: "effort_changed", effort: "high" }),
    );
    await expect(page.getByTestId("strip-effort")).toContainText("high");
    await expect(page.getByTestId("strip-effort")).not.toHaveAttribute("data-pending", "true");
    await expect(page.getByTestId("composer-send")).toBeEnabled();
  });

  test("a rejected change releases the composer instead of hanging", async ({ page }) => {
    await seed(page, REASONING.id, null);
    await page.getByTestId("composer-input").fill("still want to send this");
    await page.getByTestId("strip-effort").click();
    await page.getByTestId("strip-effort-menu").getByTestId("strip-menu-item")
      .filter({ hasText: "low" }).click();
    await expect(page.getByTestId("composer-send")).toBeDisabled();

    // No effort_changed ever arrives for a rejected switch — only an error. If
    // that did not clear the pending flag the composer would brick permanently.
    await page.evaluate(() =>
      window.__chatStore.getState().apply({ type: "error", message: "Agent is busy" }),
    );
    await expect(page.getByTestId("strip-effort")).not.toHaveAttribute("data-pending", "true");
    await expect(page.getByTestId("composer-send")).toBeEnabled();
  });
});
