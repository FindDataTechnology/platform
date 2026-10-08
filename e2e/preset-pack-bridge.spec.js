// ── Preset → pack-draft bridge e2e (add-preset-to-pack-bridge) ────────────────
//
// The bridge walkthrough on the real cell: converting an all-migratable preset
// through the 自建预设 page's action lands in the pack editor with the
// converted draft open — skills inlined with bodies, the market-matched server
// carried as a registry reference, persona verbatim, the A2A serving contract
// pre-checked, no banner. Converting a mixed preset (a foreign pack's skill, a
// local-origin server) carries neither and shows the pending-replacement
// report instead. The preset rows survive both conversions untouched.
//
// The registry-origin server arrives the proven way: a helper pack declares
// the registry MCP reference and its install lands the extension. The 403 gate
// branch is covered 1:1 in scripts/test-preset-pack-bridge.mjs (the hermetic
// suite runs auth-off — machine owner — so no non-owner identity exists here).

import { test, expect } from "@playwright/test";

const PACK_ID = "bridge-e2e-pack";
const PACK_SKILL = "bridge-pack-skill-e2e";
const USER_SKILL = "bridge-user-skill-e2e";
const REGISTRY_REF = "e2e-registry-mcp";
const LOCAL_SERVER = "bridge-local-server-e2e";

test.describe.configure({ mode: "serial" });

async function connectRegistry(page) {
  const connect = await page.request.post("/api/registry/credential", {
    data: { token: "opaque-e2e-token", source: "paste" },
  });
  expect(connect.ok(), await connect.text()).toBeTruthy();
}

async function installHelperPack(page) {
  const manifest = {
    name: "桥接助手包",
    description: "preset-pack-bridge e2e",
    skills: [{ name: PACK_SKILL, description: "外来的", content: "# 外来技能。\n" }],
    mcpServers: [{ registryName: REGISTRY_REF }],
    agents: [],
  };
  const r = await page.request.post("/api/mypacks/install", {
    data: { packId: PACK_ID, version: 1, manifest },
  });
  expect(r.ok(), await r.text()).toBeTruthy();
  return r.json();
}

async function createPresetApi(page, body) {
  const r = await page.request.post("/api/agent/presets", { data: body, timeout: 90_000 });
  expect(r.ok(), await r.text()).toBeTruthy();
  return (await r.json()).preset;
}

async function drafts(page) {
  return (await page.request.get("/api/pack-drafts").then((r) => r.json())).drafts ?? [];
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("platform.locale", "zh-CN"));
});

test.afterEach(async ({ page }) => {
  // The roster and the draft store are shared state — clean what this spec made.
  const roster = await page.request.get("/api/agent/presets").then((r) => r.json());
  for (const row of roster?.presets ?? []) {
    await page.request.delete(`/api/agent/presets/${row.id}`, { timeout: 90_000 }).catch(() => {});
  }
  for (const d of await drafts(page)) {
    await page.request.delete(`/api/pack-drafts/${d.id}`).catch(() => {});
  }
  await page.request.delete(`/api/mypacks/${PACK_ID}?force=1`).catch(() => {});
  await page.request.delete(`/api/extensions/mcp/${LOCAL_SERVER}`).catch(() => {});
  await page.request.delete(`/api/extensions/skills/${USER_SKILL}`).catch(() => {});
});

test("all-migratable preset converts clean through the page action", async ({ page }) => {
  test.setTimeout(180_000);
  await connectRegistry(page);
  await installHelperPack(page);
  const skill = await page.request.post("/api/extensions/skills", {
    data: { name: USER_SKILL, description: "自有技能", content: "# 自有。\n正文。" },
  });
  expect(skill.ok(), await skill.text()).toBeTruthy();
  await createPresetApi(page, {
    name: "Bridge Clean",
    persona: "你是可整体迁移的角色。",
    skills: [USER_SKILL],
    mcpServers: [REGISTRY_REF],
    tags: ["桥接"],
  });

  await page.goto("/settings/presets");
  await expect(page.getByTestId("custom-presets-page")).toBeVisible({ timeout: 15_000 });
  await page.getByTestId("preset-to-pack-user.bridge-clean").click();

  // Landed in the pack editor with the converted draft open — no banner
  // (nothing pending), serving pre-checked, persona verbatim.
  await expect(page.getByTestId("packs-tab-drafts")).toHaveClass(/border-primary/);
  const editor = page.getByTestId("pack-editor");
  await expect(editor).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("pack-bridge-report")).toHaveCount(0);
  const agentEntry = page.getByTestId("pack-agent-entry-0");
  await expect(agentEntry.locator("textarea")).toHaveValue("你是可整体迁移的角色。");
  await expect(agentEntry.locator("input").nth(1)).toHaveValue("Bridge Clean");
  await expect(page.getByTestId("pack-agent-serving-toggle-0").locator("input")).toBeChecked();

  // The stored draft: skill inlined with its body, server carried as the
  // registry reference, agent entry with serving preset and a legal id.
  const list = await drafts(page);
  const draft = list.find((d) => d.name === "Bridge Clean");
  expect(draft).toBeTruthy();
  expect(draft.entries.skills).toEqual([
    { name: USER_SKILL, description: "自有技能", content: "# 自有。\n正文。" },
  ]);
  expect(draft.entries.mcpServers).toEqual([{ registryName: REGISTRY_REF }]);
  const [agent] = draft.entries.agents;
  expect(agent.name).toBe("Bridge Clean");
  expect(agent.persona).toBe("你是可整体迁移的角色。");
  expect(agent.serving).toEqual({ protocol: "a2a" });
  expect(agent.id).toMatch(/^[A-Za-z0-9._-]{1,64}$/);
  expect(agent.id.startsWith("user.")).toBe(false);

  // The preset row is untouched — still listed, still cell-local.
  const roster = await page.request.get("/api/agent/presets").then((r) => r.json());
  expect(roster.presets.some((p) => p.id === "user.bridge-clean")).toBe(true);
});

test("a mixed preset converts with the pending-replacement report", async ({ page }) => {
  test.setTimeout(180_000);
  await connectRegistry(page);
  await installHelperPack(page);
  const local = await page.request.post("/api/extensions/mcp", {
    data: { name: LOCAL_SERVER, config: { url: "http://127.0.0.1:9/mcp" }, enabled: true },
  });
  expect(local.ok(), await local.text()).toBeTruthy();
  await createPresetApi(page, {
    name: "Bridge Mixed",
    persona: "你是带不可迁移引用的角色。",
    skills: [PACK_SKILL],
    mcpServers: [LOCAL_SERVER],
  });

  await page.goto("/settings/presets");
  await expect(page.getByTestId("custom-presets-page")).toBeVisible({ timeout: 15_000 });
  await page.getByTestId("preset-to-pack-user.bridge-mixed").click();

  await expect(page.getByTestId("pack-editor")).toBeVisible({ timeout: 15_000 });
  // The report names the foreign skill's owning pack and the unmatched server.
  const report = page.getByTestId("pack-bridge-report");
  await expect(report).toBeVisible();
  await expect(report.getByTestId(`pack-bridge-pending-skill-${PACK_SKILL}`)).toContainText(PACK_ID);
  await expect(report.getByTestId(`pack-bridge-pending-server-${LOCAL_SERVER}`)).toBeVisible();

  // Neither reference was carried into the stored draft.
  const list = await drafts(page);
  const draft = list.find((d) => d.name === "Bridge Mixed");
  expect(draft.entries.skills).toEqual([]);
  expect(draft.entries.mcpServers).toEqual([]);
  expect(draft.entries.agents[0].serving).toEqual({ protocol: "a2a" });

  // A plain revisit of the editor shows no banner — the report is one-shot
  // (leave the section entirely so the page state remounts).
  await page.goto("/chat/");
  await page.goto("/settings/packs");
  await page.getByTestId("packs-tab-drafts").click();
  await page.getByTestId(`pack-draft-item-${draft.id}`).click();
  await expect(page.getByTestId("pack-editor")).toBeVisible();
  await expect(page.getByTestId("pack-bridge-report")).toHaveCount(0);
});
