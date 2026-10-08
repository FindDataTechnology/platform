import { test, expect } from "@playwright/test";
import http from "node:http";
import { pinLocaleEn } from "./helpers.js";

// Model sync + runtime roster editing (add-llm-model-discovery). The provider
// points at a spec-owned mock gateway so classification is deterministic:
// one serving id, one upstream-down id. Auth is off in the harness, so admin
// actions are open (the same ctx.requireAdmin semantics as provider CRUD).
// Self-cleaning: the provider created here is deleted at the end.

const PAGE_URL = "/models";
const PROVIDER_NAME = "E2E Sync Provider";

// Mock gateway state the spec can flip per test.
const mock = {
  port: 0,
  delayMs: 0, // slow the model-list fetch to widen the sync-in-flight window
  serving: ["e2e-good-model"],
  dead: ["e2e-dead-model"],
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
      const later = (fn) => setTimeout(fn, mock.delayMs);
      if (req.method === "GET" && req.url === "/v1/models") {
        return later(() =>
          reply(200, { data: [...mock.serving, ...mock.dead].map((id) => ({ id })) }),
        );
      }
      if (req.method === "POST" && req.url === "/v1/chat/completions") {
        const model = JSON.parse(Buffer.concat(chunks).toString()).model;
        if (mock.serving.includes(model)) {
          return reply(200, { choices: [{ message: { content: "ok" }, finish_reason: "stop" }] });
        }
        return reply(503, { error: { message: "Upstream service temporarily unavailable" } });
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
  mockBase = `http://127.0.0.1:${mock.port}/v1`;
});

test.afterAll(() => mockServer.close());

async function createProvider(page) {
  const r = await page.request.post("/api/llm/providers", {
    data: { name: PROVIDER_NAME, baseUrl: mockBase, apiKey: "sk-e2e-sync" },
  });
  expect(r.status()).toBe(201);
  return (await r.json()).provider;
}

async function cleanupProvider(page) {
  const list = await page.request.get("/api/llm/providers");
  if (!list.ok()) return;
  const body = await list.json();
  const match = (body.providers || []).find((p) => p.name === PROVIDER_NAME);
  if (match && !match.reserved) await page.request.delete(`/api/llm/providers/${match.id}`);
}

async function findProvider(page) {
  const body = await (await page.request.get("/api/llm/providers")).json();
  return (body.providers || []).find((p) => p.name === PROVIDER_NAME) || null;
}

test.describe("Model sync", () => {
  test.afterEach(async ({ page }) => {
    mock.delayMs = 0;
    await cleanupProvider(page);
  });

  test("sync classifies, merges serving ids, and renders status chips + roster flag", async ({ page }) => {
    await createProvider(page);
    // Pre-seed the dead id onto the roster: after sync it must survive flagged
    // (never evicted) while the serving id is appended.
    const provider = await findProvider(page);
    await page.request.put(`/api/llm/providers/${provider.id}`, {
      data: { models: [{ id: "e2e-dead-model" }] },
    });

    await pinLocaleEn(page);
    await page.goto(PAGE_URL);
    const card = page.getByTestId("llm-provider-card").filter({ hasText: PROVIDER_NAME });
    await expect(card).toBeVisible({ timeout: 15000 });

    await card.getByTestId("llm-sync-btn").click();
    // Serving id lands on the roster with a green serving chip.
    const servingRow = card.locator('[data-testid="llm-model-list"] li').filter({ hasText: "e2e-good-model" });
    await expect(servingRow).toBeVisible({ timeout: 15000 });
    await expect(servingRow.getByTestId("llm-status-serving")).toBeVisible();
    // The dead roster id is flagged, not evicted.
    const deadRow = card.locator('[data-testid="llm-model-list"] li').filter({ hasText: "e2e-dead-model" });
    await expect(deadRow).toBeVisible();
    await expect(deadRow.getByTestId("llm-status-flagged")).toHaveAttribute("data-status", "upstream_down");

    // The persisted record: discovery map present, roster merged, no key leak.
    const after = await findProvider(page);
    expect(after.models).toEqual(expect.arrayContaining(["e2e-dead-model", "e2e-good-model"]));
    expect(after.discovery["e2e-good-model"].status).toBe("serving");
    expect(after.discovery["e2e-dead-model"].status).toBe("upstream_down");
    const raw = await (await page.request.get("/api/llm/providers")).text();
    expect(raw).not.toContain("sk-e2e-sync");
  });

  test("a second concurrent sync is rejected with 409", async ({ page }) => {
    await createProvider(page);
    mock.delayMs = 600; // hold the classification phase open
    const provider = await findProvider(page);
    const [r1, r2] = await Promise.all([
      page.request.post(`/api/llm/providers/${provider.id}/sync`),
      page.request.post(`/api/llm/providers/${provider.id}/sync`),
    ]);
    const statuses = [r1.status(), r2.status()].sort();
    expect(statuses).toEqual([200, 409]);
    const busy = [r1, r2].find((r) => r.status() === 409);
    expect((await busy.json()).code).toBe("busy");
  });

  test("PUT models replaces the roster live; invalid payloads are rejected", async ({ page }) => {
    await createProvider(page);
    const provider = await findProvider(page);

    const ok = await page.request.put(`/api/llm/providers/${provider.id}`, {
      data: { models: [{ id: "added-via-put" }, { id: "deepseek-v4.1-flash", maxTokens: 32768 }] },
    });
    expect(ok.status()).toBe(200);
    const updated = await findProvider(page);
    expect(updated.models).toEqual(["added-via-put", "deepseek-v4.1-flash"]);

    for (const bad of [{ models: "nope" }, { models: [{ id: "x" }, { id: "x" }] }, { models: [{ id: "" }] }]) {
      const r = await page.request.put(`/api/llm/providers/${provider.id}`, { data: bad });
      expect(r.status()).toBe(400);
    }
    const unchanged = await findProvider(page);
    expect(unchanged.models).toEqual(["added-via-put", "deepseek-v4.1-flash"]);
  });

  test("model-list editor adds and removes ids through the UI", async ({ page }) => {
    await createProvider(page);
    await pinLocaleEn(page);
    await page.goto(PAGE_URL);
    const card = page.getByTestId("llm-provider-card").filter({ hasText: PROVIDER_NAME });
    await expect(card).toBeVisible({ timeout: 15000 });

    // Add an id via the editor.
    await card.getByTestId("llm-edit-models-btn").click();
    await card.getByTestId("llm-model-add-id").fill("editor-added-model");
    await card.getByTestId("llm-model-add-btn").click();
    await card.getByTestId("llm-model-save").click();
    await expect(
      card.getByTestId("llm-model-list").locator("li").filter({ hasText: "editor-added-model" }),
    ).toBeVisible({ timeout: 10000 });
    const withAdded = await findProvider(page);
    expect(withAdded.models).toContain("editor-added-model");

    // Remove it again — the roster restores prior state.
    await card.getByTestId("llm-edit-models-btn").click();
    await card
      .locator('[data-testid="llm-model-editor"] li')
      .filter({ hasText: "editor-added-model" })
      .getByTestId("llm-model-remove")
      .click();
    await card.getByTestId("llm-model-save").click();
    await expect(
      card.getByTestId("llm-model-list").locator("li").filter({ hasText: "editor-added-model" }),
    ).toHaveCount(0, { timeout: 10000 });
    const restored = await findProvider(page);
    expect(restored.models).not.toContain("editor-added-model");
  });

  test("reserved volces card is editable but not deletable", async ({ page }) => {
    // add-editable-llm-route: the reserved card offers the roster editor and
    // the base-URL override bar, never Delete or a key field (the lane is
    // env-owned). Roster-edit persistence itself is covered in
    // llm-route-override.spec.js.
    await pinLocaleEn(page);
    await page.goto(PAGE_URL);
    await expect(page.getByTestId("models-page")).toBeVisible({ timeout: 15000 });
    const volces = page.locator('[data-testid="llm-provider-card"][data-provider-id="volces"]');
    await volces.first().waitFor({ state: "visible", timeout: 10000 }).catch(() => {});
    test.skip((await volces.count()) === 0, "no env Volces route in this run");
    await expect(volces.getByTestId("llm-edit-models-btn")).toBeVisible();
    await expect(volces.getByTestId("llm-override-input")).toBeVisible();
    await expect(volces.getByTestId("llm-delete-btn")).toHaveCount(0);
  });
});
