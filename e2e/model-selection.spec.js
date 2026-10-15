import { test, expect } from "@playwright/test";
import { gotoChat } from "./helpers.js";

// The sidebar model <select> is now a read-only chip that links to /models.
// Active model switching still happens via the /model command (WS set_model →
// dsh restart); the Models page sets the *default* pointer (no restart).

async function getDefaultModelId(page) {
  const r = await page.request.get("/api/llm/default");
  const body = await r.json();
  return body.modelId;
}

async function restoreModel(page, modelId) {
  // Reset BOTH the persisted default pointer (PUT) and the active dsh model
  // (/model → restart). set-default persists the pointer but doesn't restart;
  // /model restarts but doesn't un-persist — so cleanup must do both to leave
  // the shared webServer exactly as found. The shared webServer is reused
  // across projects, so this must leave a working model.
  await page.request.put("/api/llm/default", { data: { modelId } });
  await page.goto("/chat/");
  await page.getByTestId("composer-input").fill(`/model ${modelId}`);
  await page.getByTestId("composer-send").click();
  await expect
    .poll(async () => {
      const response = await page.request.get("/api/llm/default");
      return response.ok() ? (await response.json()).activeModelId : null;
    }, { timeout: 20000 })
    .toBe(modelId);
  await expect(page.getByTestId("strip-model")).toContainText(modelId, { timeout: 5000 });
}

async function ensureModelsLoaded(page) {
  // The strip's model control is disabled while no models are loaded, and
  // reads "No model" until one is active; either means the list has not
  // arrived yet.
  await expect(page.getByTestId("strip-model")).toBeVisible({ timeout: 10000 });
  await expect
    .poll(async () => (await page.getByTestId("strip-model").textContent()) || "", { timeout: 5000 })
    .not.toContain("No model");
}

test.describe("model selection", () => {
  let originalModel;

  test.beforeEach(async ({ page }) => {
    await gotoChat(page);
    await ensureModelsLoaded(page);
    originalModel = await getDefaultModelId(page);
  });

  test.afterEach(async ({ page }) => {
    if (!originalModel) return;
    // Restore if EITHER the persisted default pointer OR the active model
    // diverged from the snapshot taken in beforeEach (set-default persists but
    // doesn't restart; /model restarts but doesn't persist — so each half must
    // be undone).
    const current = await getDefaultModelId(page).catch(() => null);
    const active = await page.request
      .get("/api/llm/default")
      .then((r) => r.json())
      .then((b) => b.activeModelId)
      .catch(() => null);
    if ((current && current !== originalModel) || (active && active !== originalModel)) {
      await restoreModel(page, originalModel);
    }
  });

  test("strip model control loads models and reflects active model", async ({ page }) => {
    const control = page.getByTestId("strip-model");
    await expect(control).toBeVisible();
    await expect(async () => {
      const text = (await control.textContent()) || "";
      expect(text.trim().length).toBeGreaterThan(0);
    }).toPass({ timeout: 3000 });
  });

  test("strip model control opens the picker in place", async ({ page }) => {
    await ensureModelsLoaded(page);
    await page.getByTestId("strip-model").click();
    await expect(page.getByTestId("strip-model-menu")).toBeVisible();
    await expect(page.getByTestId("strip-menu-item").first()).toBeVisible();
    // Opening the picker must NOT navigate away from the conversation.
    await expect(page).toHaveURL(/\/chat/);
  });

  test("set default model via the Models page", async ({ page }) => {
    // Discover available models via the WS list (same as the frozen set).
    const models = await page.evaluate(async () => {
      return await new Promise((resolve, reject) => {
        const wsUrl = window.location.origin.replace(/^http/, "ws") + "/";
        const ws = new WebSocket(wsUrl);
        const timer = setTimeout(() => {
          ws.close();
          reject(new Error("list_models timeout"));
        }, 10000);
        ws.onopen = () => ws.send(JSON.stringify({ type: "list_models" }));
        ws.onmessage = (ev) => {
          const msg = JSON.parse(ev.data);
          if (msg.type === "models") {
            clearTimeout(timer);
            ws.close();
            resolve(msg.models || []);
          }
        };
        ws.onerror = () => {
          clearTimeout(timer);
          reject(new Error("websocket error"));
        };
      });
    });

    // Exclude the ACTIVE model, not just the persisted pointer: the row of
    // whichever model is live renders a disabled "Default" button (ModelList
    // keys on `currentModel`), and the two can diverge because set-default
    // persists without restarting. Mirrors the /model command test below.
    const activeId = await page.request
      .get("/api/llm/default")
      .then((r) => r.json())
      .then((b) => b.activeModelId);
    const other = models.find((m) => m.id && m.id !== originalModel && m.id !== activeId);
    if (!other) {
      test.skip(true, "No non-current model available, cannot test switching");
      return;
    }

    await page.goto("/models");
    await expect(page.getByTestId("models-page")).toBeVisible();

    // Click "Set as default" on a non-current model; its row gets the check.
    const row = page
      .locator('[data-testid="llm-model-list"] li')
      .filter({ hasText: other.id });
    await row.getByTestId("llm-set-default").click();
    await expect(row.getByTestId("llm-default-check")).toBeVisible({ timeout: 5000 });

    // The default pointer persisted (the active dsh model only changes on a
    // dsh restart, which set-default deliberately does not trigger — so we
    // assert the persisted pointer, not the live chip).
    const saved = await page.request.get("/api/llm/default");
    const savedBody = await saved.json();
    expect(savedBody.modelId).toBe(other.id);
  });

  test("switch model via /model command", async ({ page }) => {
    // Pick deterministically from the current Volces roster (probe-verified
    // 2026-09-30), one that differs from the CURRENTLY ACTIVE model (not just
    // the persisted default — the two can diverge because set-default persists
    // without restarting). The active id comes from /api/llm/default's
    // activeModelId.
    const def = await page.request.get("/api/llm/default");
    const defBody = await def.json();
    const activeId = defBody.activeModelId;
    const FROZEN = ["deepseek-v4-pro", "glm-5.3-flash", "cohere/north-mini-code:free"];
    const targetId = FROZEN.find((id) => id !== activeId);
    if (!targetId) {
      test.skip(true, "no alternate frozen model available");
      return;
    }

    await page.getByTestId("composer-input").fill(`/model ${targetId}`);
    await page.getByTestId("composer-send").click();

    const turn = page.getByTestId("turn-assistant").filter({ hasText: `/model` }).last();
    await expect(turn).toBeVisible({ timeout: 20000 });
    await expect(async () => {
      const content = (await turn.textContent()) || "";
      expect(content).toMatch(/Model switched to|Current model:/);
    }).toPass({ timeout: 20000 });

    // The strip reflects the active model; poll because the dsh restart takes a
    // few seconds and current_model is re-sent on the next WS connection.
    await expect
      .poll(async () => (await page.getByTestId("strip-model").textContent()) || "", {
        timeout: 20000,
      })
      .toContain(targetId);
  });

  test("invalid model id shows error", async ({ page }) => {
    await page.getByTestId("composer-input").fill("/model nonexistent-model-id-12345");
    await page.getByTestId("composer-send").click();

    // The failure lands in the turn as an error block (icon + server detail).
    await expect(page.getByTestId("turn-error-block")).toContainText("Unknown model", {
      timeout: 10000,
    });
  });

  test("list_models returns the probe-verified Volces-gateway model ids", async ({ page }) => {
    const models = await page.evaluate(async () => {
      return await new Promise((resolve, reject) => {
        const wsUrl = window.location.origin.replace(/^http/, "ws") + "/";
        const ws = new WebSocket(wsUrl);
        const timer = setTimeout(() => {
          ws.close();
          reject(new Error("list_models timeout"));
        }, 10000);
        ws.onopen = () => ws.send(JSON.stringify({ type: "list_models" }));
        ws.onmessage = (ev) => {
          const msg = JSON.parse(ev.data);
          if (msg.type === "models") {
            clearTimeout(timer);
            ws.close();
            resolve(msg.models || []);
          }
        };
        ws.onerror = () => {
          clearTimeout(timer);
          reject(new Error("websocket error"));
        };
      });
    });

    const volcesIds = models.filter((m) => m.provider === "volces").map((m) => m.id);
    // The 2026-09-30 roster refresh: 13 probe-verified ids, deepseek lane
    // first; every dead id (unauthorized / upstream-down / revoked free tier)
    // must be gone from the env route's roster.
    expect(volcesIds.length, `expected 13 volces models; got ${JSON.stringify(volcesIds)}`).toBe(13);
    expect(volcesIds[0]).toBe("deepseek-v4.1-flash");
    const deadIds = [
      "deepseek/deepseek-v4.1-flash",
      "deepseek-v4-pro-0813",
      "deepseek-v4-flash-0731",
      "glm-5.2",
      "kimi-k2.6",
      "mimo-v2.5-pro",
      "nex-agi/nex-n2.5-mini:free",
    ];
    const present = deadIds.filter((id) => volcesIds.includes(id));
    expect(present, `dead ids still on the roster: ${present.join(", ")}`).toEqual([]);

    // First-occurrence dedup across merged provider rosters (env route +
    // user providers may declare the same id): no duplicates may reach the
    // client, or pickers keyed by id collide.
    const allIds = models.map((m) => m.id);
    expect(new Set(allIds).size, `duplicate model ids across providers: ${JSON.stringify(allIds)}`).toBe(allIds.length);
  });
});
