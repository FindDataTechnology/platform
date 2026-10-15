import { test, expect } from "@playwright/test";
import http from "node:http";
import { pinLocaleEn } from "./helpers.js";

// Reserved-route override + default-lane guard (add-editable-llm-route). The
// harness boots the env Volces route against an unreachable URL, so the spec
// first points the route's OVERRIDE at a spec-owned mock gateway — that save
// path is itself the behavior under test. Auth is off in the harness, so
// admin actions are open. Self-cleaning: the override is cleared and the
// default pointer restored at the end.

const PAGE_URL = "/models";

const mock = {
  port: 0,
  serving: ["e2e-route-good"],
  unauthorized: ["e2e-route-dark"],
};

function startMock() {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const reply = (status, body) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (req.method === "GET" && req.url === "/v1/models") {
        return reply(200, { data: [...mock.serving, ...mock.unauthorized].map((id) => ({ id })) });
      }
      if (req.method === "POST" && req.url === "/v1/chat/completions") {
        const model = JSON.parse(Buffer.concat(chunks).toString()).model;
        if (mock.serving.includes(model)) {
          return reply(200, { choices: [{ message: { content: "ok" }, finish_reason: "stop" }] });
        }
        return reply(404, {
          error: {
            message: `Model "${model}" is not supported by any configured account in this group`,
            type: "model_not_found",
          },
        });
      }
      reply(404, {});
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

let mockServer;
let mockBase;

test.beforeAll(async () => {
  mockServer = await startMock();
  mock.port = mockServer.address().port;
  mockBase = `http://127.0.0.1:${mock.port}`;
});

test.afterAll(() => mockServer.close());

async function getVolces(page) {
  const body = await (await page.request.get("/api/llm/providers")).json();
  return (body.providers || []).find((p) => p.id === "volces") || null;
}

test.describe("Reserved-route override", () => {
  test.afterEach(async ({ page }) => {
    await page.request.post("/api/llm/providers/volces/clear-override");
    // Restore a deterministic default (the harness's first baked id).
    const volces = await getVolces(page);
    if (volces?.models?.length) {
      await page.request.put("/api/llm/default", { data: { modelId: volces.models[0] } });
    }
  });

  test("editor edits the reserved roster without a rebuild and flags the override", async ({ page }) => {
    await pinLocaleEn(page);
    await page.goto(PAGE_URL);
    const card = page.locator('[data-testid="llm-provider-card"][data-provider-id="volces"]');
    await expect(card).toBeVisible({ timeout: 15000 });
    // No override yet: no indicator, clear disabled.
    await expect(card.getByTestId("llm-override-active")).toHaveCount(0);

    await card.getByTestId("llm-edit-models-btn").click();
    await card.getByTestId("llm-model-add-id").fill("e2e-route-added");
    await card.getByTestId("llm-model-add-btn").click();
    await card.getByTestId("llm-model-save").click();

    // The picker roster refreshed (models broadcast, no restart): the new id
    // shows on the card, and the override indicator lit up.
    await expect(
      card.locator('[data-testid="llm-model-list"] li').filter({ hasText: "e2e-route-added" }),
    ).toBeVisible({ timeout: 10000 });
    await expect(card.getByTestId("llm-override-active")).toBeVisible();
    const volces = await getVolces(page);
    expect(volces.override.active).toBe(true);
    expect(volces.models).toContain("e2e-route-added");
  });

  test("clearing the override rolls the lane back to the baked roster", async ({ page }) => {
    await page.request.put("/api/llm/providers/volces", {
      data: { models: [{ id: "e2e-route-only" }] },
    });
    await pinLocaleEn(page);
    await page.goto(PAGE_URL);
    const card = page.locator('[data-testid="llm-provider-card"][data-provider-id="volces"]');
    await expect(card.getByTestId("llm-override-active")).toBeVisible({ timeout: 15000 });

    await card.getByTestId("llm-override-clear").click();
    await expect(card.getByTestId("llm-override-active")).toHaveCount(0, { timeout: 10000 });
    const volces = await getVolces(page);
    expect(volces.override.active).toBe(false);
    expect(volces.models).toContain("deepseek-v4.1-flash");
    expect(volces.models).not.toContain("e2e-route-only");
  });

  test("reserved sync persists through the override; apiKey/delete stay refused", async ({ page }) => {
    await page.request.put("/api/llm/providers/volces", { data: { baseUrl: mockBase } });
    const r = await page.request.post("/api/llm/providers/volces/sync");
    expect(r.status()).toBe(200);
    const body = await r.json();
    expect(body.dryRun).toBeUndefined();
    expect(body.added).toEqual(["e2e-route-good"]);
    const volces = await getVolces(page);
    expect(volces.models).toContain("e2e-route-good");
    expect(volces.discovery["e2e-route-dark"].status).toBe("unauthorized");
    expect(volces.override.active).toBe(true);

    // Key and existence stay env-owned.
    const keyPut = await page.request.put("/api/llm/providers/volces", { data: { apiKey: "sk-nope" } });
    expect(keyPut.status()).toBe(400);
    const del = await page.request.delete("/api/llm/providers/volces");
    expect(del.status()).toBe(400);
  });

  test("guard: setting a dark default triggers the fallback toast and pointer switch", async ({ page }) => {
    // Route the lane at the mock, sync so both ids are classified, then point
    // the default at the dark id — the guard must correct it to the serving
    // one and toast the substitution.
    await page.request.put("/api/llm/providers/volces", { data: { baseUrl: mockBase } });
    const sync = await page.request.post("/api/llm/providers/volces/sync");
    expect(sync.status()).toBe(200);
    // Sync merges serving ids only, so the dark id is not selectable yet. Put
    // it on the roster by hand (the discovery map survives the models edit) —
    // the real-world shape: a lane that served when it was chosen and went
    // dark later.
    const rosterPut = await page.request.put("/api/llm/providers/volces", {
      data: { models: [{ id: "e2e-route-dark" }, { id: "e2e-route-good" }] },
    });
    expect(rosterPut.status()).toBe(200);

    await pinLocaleEn(page);
    await page.goto(PAGE_URL);
    await expect(page.getByTestId("llm-provider-card").first()).toBeVisible({ timeout: 15000 });

    const put = await page.request.put("/api/llm/default", { data: { modelId: "e2e-route-dark" } });
    expect(put.status()).toBe(200);

    await expect(page.getByTestId("toast")).toContainText("e2e-route-dark", { timeout: 10000 });
    await expect(page.getByTestId("toast")).toContainText("e2e-route-good");
    const def = await (await page.request.get("/api/llm/default")).json();
    expect(def.modelId).toBe("e2e-route-good");
  });

  test("contextWindow and maxTokens both travel in the editor's PUT", async ({ page }) => {
    // On a user provider (full editor parity): intercept the save request and
    // assert both per-entry limits are in the payload.
    const created = await page.request.post("/api/llm/providers", {
      data: { name: "E2E Route Override Aux", baseUrl: mockBase, apiKey: "sk-e2e-route" },
    });
    expect(created.status()).toBe(201);
    const provider = (await created.json()).provider;

    await pinLocaleEn(page);
    await page.goto(PAGE_URL);
    const card = page.getByTestId("llm-provider-card").filter({ hasText: "E2E Route Override Aux" });
    await expect(card).toBeVisible({ timeout: 15000 });

    await card.getByTestId("llm-edit-models-btn").click();
    const firstRow = card.locator('[data-testid="llm-model-editor"] li').first();
    await firstRow.getByTestId("llm-model-context-window").fill("64000");
    const maxTokens = firstRow.locator('input[id^="max-tokens"]');
    await maxTokens.fill("4096");

    const saveRequest = page.waitForRequest(
      (req) => req.method() === "PUT" && req.url().includes(`/api/llm/providers/${provider.id}`),
    );
    await card.getByTestId("llm-model-save").click();
    const req = await saveRequest;
    const payload = req.postDataJSON();
    expect(payload.models[0].contextWindow).toBe(64000);
    expect(payload.models[0].maxTokens).toBe(4096);

    await page.request.delete(`/api/llm/providers/${provider.id}`);
  });
});
