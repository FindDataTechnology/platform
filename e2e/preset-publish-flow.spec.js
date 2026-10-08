// ── Preset → publish → deploy one-click flow e2e (add-facet-platform S4.1) ───
//
// 壹座's "发布并部署" flow on the real cell: one action on a custom preset
// composes the draft through the server bridge, presents it for confirmation
// (name/description edited here), publishes, and — because the bridge composes
// the agent entry WITH a serving contract — offers deploy as the final step of
// the same dialog. The gateway plane (/api/packs...) is route-mocked with a
// small stateful stand-in (same pattern as packs.spec.js): the deploy request
// is asserted server-contract style from the mock's recorded call — agent key
// paste included, descriptor body shaped per the deploy contract.
//
// The failure case (publish 403) proves the flow stops with the failing step
// named and no later step runs (no deploy is attempted, nothing published).

import { expect, test } from "@playwright/test";

const USER_SKILL = "flow-pack-skill-e2e";

function gatewayState() {
  return { seq: 0, packs: [], deploys: [], publishDenied: false };
}

function installGatewayMock(page, state) {
  const json = (body, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });
  return page.route("**/api/packs**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname;
    const method = req.method();

    if (method === "POST" && path === "/api/packs") {
      if (state.publishDenied) return route.fulfill(json({ error: "Pack author or creator group required" }, 403));
      const body = req.postDataJSON();
      const id = `pack-flow-${++state.seq}`;
      state.packs.push({ id, version: 1, manifest: body.manifest });
      return route.fulfill(json({ id, version: 1 }));
    }
    if (method === "GET" && path === "/api/packs/billing/me") {
      return route.fulfill(json({ linked: true, balance: 10, accountState: "ok", panelUrl: "https://panel.example.test" }));
    }
    if (method === "GET" && /^\/api\/packs\/[^/]+\/billing-bindings$/.test(path)) {
      return route.fulfill(json({}));
    }
    const dep = path.match(/^\/api\/packs\/([^/]+)\/versions\/(\d+)\/deploy$/);
    if (method === "POST" && dep) {
      state.deploys.push({ packId: dep[1], version: Number(dep[2]), body: req.postDataJSON() });
      return route.fulfill(
        json({
          deployed: [{ agentId: "flow-agent", agentPath: `packs/${dep[1]}/flow-agent`, skills: [] }],
          billing: { linked: true },
          effectiveWithinSecs: 300,
        }),
      );
    }
    return route.fulfill(json({ error: `unmocked gateway path: ${method} ${path}` }, 500));
  });
}

async function createPreset(page) {
  const r = await page.request.post("/api/agent/presets", {
    data: {
      name: "Flow E2E",
      persona: "你是流转测试的角色。",
      skills: [USER_SKILL],
      mcpServers: [],
      tags: ["流转"],
    },
    timeout: 90_000,
  });
  expect(r.ok(), await r.text()).toBeTruthy();
  return (await r.json()).preset;
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("platform.locale", "zh-CN"));
});

test.afterEach(async ({ page }) => {
  // Cell-plane state this spec created (the gateway mock dies with the page).
  const roster = await page.request.get("/api/agent/presets").then((r) => r.json());
  for (const row of roster?.presets ?? []) {
    await page.request.delete(`/api/agent/presets/${row.id}`, { timeout: 90_000 }).catch(() => {});
  }
  const drafts = await page.request.get("/api/pack-drafts").then((r) => r.json());
  for (const d of drafts?.drafts ?? []) {
    await page.request.delete(`/api/pack-drafts/${d.id}`).catch(() => {});
  }
  await page.request.delete(`/api/extensions/skills/${USER_SKILL}`).catch(() => {});
});

test("one action takes a preset to a published pack and deploys it", async ({ page }) => {
  test.setTimeout(180_000);
  const state = gatewayState();
  await installGatewayMock(page, state);
  const skill = await page.request.post("/api/extensions/skills", {
    data: { name: USER_SKILL, description: "流转技能", content: "# 流转。\n正文。" },
  });
  expect(skill.ok(), await skill.text()).toBeTruthy();
  const preset = await createPreset(page);

  await page.goto("/settings/presets");
  await expect(page.getByTestId("custom-presets-page")).toBeVisible({ timeout: 15_000 });
  await page.getByTestId(`preset-publish-${preset.id}`).click();

  // Step 1/2 — composed draft presented for confirmation.
  const nameInput = page.getByTestId("preset-publish-name");
  await expect(nameInput).toHaveValue("Flow E2E", { timeout: 15_000 });
  await expect(page.getByTestId("preset-publish-parts")).toContainText("1 个技能");
  await nameInput.fill("Flow Pack E2E");
  await page.getByTestId("preset-publish-desc").fill("一键流发布的功能集");

  // Step 3 — publish; the flow moves to the published pane in the same dialog.
  await page.getByTestId("preset-publish-submit").click();
  await expect(page.getByTestId("preset-publish-done")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("preset-publish-done")).toContainText("v1");
  expect(state.packs).toHaveLength(1);
  expect(state.packs[0].manifest.name).toBe("Flow Pack E2E");
  expect(state.packs[0].manifest.description).toBe("一键流发布的功能集");
  expect(state.packs[0].manifest.agents[0].serving).toEqual({ protocol: "a2a" });

  // Step 4 — serving contract present ⇒ deploy offered in the same flow.
  const deploySection = page.getByTestId("preset-publish-deploy");
  await expect(deploySection).toBeVisible();
  const keyInput = page.locator('[data-testid^="preset-publish-key-input-"]');
  await expect(keyInput).toBeVisible({ timeout: 15_000 });
  await keyInput.fill("sk-e2e-flow-key");
  await page.getByTestId("preset-publish-deploy-btn").click();
  await expect(page.getByTestId("preset-publish-deploy-note")).toContainText("5", { timeout: 15_000 });

  // The deploy request hit the gateway contract: right pack+version, the
  // pasted key under the serving agent's id, no key value elsewhere.
  expect(state.deploys).toHaveLength(1);
  expect(state.deploys[0].packId).toBe(state.packs[0].id);
  expect(state.deploys[0].version).toBe(1);
  const keys = state.deploys[0].body.billingKeys;
  expect(Object.values(keys)).toEqual(["sk-e2e-flow-key"]);

  // The converted draft is marked as published (the drafts list stays coherent).
  const drafts = await page.request.get("/api/pack-drafts").then((r) => r.json());
  const draft = drafts.drafts.find((d) => d.name === "Flow Pack E2E");
  expect(draft.publishedPackId).toBe(state.packs[0].id);
});

test("publish failure stops the flow with the failing step named", async ({ page }) => {
  test.setTimeout(180_000);
  const state = gatewayState();
  state.publishDenied = true; // e.g. no creator membership → gateway 403
  await installGatewayMock(page, state);
  const skill = await page.request.post("/api/extensions/skills", {
    data: { name: USER_SKILL, description: "流转技能", content: "# 流转。\n正文。" },
  });
  expect(skill.ok(), await skill.text()).toBeTruthy();
  const preset = await createPreset(page);

  await page.goto("/settings/presets");
  await expect(page.getByTestId("custom-presets-page")).toBeVisible({ timeout: 15_000 });
  await page.getByTestId(`preset-publish-${preset.id}`).click();
  await expect(page.getByTestId("preset-publish-name")).toHaveValue("Flow E2E", { timeout: 15_000 });
  await page.getByTestId("preset-publish-submit").click();

  // The error names the failing step and says why; no later step ran.
  const err = page.getByTestId("preset-publish-error");
  await expect(err).toBeVisible({ timeout: 15_000 });
  await expect(err).toContainText("发布失败");
  await expect(err).toContainText("创作者");
  await expect(page.getByTestId("preset-publish-done")).toHaveCount(0);
  await expect(page.getByTestId("preset-publish-deploy")).toHaveCount(0);
  expect(state.packs).toHaveLength(0);
  expect(state.deploys).toHaveLength(0);

  // The composed draft survives for the editor path — nothing was lost.
  const drafts = await page.request.get("/api/pack-drafts").then((r) => r.json());
  expect(drafts.drafts.some((d) => d.name === "Flow E2E")).toBe(true);
});