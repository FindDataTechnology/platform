// ── Pack marketplace e2e (add-pack-marketplace) ──────────────────────────────
//
// Drives the full subscriber + creator flows against the real cell: drafts,
// publish, browse/inspect, subscribe → materialization, conflict reporting,
// update badge + upgrade, and uninstall with the modified-skill warning.
//
// The GATEWAY plane (/api/packs... — market, publish, subscribe records) has
// no gateway in the hermetic webServer, so each spec route-mocks it with a
// small stateful stand-in: publish mutates the mock store, browse reads it.
// The gateway's own HTTP contract is covered for real by
// scripts/test-pack-marketplace.mjs against the booted gateway. Everything on
// the cell plane (/api/mypacks, /api/pack-drafts, /api/extensions/*) is real.

import { expect, test } from "@playwright/test";
import { openSettings } from "./helpers.js";

// The stateful gateway stand-in. Route handlers below read/write this.
function makeGatewayState() {
  return {
    packs: [],
    subscriptions: {},
  };
}

function installGatewayMock(page, state) {
  const json = (body, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });
  const summary = (p) => ({
    id: p.id,
    authorEmail: p.authorEmail,
    createdAt: p.createdAt,
    version: p.version,
    name: p.manifest.name,
    description: p.manifest.description || "",
    tags: p.manifest.tags || [],
    publishedAt: p.publishedAt,
  });

  return page.route("**/api/packs**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname;
    const method = req.method();

    if (method === "GET" && path === "/api/packs") {
      const search = url.searchParams.get("search") || "";
      const packs = state.packs
        .filter((p) => !p.unlisted)
        .filter((p) => !search || p.manifest.name.includes(search))
        .map(summary);
      return route.fulfill(json({ total: packs.length, page: 1, pageSize: 50, packs }));
    }
    if (method === "POST" && path === "/api/packs") {
      const body = req.postDataJSON();
      if (body.packId) {
        const p = state.packs.find((x) => x.id === body.packId);
        if (!p) return route.fulfill(json({ error: "Pack not found" }, 404));
        p.version += 1;
        p.manifest = body.manifest;
        p.publishedAt = Date.now();
        return route.fulfill(json({ id: p.id, version: p.version }));
      }
      const id = `pack-e2e-${state.packs.length + 1}`;
      state.packs.push({
        id,
        authorEmail: "creator@e2e.test",
        createdAt: Date.now(),
        publishedAt: Date.now(),
        version: 1,
        manifest: body.manifest,
      });
      return route.fulfill(json({ id, version: 1 }));
    }
    const detail = path.match(/^\/api\/packs\/([^/]+)$/);
    if (method === "GET" && detail) {
      const p = state.packs.find((x) => x.id === detail[1]);
      if (!p) return route.fulfill(json({ error: "Pack not found" }, 404));
      return route.fulfill(json({ ...summary(p), manifest: p.manifest }));
    }
    const sub = path.match(/^\/api\/packs\/([^/]+)\/subscribe$/);
    if (sub) {
      if (method === "POST") {
        const p = state.packs.find((x) => x.id === sub[1]);
        if (!p) return route.fulfill(json({ error: "Pack not found" }, 404));
        state.subscriptions[p.id] = p.version;
        return route.fulfill(json({ packId: p.id, version: p.version, manifest: p.manifest }));
      }
      if (method === "DELETE") {
        delete state.subscriptions[sub[1]];
        return route.fulfill(json({ ok: true }));
      }
    }
    return route.fulfill(json({ error: "unmocked gateway path" }, 500));
  });
}

const SKILL_V1 = "# v1\n按五阶段推进合同审查，不编造法条。";

// Per-test identities (see note above): unique skill/agent names and pack ids
// keep tests independent despite the shared server + SQLite.
function packManifest({ name, skillName, agentId, mcpName = "law-bench" }) {
  return {
    name,
    description: "合同审查工作流",
    tags: ["法律"],
    skills: [{ name: skillName, description: "五阶段合同审查", content: SKILL_V1 }],
    mcpServers: [{ registryName: mcpName }],
    agents: [{ id: agentId, name: `${name}审查官`, persona: "你是严谨的合同审查官。" }],
  };
}

test.beforeEach(async ({ page }) => {
  // Chinese-first product: pin the locale so copy assertions are stable.
  await page.addInitScript(() => localStorage.setItem("platform.locale", "zh-CN"));
});

// Install the gateway mock and return its state, so a test can seed the
// marketplace by direct mutation. (page.request bypasses page.route
// interception, so seeding over HTTP would miss the mock.)
function seedableGateway(page) {
  const state = makeGatewayState();
  return { state, install: () => installGatewayMock(page, state) };
}

function seedPack(state, manifest, id = "pack-e2e-1") {
  state.packs.push({
    id,
    authorEmail: "creator@e2e.test",
    createdAt: Date.now(),
    publishedAt: Date.now(),
    version: 1,
    manifest,
  });
}

async function gotoPacksTab(page, tab) {
  await openSettings(page, "packs");
  await expect(page.getByTestId("packs-page")).toBeVisible();
  await page.getByTestId(`packs-tab-${tab}`).click();
}

async function getSkills(page) {
  const r = await page.request.get("/api/extensions/skills");
  return (await r.json()).skills;
}

// ── Creator: draft → publish → next version ────────────────────────────────

test("creator drafts, publishes v1, then republishes v2", async ({ page }) => {
  const gw = seedableGateway(page);
  gw.install();
  await gotoPacksTab(page, "drafts");
  await page.getByTestId("pack-draft-create").click();
  await expect(page.getByTestId("pack-editor")).toBeVisible();

  await page.locator("#pack-name").fill("法律-合同");
  await page.locator("#pack-tags").fill("法律, 合同");
  await page.locator("#pack-desc").fill("合同审查工作流");

  await page.getByTestId("pack-skill-add").click();
  await page.getByTestId("pack-skill-entry-0").locator("input").nth(0).fill("creator-skill");
  await page.getByTestId("pack-skill-entry-0").locator("input").nth(1).fill("五阶段合同审查");
  await page.getByTestId("pack-skill-entry-0").locator("textarea").fill(SKILL_V1);

  await page.getByTestId("pack-agent-add").click();
  await page.getByTestId("pack-agent-entry-0").locator("input").nth(0).fill("pack-creator-reviewer");
  await page.getByTestId("pack-agent-entry-0").locator("input").nth(1).fill("合同审查官");
  await page.getByTestId("pack-agent-entry-0").locator("textarea").fill("你是严谨的合同审查官。");

  await page.getByTestId("pack-draft-publish").click();

  // Publishing auto-switches to the market, where the new pack is listed (the
  // mock store is stateful — the editor's publish went through it).
  await expect(page.getByTestId("pack-card-pack-e2e-1")).toContainText("法律-合同", { timeout: 10_000 });
  await expect(page.getByTestId("pack-card-pack-e2e-1")).toContainText("v1");

  // Edit and republish → v2 appended to the same pack (the draft carries the
  // published pack id, so the second publish targets it).
  await gotoPacksTab(page, "drafts");
  await page.locator('[data-testid^="pack-draft-item-"]').first().click();
  await expect(page.getByTestId("pack-editor")).toBeVisible();
  await page.getByTestId("pack-draft-publish").click();
  await expect(page.getByTestId("pack-card-pack-e2e-1")).toContainText("v2", { timeout: 10_000 });
});

// ── Creator: per-role resource declarations + persona cost (add-persona-
//    resource-sets tasks 4.3–4.4) ─────────────────────────────────────────────
test("per-role resource declarations round-trip through save/reload; cost readout is live", async ({ page }) => {
  const gw = seedableGateway(page);
  gw.install();
  await gotoPacksTab(page, "drafts");
  await page.getByTestId("pack-draft-create").click();
  await page.locator("#pack-name").fill("资源集包");

  // Two own skills + one registry MCP reference — the chip sources.
  for (const [i, name] of ["resource-skill-a", "resource-skill-b"].entries()) {
    await page.getByTestId("pack-skill-add").click();
    await page.getByTestId(`pack-skill-entry-${i}`).locator("input").nth(0).fill(name);
    await page.getByTestId(`pack-skill-entry-${i}`).locator("input").nth(1).fill("资源集技能");
    await page.getByTestId(`pack-skill-entry-${i}`).locator("textarea").fill("# c");
  }
  const mcpChip = page.getByTestId("pack-mcp-option-e2e-registry-mcp");
  if (await mcpChip.count()) await mcpChip.click();

  await page.getByTestId("pack-agent-add").click();
  await page.getByTestId("pack-agent-entry-0").locator("input").nth(0).fill("pack-resource-reviewer");
  await page.getByTestId("pack-agent-entry-0").locator("input").nth(1).fill("资源审查官");
  const persona = page.getByTestId("pack-agent-entry-0").locator("textarea");
  await persona.fill("你是资源审查官。");

  // Persona cost readout: current length, and it updates live while typing.
  const cost = page.getByTestId("pack-agent-cost-0");
  await expect(cost).toContainText("8 字符");
  await persona.fill("你是资源审查官，只审查资源子集。");
  await expect(cost).toContainText("16 字符");
  await expect(cost).toContainText("tokens/轮");

  // Mixed-dimension declaration: limit skills to A only (B unselected), keep
  // the MCP dimension on with the single own reference.
  const res = page.getByTestId("pack-agent-resources-0");
  await res.locator("summary").click();
  await page.getByTestId("pack-agent-resource-toggle-skills-0").check();
  await page.getByTestId("pack-agent-resource-chip-resource-skill-b").click(); // deselect B
  await expect(page.getByTestId("pack-agent-resource-chip-resource-skill-a")).toHaveClass(/bg-primary/);
  if (await mcpChip.count()) {
    await page.getByTestId("pack-agent-resource-toggle-mcp-0").check();
    await expect(page.getByTestId("pack-agent-resource-chip-e2e-registry-mcp")).toHaveClass(/bg-primary/);
  }

  // Round-trip: save → close → reopen; the declaration survives intact.
  const editor = page.getByTestId("pack-editor");
  await editor.getByRole("button", { name: "保存草稿" }).click();
  await editor.getByRole("button", { name: "关闭" }).click();
  await page.locator('[data-testid^="pack-draft-item-"]').filter({ hasText: "资源集包" }).first().click();
  await expect(page.getByTestId("pack-editor")).toBeVisible();
  await expect(page.getByTestId("pack-agent-resource-toggle-skills-0")).toBeChecked();
  await expect(page.getByTestId("pack-agent-resource-chip-resource-skill-a")).toHaveClass(/bg-primary/);
  await expect(page.getByTestId("pack-agent-resource-chip-resource-skill-b")).not.toHaveClass(/bg-primary/);

  // The declaration publishes with the manifest (mixed-dimension is legal).
  await page.getByTestId("pack-draft-publish").click();
  await expect(page.getByTestId("pack-card-pack-e2e-1")).toContainText("资源集包", { timeout: 10_000 });
});

// ── Subscriber: inspect → subscribe → materialize → report ──────────────────

test("subscriber inspects, subscribes, and the pack materializes", async ({ page }) => {
  const gw = seedableGateway(page);
  seedPack(
    gw.state,
    packManifest({ name: "订阅包", skillName: "sub-skill", agentId: "pack-sub-reviewer" }),
    "pack-sub",
  );
  gw.install();
  await gotoPacksTab(page, "market");
  const card = page.getByTestId("pack-card-pack-sub");
  await expect(card).toContainText("订阅包");
  await card.click();

  // Full inspection BEFORE subscribing: the skill body is visible.
  const detail = page.getByTestId("pack-detail");
  await expect(detail.getByTestId("pack-skill-sub-skill")).toContainText("五阶段");
  await expect(detail).toContainText("law-bench");

  await detail.getByTestId("pack-subscribe").click();
  const report = page.getByTestId("pack-install-report");
  await expect(report).toContainText("sub-skill");
  await report.getByRole("button").last().click(); // close

  // The skill is really in the cell's store (content-level checks live in the
  // unit suite; the listing route does not carry content).
  const skills = await getSkills(page);
  expect(skills.find((s) => s.name === "sub-skill")?.source).toBe("database");

  // My packs lists v1 with the pack's parts.
  await gotoPacksTab(page, "mine");
  const mine = page.getByTestId("my-pack-pack-sub");
  await expect(mine).toContainText("v1");
  await expect(mine).toContainText("订阅包审查官");
});

test("name collision with a user skill is skipped and reported, not overwritten", async ({ page }) => {
  // A user-created skill owns the name already.
  await page.request.post("/api/extensions/skills", {
    data: { name: "clash-skill", description: "user's own", content: "user content" },
  });
  const gw = seedableGateway(page);
  seedPack(
    gw.state,
    packManifest({ name: "冲突包", skillName: "clash-skill", agentId: "pack-clash-reviewer" }),
    "pack-clash",
  );
  gw.install();

  await gotoPacksTab(page, "market");
  await page.getByTestId("pack-card-pack-clash").click();
  await page.getByTestId("pack-detail").getByTestId("pack-subscribe").click();

  const report = page.getByTestId("pack-install-report");
  await expect(report).toContainText("已跳过");
  await expect(report).toContainText("not owned by this pack");

  // The user's skill row survives as theirs (origin "user"), and the agent
  // part of the pack still installed.
  const skills = await getSkills(page);
  expect(skills.find((s) => s.name === "clash-skill")?.origin).toBe("user");
});

// ── Updates and uninstall ────────────────────────────────────────────────────

test("update badge appears and upgrade is explicit", async ({ page }) => {
  const gw = seedableGateway(page);
  seedPack(
    gw.state,
    packManifest({ name: "升级包", skillName: "upgrade-skill", agentId: "pack-upgrade-reviewer" }),
    "pack-upgrade",
  );
  gw.install();
  await gotoPacksTab(page, "market");
  await page.getByTestId("pack-card-pack-upgrade").click();
  await page.getByTestId("pack-detail").getByTestId("pack-subscribe").click();
  await page.getByTestId("pack-install-report").getByRole("button").last().click();

  // The author publishes v2 with a changed skill.
  gw.state.packs[0].version = 2;

  await gotoPacksTab(page, "mine");
  await expect(page.getByTestId("pack-update-badge-pack-upgrade")).toContainText("v2");
  // Not upgraded yet: the installed row still reads v1.
  await expect(page.getByTestId("my-pack-pack-upgrade")).toContainText("v1");

  await page.getByTestId("pack-upgrade-pack-upgrade").click();
  await expect(page.getByTestId("my-pack-pack-upgrade")).toContainText("v2", { timeout: 10_000 });
});

test("uninstall warns on modified skills and keeps MCP configs", async ({ page }) => {
  const gw = seedableGateway(page);
  seedPack(
    gw.state,
    packManifest({ name: "退订包", skillName: "uninstall-skill", agentId: "pack-uninstall-reviewer" }),
    "pack-uninstall",
  );
  gw.install();
  await gotoPacksTab(page, "market");
  await page.getByTestId("pack-card-pack-uninstall").click();
  await page.getByTestId("pack-detail").getByTestId("pack-subscribe").click();
  await page.getByTestId("pack-install-report").getByRole("button").last().click();

  // The user edits the pack's skill after install.
  await page.request.put("/api/extensions/skills/uninstall-skill", {
    data: { content: "# 用户改过的" },
  });

  await gotoPacksTab(page, "mine");
  await page.getByTestId("pack-uninstall-pack-uninstall").click();
  const confirm = page.getByTestId("pack-uninstall-confirm");
  await expect(confirm).toBeVisible();
  await expect(confirm.getByTestId("pack-uninstall-modified")).toContainText("uninstall-skill");
  await expect(confirm).toContainText("law-bench"); // MCP kept note

  await confirm.getByRole("button", { name: /退订|Unsubscribe/ }).click();
  await expect(page.getByTestId("my-packs-section")).not.toContainText("退订包");
  expect((await getSkills(page)).find((s) => s.name === "uninstall-skill")).toBeUndefined();
});

// ── Registry-origin MCP: present server + live credential ───────────────────

test("registry MCP reference installs under the subscriber's own credential", async ({ page }) => {
  // Connect the market credential first (the paste-fallback API — the popup
  // flow has its own coverage in registry-connect.spec.js).
  const connect = await page.request.post("/api/registry/credential", {
    data: { token: "opaque-e2e-token", source: "paste" },
  });
  expect(connect.ok()).toBeTruthy();

  const gw = seedableGateway(page);
  seedPack(
    gw.state,
    packManifest({ name: "凭据包", skillName: "cred-skill", agentId: "pack-cred-reviewer", mcpName: "e2e-registry-mcp" }),
    "pack-cred",
  );
  gw.install();

  await gotoPacksTab(page, "market");
  await page.getByTestId("pack-card-pack-cred").click();
  await page.getByTestId("pack-detail").getByTestId("pack-subscribe").click();

  const report = page.getByTestId("pack-install-report");
  await expect(report).toContainText("e2e-registry-mcp");
  await expect(report).toContainText("已安装");

  // The server config is registry-shaped: credential reference, no secret.
  const servers = await page.request.get("/api/extensions/mcp").then((r) => r.json());
  const installed = servers.servers.find((s) => s.name === "e2e-registry-mcp");
  expect(installed?.config?.credentialRef).toBe("registry");
  expect(installed?.config?.headers).toBeUndefined();
});

// ── Single-process market plane wiring (fd-prod topology) ────────────────────

test("single-process deployment serves the real market plane behind the flag", async ({ page }) => {
  // NO gateway mock here: PACK_MARKETPLACE=1 makes server.js mount the real
  // /api/packs routes (auth off ⇒ the machine owner). The e2e store's packs.db
  // starts empty, so browse answers an empty listing — the wiring proof.
  const r = await page.request.get("/api/packs");
  expect(r.status()).toBe(200);
  const body = await r.json();
  expect(body).toHaveProperty("packs");
  expect(body).toHaveProperty("total");

  // The cell-side family answers on its namespace too.
  expect((await page.request.get("/api/mypacks")).status()).toBe(200);
  expect((await page.request.get("/api/pack-drafts")).status()).toBe(200);
});

// ── Local mode: no gateway flag, no pack surfaces (design D15) ───────────────

test("pack surfaces disappear when the deployment is not gateway-fronted", async ({ page }) => {
  await page.route("**/api/config", async (route) => {
    // Fetch the real config bypassing interception, flip the flag off.
    const real = await route.fetch();
    const config = await real.json();
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ...config, packMarketplace: false }),
    });
  });
  await page.goto("/settings/packs");
  await expect(page.getByTestId("packs-page")).not.toBeVisible();
  await expect(page.getByTestId("settings-section-packs")).toHaveCount(0);
});
