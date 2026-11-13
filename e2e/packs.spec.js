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
//
// Since pack-install-server-side-manifest the install fetch is SERVER-side:
// the browser mock covers browse/detail/subscribe, while the manifest the
// cell retrieves comes from the facet stand-in (e2e/facet-stub.js, reached
// over FACET_BASE_URL). seedPackBoth seeds the two planes in one call so the
// pack a user sees is the pack the server can retrieve.

import { expect, test } from "@playwright/test";
import {
  facetSeen,
  lastFacetViewer,
  pinLocaleEn,
  resetFacetStub,
  restoreStandardPreset,
  seedFacetPack,
} from "./helpers.js";

// Subscribing a pack that ships an agent makes that agent the runtime's current
// preset (the "subscriber inspects, subscribes…" test below subscribes
// agentId pack-sub-reviewer), and the preset is deployment-global: it survives
// this file. A pack role is FOCUSED, so every later file then reads a narrowed
// MCP patch, and a spec that expects a baseline server fails for a reason it
// cannot express — measured 2026-11-13, this file alone turned
// websearch.spec.js:223 and :241 red (2 failed / 32 passed). Restore the
// built-in preset after each test; the helper is a no-op when it is already
// standard, so this costs one WS round-trip per test.
test.afterEach(async ({ page }) => {
  await restoreStandardPreset(page);
});

// The stateful gateway stand-in. Route handlers below read/write this.
function makeGatewayState() {
  return {
    packs: [],
    subscriptions: {},
  };
}

function installGatewayMock(page, state) {
  const json = (body, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });
  // `agentCount` mirrors the server's projection (latest version's manifest
  // agents). Absent-means-unknown is the same discipline the server keeps for
  // rows its SQL never projected, so a manifest declaring no agents keeps the
  // pre-change summary shape and the agent-size filter passes it through.
  const summary = (p) => ({
    id: p.id,
    authorEmail: p.authorEmail,
    createdAt: p.createdAt,
    version: p.version,
    name: p.manifest.name,
    description: p.manifest.description || "",
    tags: p.manifest.tags || [],
    publishedAt: p.publishedAt,
    ...(p.manifest.agents?.length ? { agentCount: p.manifest.agents.length } : {}),
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
    // Facets for the author editor's vocabulary pickers (P3 4.8) — a fixed
    // controlled set the test can assert chips against; browse strips are
    // not asserted through this mock.
    if (method === "GET" && path === "/api/packs/facets") {
      const vocabulary = state.facetsVocabulary ?? [
        { slug: "legal", label: "法务" },
        { slug: "investing", label: "投研" },
        { slug: "risk", label: "风控" },
        { slug: "knowledge", label: "知识库" },
      ];
      return route.fulfill(
        json({
          lines: [
            { slug: "base", word: "壹座 · 智能体团队", label: "壹座 · 智能体团队", count: 0 },
            { slug: "lex", word: "识律 · 法律智能", label: "识律 · 法律智能", count: 0 },
            { slug: "wire", word: "柏讯 · 数据与情报", label: "柏讯 · 数据与情报", count: 0 },
            { slug: "facet", word: "谦面 · 业务流", label: "谦面 · 业务流", count: 0 },
            { slug: "constellation", word: "萬星 · 智能体连接", label: "萬星 · 智能体连接", count: 0 },
          ],
          domains: vocabulary.map((v) => ({ ...v, count: 0 })),
          vocabulary,
        }),
      );
    }
    // Coverage read for the workbench (P3 4.7): a STUB — the real denominator
    // is the server's module (scripts/test-pack-display-projection pins it);
    // the mock returns a fixed verdict or the test-set state.coverage.
    if (method === "POST" && path === "/api/packs/coverage") {
      return route.fulfill(
        json({ coverage: state.coverage ?? { locale: "en", total: 4, covered: 2, missing: ["description", "tags"] } }),
      );
    }
    if (method === "POST" && path === "/api/packs") {
      // 4.9 official en-coverage gate: when the test arms it, publish answers
      // the server's structured 422 (verbatim-body posture) instead of storing.
      if (state.publishGate) return route.fulfill(json(state.publishGate, 422));
      const body = req.postDataJSON();
      if (body.packId) {
        const p = state.packs.find((x) => x.id === body.packId);
        if (!p) return route.fulfill(json({ error: "Pack not found" }, 404));
        p.version += 1;
        p.manifest = body.manifest;
        p.publishedAt = Date.now();
        p.versionHistory.push({ version: p.version, publishedAt: p.publishedAt, manifest: body.manifest });
        return route.fulfill(json({ id: p.id, version: p.version }));
      }
      const id = `pack-e2e-${state.packs.length + 1}`;
      const publishedAt = Date.now();
      state.packs.push({
        id,
        authorEmail: "creator@e2e.test",
        createdAt: publishedAt,
        publishedAt,
        version: 1,
        manifest: body.manifest,
        versionHistory: [{ version: 1, publishedAt, manifest: body.manifest }],
      });
      return route.fulfill(json({ id, version: 1 }));
    }
    const detail = path.match(/^\/api\/packs\/([^/]+)$/);
    if (method === "GET" && detail) {
      const p = state.packs.find((x) => x.id === detail[1]);
      if (!p) return route.fulfill(json({ error: "Pack not found" }, 404));
      return route.fulfill(json({ ...summary(p), manifest: p.manifest }));
    }
    // Version history (add-facet-version-history): the gateway extracts each
    // version's note inline from its stored manifest — the mock mirrors that.
    const versions = path.match(/^\/api\/packs\/([^/]+)\/versions$/);
    if (method === "GET" && versions) {
      const p = state.packs.find((x) => x.id === versions[1]);
      if (!p) return route.fulfill(json({ error: "Pack not found" }, 404));
      const rows = (p.versionHistory ?? [])
        .slice()
        .sort((a, b) => b.version - a.version)
        .map((v) => ({
          version: v.version,
          publishedAt: v.publishedAt,
          authorEmail: p.authorEmail,
          ...(typeof v.manifest?.notes === "string" ? { notes: v.manifest.notes } : {}),
        }));
      return route.fulfill(json({ versions: rows }));
    }
    const versionDoc = path.match(/^\/api\/packs\/([^/]+)\/versions\/(\d+)$/);
    if (method === "GET" && versionDoc) {
      const p = state.packs.find((x) => x.id === versionDoc[1]);
      if (!p) return route.fulfill(json({ error: "Pack not found" }, 404));
      const wanted = Number(versionDoc[2]);
      const row = (p.versionHistory ?? []).find((v) => v.version === wanted);
      if (!row) return route.fulfill(json({ error: "Pack version not found" }, 404));
      return route.fulfill(json({ id: p.id, version: wanted, manifest: row.manifest }));
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
  // The facet stand-in is shared state across specs: start every test clean.
  await resetFacetStub();
});

// Install the gateway mock and return its state, so a test can seed the
// marketplace by direct mutation. (page.request bypasses page.route
// interception, so seeding over HTTP would miss the mock.)
function seedableGateway(page) {
  const state = makeGatewayState();
  return { state, install: () => installGatewayMock(page, state) };
}

function seedPack(state, manifest, id = "pack-e2e-1") {
  const publishedAt = Date.now();
  state.packs.push({
    id,
    authorEmail: "creator@e2e.test",
    createdAt: publishedAt,
    publishedAt,
    version: 1,
    manifest,
    versionHistory: [{ version: 1, publishedAt, manifest }],
  });
}

// Seed BOTH market planes for one pack: the browser mock (browse/detail/
// subscribe) and the facet stub (the server-side manifest fetch). Everything
// a UI install needs.
async function seedPackBoth(gw, manifest, id = "pack-e2e-1", facet = {}) {
  seedPack(gw.state, manifest, id);
  const version = gw.state.packs.find((p) => p.id === id).version;
  await seedFacetPack(id, version, manifest, facet);
}

async function gotoPacksTab(page, tab) {
  // Route history, so this helper stops being rewritten every IA move:
  // the surface left Settings (simplify-ia-non-technical) for the agents
  // page's Market tab, then the W2 teardown dissolved that four-zone hub —
  // /agents is now the agent-market façade (AgentMarketPage: an external
  // deep link plus the installed-packs panel) and PacksPage is mounted at
  // /packs, restored as the deployTeam deep-link target
  // (add-supply-studio-migration 5.2). The market BROWSING half lives in the
  // supply domain (facet) now; what stays testable here is the runtime half
  // plus the creator/wizard surfaces, which is what this file drives.
  await pinLocaleEn(page);
  await page.goto("/packs");
  await expect(page.getByTestId("agent-market-page")).toBeVisible({ timeout: 15_000 });
  // `market` is a RETIRED slug: the page normalizes it to `agents` and writes
  // that back to the URL (agent-catalog: market → agents), so no
  // `agent-market-tab-market` element has existed since unify-material-market.
  // Every caller still passing "market" was clicking a tab that cannot render.
  // Normalize here, where the helper already owns the tab vocabulary.
  const slug = tab === "market" ? "agents" : tab;
  await page.getByTestId(`agent-market-tab-${slug}`).click();
}

async function getSkills(page) {
  const r = await page.request.get("/api/extensions/skills");
  return (await r.json()).skills;
}

// ── Creator: draft → publish → next version ────────────────────────────────

test("creator drafts, publishes v1, then republishes v2", async ({ page }) => {
  const gw = seedableGateway(page);
  gw.install();
  await gotoPacksTab(page, "mine");
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
  await gotoPacksTab(page, "mine");
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
  await gotoPacksTab(page, "mine");
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
  const hasMcpChip = (await mcpChip.count()) > 0;
  if (hasMcpChip) {
    await mcpChip.click();
    // Publish requires an explicit tool face (pack-tool-declaration-gate):
    // this test is about the resource-set dimension, so mark the reference
    // full-surface rather than picking tools.
    await page.getByTestId("pack-mcp-full-toggle-e2e-registry-mcp").check();
    await page.getByTestId("pack-mcp-full-reason-e2e-registry-mcp").fill("资源集用例：整面引用");
  }

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
  if (hasMcpChip) {
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
  await seedPackBoth(
    gw,
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

  // Raw download surface (add-facet-platform 4.4): the skill-md route and the
  // version manifest stay linkable — editors/scripts consume exactly these.
  await expect(detail.getByTestId("pack-skill-download-sub-skill")).toHaveAttribute(
    "href",
    "/api/packs/pack-sub/versions/1/skills/sub-skill.md",
  );
  await expect(detail.getByTestId("pack-manifest-link")).toHaveAttribute("href", "/api/packs/pack-sub/versions/1");

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

// ── Market: agent-count bucket filter (marketplace-cluster-view) ────────────
//
// optimize-paas-module-audit N-10: the `?agents=` bucket filter had no test at
// all, in a view whose own comment records the regression class it belongs to
// (the router-free state plumbing blanked #/packs once already). This drives
// the real select against seeded rows with three different agent counts, then
// reloads to prove the bucket survives through the URL.
test("agent-size filter buckets rows and survives a refresh", async ({ page }) => {
  const gw = seedableGateway(page);
  const withAgents = (name, n) => ({
    name,
    description: `${n} 个智能体`,
    tags: [],
    skills: [],
    agents: Array.from({ length: n }, (_, i) => ({ id: `a${i}`, name: `${name}-${i}`, persona: "p" })),
  });
  seedPack(gw.state, withAgents("单兵包", 1), "pack-one");
  seedPack(gw.state, withAgents("双人包", 2), "pack-two");
  seedPack(gw.state, withAgents("班组包", 4), "pack-four");
  // A pre-upgrade row (no agentCount) must pass through every bucket, not vanish.
  gw.state.packs.push({
    id: "pack-unknown",
    authorEmail: "creator@e2e.test",
    createdAt: Date.now(),
    publishedAt: Date.now(),
    version: 1,
    manifest: { name: "未知规模包", description: "老服务端", tags: [], skills: [] },
    versionHistory: [],
  });
  gw.install();
  await gotoPacksTab(page, "market");

  const cards = page.locator('[data-testid^="pack-card-"]');
  const filter = page.getByTestId("pack-agent-size-filter");
  await expect(cards).toHaveCount(4);

  // 2-3 ⇒ the two-agent row only (plus the unknown row, which never filters).
  await filter.selectOption("2-3");
  await expect(page.getByTestId("pack-card-pack-two")).toBeVisible();
  await expect(page.getByTestId("pack-card-pack-one")).toHaveCount(0);
  await expect(page.getByTestId("pack-card-pack-four")).toHaveCount(0);
  await expect(page.getByTestId("pack-card-pack-unknown")).toBeVisible();
  await expect(page).toHaveURL(/[?&]agents=2-3(&|$)/);

  // The bucket lives in the URL: a reload keeps it.
  await page.reload();
  await expect(page.getByTestId("agent-market-page")).toBeVisible({ timeout: 15_000 });
  // The page mounts on the market tab, and the select must come back on the
  // bucket the URL named — that is the contract, not the tab's own state.
  await expect(page.getByTestId("pack-agent-size-filter")).toHaveValue("2-3");
  await expect(page.getByTestId("pack-card-pack-two")).toBeVisible();
  await expect(page.getByTestId("pack-card-pack-one")).toHaveCount(0);

  // 4+ ⇒ four agents and up.
  await page.getByTestId("pack-agent-size-filter").selectOption("4+");
  await expect(page.getByTestId("pack-card-pack-four")).toBeVisible();
  await expect(page.getByTestId("pack-card-pack-two")).toHaveCount(0);

  // 1 ⇒ the single-agent row.
  await page.getByTestId("pack-agent-size-filter").selectOption("1");
  await expect(page.getByTestId("pack-card-pack-one")).toBeVisible();
  await expect(page.getByTestId("pack-card-pack-four")).toHaveCount(0);

  // Any ⇒ everyone back.
  await page.getByTestId("pack-agent-size-filter").selectOption("");
  await expect(cards).toHaveCount(4);
});

// ── Detail: tool-face disclosure (pack-tool-declaration-gate 3.1–3.3) ───────
test("detail discloses declared, full-surface, and legacy tool faces", async ({ page }) => {
  const gw = seedableGateway(page);
  const faceManifest = (name, skill, ref) => ({
    name,
    description: "工具面披露",
    tags: [],
    skills: [{ name: skill, description: "技能", content: "# c" }],
    mcpServers: [{ registryName: "e2e-registry-mcp", ...ref }],
    agents: [],
  });
  seedPack(gw.state, faceManifest("声明包", "face-declared-skill", { allowTools: ["t1", "t2"] }), "pack-face-declared");
  seedPack(
    gw.state,
    faceManifest("全量包", "face-full-skill", { fullSurface: true, fullSurfaceReason: "工具经 tool_search 间接选择" }),
    "pack-face-full",
  );
  seedPack(gw.state, faceManifest("旧版包", "face-legacy-skill", {}), "pack-face-legacy");
  // Deterministic totals: the catalog's tool_list snapshot (no live probe).
  // The trailing `*` is load-bearing: the store asks for `?locale=en`, and a
  // Playwright glob matches only what the pattern admits — without it the real
  // catalog answered, and the totals came from the registry stub's own
  // snapshot (3 tools), which reads exactly like a product bug.
  await page.route("**/api/extensions/market*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        skills: [],
        mcpServers: [
          {
            name: "e2e-registry-mcp",
            displayName: "E2E Registry MCP",
            description: "",
            category: "Registry",
            icon: "box",
            configTemplate: { url: "http://127.0.0.1:1/mcp" },
            installInstructions: "",
            origin: "registry",
            toolList: ["t1", "t2", "t3", "t4", "t5"],
          },
        ],
      }),
    }),
  );
  gw.install();
  await gotoPacksTab(page, "market");

  const open = async (id) => {
    await page.getByTestId(`pack-card-${id}`).click();
    const detail = page.getByTestId("pack-detail");
    await expect(detail).toBeVisible();
    return detail;
  };

  const declared = await open("pack-face-declared");
  await expect(declared.getByTestId("pack-mcp-tool-face-e2e-registry-mcp")).toContainText("声明 2 / 全量 5 工具");
  await declared.getByTestId("pack-detail-close").click();
  await expect(declared).toBeHidden();

  const full = await open("pack-face-full");
  await expect(full.getByTestId("pack-mcp-tool-face-e2e-registry-mcp")).toContainText("全量 5 工具");
  await expect(full.getByTestId("pack-mcp-full-surface-reason-e2e-registry-mcp")).toContainText(
    "工具经 tool_search 间接选择",
  );
  await full.getByTestId("pack-detail-close").click();
  await expect(full).toBeHidden();

  const legacy = await open("pack-face-legacy");
  await expect(legacy.getByTestId("pack-mcp-tool-face-e2e-registry-mcp")).toContainText("全量 5 工具（未声明）");
});

// ── Editor: full-surface marker + publish face gate (4.1–4.3) ───────────────
test("draft saves without tools, the full-surface marker round-trips, publish requires a face", async ({ page }) => {
  const gw = seedableGateway(page);
  gw.install();
  await gotoPacksTab(page, "mine");
  await page.getByTestId("pack-draft-create").click();
  await page.locator("#pack-name").fill("工具面草稿包");

  const mcpChip = page.getByTestId("pack-mcp-option-e2e-registry-mcp");
  if (!(await mcpChip.count())) test.skip(true, "registry stub not serving the market catalog");
  await mcpChip.click();

  // 4.3: publishing with no tool face is blocked locally, naming the server.
  await page.getByTestId("pack-draft-publish").click();
  const editorError = page.getByTestId("pack-editor-error");
  await expect(editorError).toContainText("e2e-registry-mcp");
  await expect(editorError).toContainText("工具面");

  // 4.1: a draft may still SAVE with no tools; reopening keeps that state.
  const editor = page.getByTestId("pack-editor");
  await editor.getByRole("button", { name: "保存草稿" }).click();
  await editor.getByRole("button", { name: "关闭" }).click();
  await page.locator('[data-testid^="pack-draft-item-"]').filter({ hasText: "工具面草稿包" }).first().click();
  await expect(page.getByTestId("pack-mcp-tools-count-e2e-registry-mcp")).toHaveText("全部工具");
  await expect(page.getByTestId("pack-mcp-full-toggle-e2e-registry-mcp")).not.toBeChecked();

  // 4.2: the explicit marker + reason are offered and persist across reopen.
  await page.getByTestId("pack-mcp-full-toggle-e2e-registry-mcp").check();
  await page.getByTestId("pack-mcp-full-reason-e2e-registry-mcp").fill("工具经 tool_search 间接选择");
  await page.getByRole("button", { name: "保存草稿" }).click();
  await page.getByRole("button", { name: "关闭" }).click();
  await page.locator('[data-testid^="pack-draft-item-"]').filter({ hasText: "工具面草稿包" }).first().click();
  await expect(page.getByTestId("pack-mcp-full-toggle-e2e-registry-mcp")).toBeChecked();
  await expect(page.getByTestId("pack-mcp-full-reason-e2e-registry-mcp")).toHaveValue("工具经 tool_search 间接选择");

  // Publishing now succeeds and the manifest carries the marker verbatim.
  await page.getByTestId("pack-draft-publish").click();
  await expect(page.getByTestId("pack-card-pack-e2e-1")).toContainText("工具面草稿包", { timeout: 10_000 });
  const published = gw.state.packs.find((p) => p.id === "pack-e2e-1");
  expect(published.manifest.mcpServers[0].fullSurface).toBe(true);
  expect(published.manifest.mcpServers[0].fullSurfaceReason).toBe("工具经 tool_search 间接选择");
});

test("version history disclosure is lazy, carries notes, and links each version", async ({ page }) => {
  const gw = seedableGateway(page);
  await seedPackBoth(
    gw,
    packManifest({ name: "版本包", skillName: "ver-skill", agentId: "pack-ver-reviewer" }),
    "pack-ver",
  );
  // Two-version history: v1 carries a note, v2 is current with its own note.
  const p = gw.state.packs.find((x) => x.id === "pack-ver");
  const v1At = p.publishedAt;
  p.version = 2;
  p.publishedAt = v1At + 1000;
  p.manifest = { ...p.manifest, notes: "v2：新增检索示例。" };
  p.versionHistory = [
    { version: 1, publishedAt: v1At, manifest: { ...p.manifest, notes: "初版：审查骨架。" } },
    { version: 2, publishedAt: p.publishedAt, manifest: p.manifest },
  ];
  gw.install();

  const versionFetches = [];
  page.on("request", (req) => {
    if (/\/api\/packs\/pack-ver\/versions(\?|$)/.test(new URL(req.url()).pathname)) versionFetches.push(req.url());
  });

  await gotoPacksTab(page, "market");
  await page.getByTestId("pack-card-pack-ver").click();
  const detail = page.getByTestId("pack-detail");
  const list = detail.getByTestId("pack-version-list");
  await expect(list).toBeVisible();

  // Lazy by contract: the list has not fetched before the disclosure opens.
  await expect(detail.getByTestId("pack-version-list-body")).toHaveCount(0);
  expect(versionFetches.length).toBe(0);

  await detail.getByTestId("pack-version-list-toggle").click();
  await expect(detail.getByTestId("pack-version-list-row-2")).toBeVisible();
  await expect(detail.getByTestId("pack-version-list-row-1")).toBeVisible();
  await expect(detail.getByTestId("pack-version-list-notes-2")).toContainText("v2：新增检索示例。");
  await expect(detail.getByTestId("pack-version-list-notes-1")).toContainText("初版：审查骨架。");
  await expect(detail.getByTestId("pack-version-list-row-2")).toContainText("当前");

  // Per-version inspect links (read-only; no install action in the list).
  await expect(detail.getByTestId("pack-version-list-manifest-1")).toHaveAttribute(
    "href",
    "/api/packs/pack-ver/versions/1",
  );
  await detail.getByTestId("pack-version-list-skills-1").click();
  await expect(detail.getByTestId("pack-version-list-skill-links-1")).toContainText("ver-skill.md");
});

test("name collision with a user skill is skipped and reported, not overwritten", async ({ page }) => {
  // A user-created skill owns the name already.
  await page.request.post("/api/extensions/skills", {
    data: { name: "clash-skill", description: "user's own", content: "user content" },
  });
  const gw = seedableGateway(page);
  await seedPackBoth(
    gw,
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
  const manifest = packManifest({ name: "升级包", skillName: "upgrade-skill", agentId: "pack-upgrade-reviewer" });
  await seedPackBoth(gw, manifest, "pack-upgrade");
  gw.install();
  await gotoPacksTab(page, "market");
  await page.getByTestId("pack-card-pack-upgrade").click();
  await page.getByTestId("pack-detail").getByTestId("pack-subscribe").click();
  await page.getByTestId("pack-install-report").getByRole("button").last().click();

  // The author publishes v2 with a changed skill — both planes.
  gw.state.packs[0].version = 2;
  await seedFacetPack("pack-upgrade", 2, manifest);

  await gotoPacksTab(page, "mine");
  await expect(page.getByTestId("pack-update-badge-pack-upgrade")).toContainText("v2");
  // Not upgraded yet: the installed row still reads v1.
  await expect(page.getByTestId("my-pack-pack-upgrade")).toContainText("v1");

  await page.getByTestId("pack-upgrade-pack-upgrade").click();
  await expect(page.getByTestId("my-pack-pack-upgrade")).toContainText("v2", { timeout: 10_000 });
});

test("uninstall warns on modified skills and keeps MCP configs", async ({ page }) => {
  const gw = seedableGateway(page);
  await seedPackBoth(
    gw,
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
  await seedPackBoth(
    gw,
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
  await page.goto("/packs?tab=market");
  // The surface's own doorway refuses: the deep link lands on the agent-market
  // face instead of an empty marketplace shell. (The gate used to be the agents
  // hub's tab array; the hub dissolved 2026-11-06 and /packs mounts directly,
  // so the refusal has to be the page's — asserted here so it cannot be lost
  // again in the next IA move.)
  await expect(page).toHaveURL(/\/agents(\?|$)/);
  await expect(page.getByTestId("agent-market-page")).toBeVisible();
  // restructure-yizuo-ia: the predicate gates the 市场 TAB, so the surface still
  // renders its 我的 tab (local packs + drafts) while the market tab is gone.
  await expect(page.getByTestId("agent-market-tab-market")).toHaveCount(0);
  await expect(page.getByTestId("agent-market-tab-mine")).toBeVisible();
});

// ── Server-side manifest fetch (pack-install-server-side-manifest) ──────────
//
// The install POST carries {packId, version} and the CELL retrieves the
// manifest over the facet channel (e2e/facet-stub.js). These tests pin the
// four acceptance properties: short-form install, caller-scoped private
// visibility, retrieval failure installing nothing, and dual-form
// equivalence with the rolling compatibility body.

test("UI install posts only {packId, version}; the server fetches the manifest", async ({ page }) => {
  const gw = seedableGateway(page);
  await seedPackBoth(
    gw,
    packManifest({ name: "服务端取包", skillName: "serverfetch-skill", agentId: "pack-serverfetch-reviewer" }),
    "pack-sf",
  );
  gw.install();

  // Capture what the browser actually POSTs to the cell.
  const installBodies = [];
  page.on("request", (req) => {
    if (req.url().includes("/api/mypacks/install")) installBodies.push(req.postDataJSON());
  });

  await gotoPacksTab(page, "market");
  await page.getByTestId("pack-card-pack-sf").click();
  await page.getByTestId("pack-detail").getByTestId("pack-subscribe").click();
  await expect(page.getByTestId("pack-install-report")).toContainText("serverfetch-skill");
  await page.getByTestId("pack-install-report").getByRole("button").last().click();

  // The browser carried the reference only — no manifest body (the edge WAF
  // resets manifest-sized bodies containing code/SQL).
  expect(installBodies).toHaveLength(1);
  expect(Object.keys(installBodies[0]).sort()).toEqual(["packId", "version"]);
  expect(installBodies[0]).toEqual({ packId: "pack-sf", version: 1 });

  // The server fetched that version under the caller's identity.
  expect(await lastFacetViewer("pack-sf", 1)).toEqual({ email: "owner@local", groups: [] });

  // Materialized exactly like the previous flow.
  const skills = await getSkills(page);
  expect(skills.find((s) => s.name === "serverfetch-skill")?.source).toBe("database");
  await gotoPacksTab(page, "mine");
  await expect(page.getByTestId("my-pack-pack-sf")).toContainText("v1");
});

test("private pack visibility follows the caller; a stranger gets the market's not-found", async ({ page }) => {
  const gw = seedableGateway(page);
  // Owned by this deployment's own identity (auth off ⇒ the machine owner).
  const mine = packManifest({ name: "我的私有包", skillName: "private-mine", agentId: "pack-priv-mine-reviewer" });
  seedPack(gw.state, mine, "pack-priv-mine");
  await seedFacetPack("pack-priv-mine", 1, mine, { visibility: "private", authorEmail: "owner@local" });
  // Someone else's private pack: the market never shows it to this caller.
  const foreign = packManifest({ name: "他人私有包", skillName: "private-foreign", agentId: "pack-priv-foreign-reviewer" });
  seedPack(gw.state, foreign, "pack-priv-foreign");
  await seedFacetPack("pack-priv-foreign", 1, foreign, { visibility: "private", authorEmail: "someone-else@x" });
  gw.install();

  await gotoPacksTab(page, "market");

  // Owner: the retrieval succeeds and the pack materializes.
  await page.getByTestId("pack-card-pack-priv-mine").click();
  await page.getByTestId("pack-detail").getByTestId("pack-subscribe").click();
  await expect(page.getByTestId("pack-install-report")).toContainText("private-mine");
  await page.getByTestId("pack-install-report").getByRole("button").last().click();
  await gotoPacksTab(page, "mine");
  await expect(page.getByTestId("my-pack-pack-priv-mine")).toBeVisible();

  // Stranger (same cell identity, a pack they do not own): the market's
  // not-found — and nothing written. page.request carries no manifest and no
  // special identity, exactly like the browser's fetch.
  const denied = await page.request.post("/api/mypacks/install", {
    data: { packId: "pack-priv-foreign", version: 1 },
  });
  expect(denied.status()).toBe(404);
  expect((await denied.json()).error).toMatch(/not found/i);

  const skills = await getSkills(page);
  expect(skills.find((s) => s.name === "private-mine")).toBeTruthy();
  expect(skills.find((s) => s.name === "private-foreign")).toBeUndefined();
  const minePacks = await page.request.get("/api/mypacks").then((r) => r.json());
  expect(minePacks.packs.find((p) => p.packId === "pack-priv-foreign")).toBeUndefined();
});

test("a failed manifest retrieval reports the error and writes nothing", async ({ page }) => {
  const gw = seedableGateway(page);
  const manifest = packManifest({ name: "取包失败", skillName: "fetchfail-skill", agentId: "pack-fetchfail-reviewer" });
  seedPack(gw.state, manifest, "pack-fetchfail"); // the mock market lists it…
  await seedFacetPack("pack-fetchfail", 1, manifest, { mode: "500" }); // …but the fetch fails

  const boom = await page.request.post("/api/mypacks/install", { data: { packId: "pack-fetchfail", version: 1 } });
  expect(boom.status()).toBe(502);
  expect((await boom.json()).error).toMatch(/pack marketplace/i);

  // A version the market does not have answers the market's not-found.
  const missing = await page.request.post("/api/mypacks/install", { data: { packId: "pack-ghost", version: 3 } });
  expect(missing.status()).toBe(404);
  expect((await missing.json()).error).toMatch(/not found/i);

  // A 200 without a usable manifest is a retrieval failure too.
  await seedFacetPack("pack-emptyish", 1, manifest, { mode: "no-manifest" });
  const empty = await page.request.post("/api/mypacks/install", { data: { packId: "pack-emptyish", version: 1 } });
  expect(empty.status()).toBe(502);

  // Zero writes across all three.
  expect((await getSkills(page)).find((s) => s.name === "fetchfail-skill")).toBeUndefined();
  const installed = await page.request.get("/api/mypacks").then((r) => r.json());
  for (const id of ["pack-fetchfail", "pack-ghost", "pack-emptyish"]) {
    expect(installed.packs.find((p) => p.packId === id)).toBeUndefined();
  }
});

test("body-form installs ride the identical pipeline (rolling compatibility)", async ({ page }) => {
  // Fetched form: the same manifest content served by the facet stub.
  const manifestA = {
    name: "等价包-取回",
    description: "同一管线的两种形态",
    tags: ["兼容"],
    skills: [{ name: "dual-fetch-skill", description: "取回形态", content: "# fetched\nSELECT 1;" }],
    mcpServers: [],
    agents: [],
  };
  await seedFacetPack("pack-dual-fetch", 1, manifestA);

  const fetched = await page.request.post("/api/mypacks/install", { data: { packId: "pack-dual-fetch", version: 1 } });
  expect(fetched.ok()).toBeTruthy();
  expect((await fetched.json()).report.skills.map((s) => [s.name, s.status])).toEqual([
    ["dual-fetch-skill", "installed"],
  ]);

  // Body form: an equivalent manifest supplied inline, no facet traffic.
  const manifestB = {
    ...manifestA,
    name: "等价包-携带",
    skills: [{ name: "dual-body-skill", description: "携带形态", content: "# body\nSELECT 2;" }],
  };
  const viaBody = await page.request.post("/api/mypacks/install", {
    data: { packId: "pack-dual-body", version: 1, manifest: manifestB },
  });
  expect(viaBody.ok()).toBeTruthy();
  expect((await viaBody.json()).report.skills.map((s) => [s.name, s.status])).toEqual([
    ["dual-body-skill", "installed"],
  ]);

  const seen = await facetSeen();
  expect(seen.some((s) => s.path === "/api/packs/pack-dual-fetch/versions/1")).toBe(true);
  expect(seen.some((s) => s.path === "/api/packs/pack-dual-body/versions/1")).toBe(false);

  // Both rows carry exactly the manifest each form supplied; reinstalling the
  // fetched pack through the body form takes the ordinary replace path.
  const installed = await page.request.get("/api/mypacks").then((r) => r.json());
  expect(installed.packs.find((p) => p.packId === "pack-dual-fetch").manifest).toEqual(manifestA);
  expect(installed.packs.find((p) => p.packId === "pack-dual-body").manifest).toEqual(manifestB);

  const reinstall = await page.request.post("/api/mypacks/install", {
    data: { packId: "pack-dual-fetch", version: 1, manifest: manifestA },
  });
  expect(reinstall.ok()).toBeTruthy();
  expect((await reinstall.json()).report.skills.map((s) => [s.name, s.status])).toEqual([
    ["dual-fetch-skill", "replaced"],
  ]);
});

// ── Tool allowlists in the editor (add-mcp-tool-scoping 6.1) ─────────────────
test("tool allowlists round-trip through save/reload, clear to full, and publish", async ({ page }) => {
  const gw = seedableGateway(page);
  gw.install();
  await gotoPacksTab(page, "mine");
  await page.getByTestId("pack-draft-create").click();
  await page.locator("#pack-name").fill("工具白名单包");

  const mcpChip = page.getByTestId("pack-mcp-option-e2e-registry-mcp");
  if (!(await mcpChip.count())) test.skip(true, "registry stub not serving the market catalog");
  await mcpChip.click();

  // The picked reference offers its tool surface from the catalog snapshot —
  // picker-only names, defaulting to the full surface.
  await expect(page.getByTestId("pack-mcp-tools-count-e2e-registry-mcp")).toHaveText("全部工具");
  await page.getByTestId("pack-mcp-tools-toggle-e2e-registry-mcp").click();
  await page.getByTestId("pack-mcp-tool-e2e-registry-mcp-read").click();
  await page.getByTestId("pack-mcp-tool-e2e-registry-mcp-search").click();
  await expect(page.getByTestId("pack-mcp-tools-count-e2e-registry-mcp")).toHaveText("2 个工具");
  await expect(page.getByTestId("pack-mcp-tool-e2e-registry-mcp-purge")).not.toHaveClass(/bg-primary/);

  // Round-trip: save → close → reopen — the selection survives verbatim.
  const editor = page.getByTestId("pack-editor");
  await editor.getByRole("button", { name: "保存草稿" }).click();
  await editor.getByRole("button", { name: "关闭" }).click();
  await page.locator('[data-testid^="pack-draft-item-"]').filter({ hasText: "工具白名单包" }).first().click();
  await expect(page.getByTestId("pack-editor")).toBeVisible();
  await expect(page.getByTestId("pack-mcp-tools-count-e2e-registry-mcp")).toHaveText("2 个工具");
  await page.getByTestId("pack-mcp-tools-toggle-e2e-registry-mcp").click();
  await expect(page.getByTestId("pack-mcp-tool-e2e-registry-mcp-read")).toHaveClass(/bg-primary/);
  await expect(page.getByTestId("pack-mcp-tool-e2e-registry-mcp-purge")).not.toHaveClass(/bg-primary/);

  // Clear restores the full-surface declaration (no allowTools at all).
  await page.getByTestId("pack-mcp-tools-clear-e2e-registry-mcp").click();
  await expect(page.getByTestId("pack-mcp-tools-count-e2e-registry-mcp")).toHaveText("全部工具");

  // Re-narrow, then publish: the manifest carries the allowlist verbatim.
  await page.getByTestId("pack-mcp-tool-e2e-registry-mcp-read").click();
  await expect(page.getByTestId("pack-mcp-tools-count-e2e-registry-mcp")).toHaveText("1 个工具");
  await page.getByTestId("pack-draft-publish").click();
  await expect(page.getByTestId("pack-card-pack-e2e-1")).toContainText("工具白名单包", { timeout: 10_000 });
});

// ── R4 (add-pack-tutorials-and-wizard): manifest guides, examples, wizard ────

test("detail renders the manifest guide; example prompts are actionable", async ({ page }) => {
  const gw = seedableGateway(page);
  // Creator-authored guide (move-pack-guides-to-manifest 终态: the manifest is
  // the ONLY source — the client module serves nothing). Steps + the P2 3.5
  // examples ride the same object.
  const manifestWithGuide = packManifest({ name: "自带指南包", skillName: "guide-skill", agentId: "pack-guide-reviewer" });
  manifestWithGuide.guide = {
    steps: [
      { title: "创作者第一步", body: "创作者说明一" },
      { title: "创作者第二步", body: "创作者说明二" },
      { title: "创作者第三步", body: "创作者说明三" },
    ],
    examples: [
      { title: "问合同风险", text: "帮我审查这份合同的主要风险点" },
      { title: "拟修改建议", text: "针对第三条给出修改建议" },
    ],
  };
  await seedPack(gw.state, manifestWithGuide, "pack-with-guide");
  // A pack WITHOUT a guide renders no guide card at all.
  await seedPack(gw.state, packManifest({ name: "无指南包", skillName: "plain-skill", agentId: "pack-plain-reviewer" }), "pack-no-guide");
  gw.install();
  await gotoPacksTab(page, "market");

  await page.getByTestId("pack-card-pack-with-guide").click();
  const detail = page.getByTestId("pack-detail");
  await expect(detail.getByTestId("pack-guide-card")).toContainText("创作者第一步");
  await expect(detail.getByTestId("pack-guide-examples")).toBeVisible();

  // 壹座 host (P2 3.5): clicking an example parks the prompt in the composer
  // (the same chat-store channel DocumentsPage uses) and lands in the chat.
  await detail.getByTestId("pack-guide-example-0").click();
  await expect(page).toHaveURL(/\/chat/);
  await expect(page.getByTestId("composer-input")).toHaveValue("帮我审查这份合同的主要风险点");

  await gotoPacksTab(page, "market");
  await page.getByTestId("pack-card-pack-no-guide").click();
  await expect(detail.getByTestId("pack-guide-card")).toHaveCount(0);
  await page.keyboard.press("Escape");
});

test("subscribe report ends with the next-steps wizard", async ({ page }) => {
  // The CTA's deep link switches the runtime onto the installed persona —
  // swallow set_agent for this test so the SHARED cell never restarts onto
  // it (later specs compose the full surface, not the pack's focused set).
  // The URL param is client-side navigation state and asserts fine while the
  // switch sits swallowed-pending.
  await page.addInitScript(() => {
    const origSend = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) {
      let parsed;
      try {
        parsed = JSON.parse(data);
      } catch {
        parsed = null;
      }
      if (parsed && parsed.type === "set_agent") return;
      return origSend.call(this, data);
    };
  });
  const gw = seedableGateway(page);
  await seedPackBoth(
    gw,
    packManifest({ name: "向导包", skillName: "wizard-skill", agentId: "pack-wizard-reviewer" }),
    "pack-wizard",
  );
  gw.install();
  await gotoPacksTab(page, "market");
  await page.getByTestId("pack-card-pack-wizard").click();
  const detail = page.getByTestId("pack-detail");
  await detail.getByTestId("pack-subscribe").click();

  const report = page.getByTestId("pack-install-report");
  await expect(report).toBeVisible();
  const next = page.getByTestId("pack-install-next");
  await expect(next).toBeVisible();
  // simplify-chat-and-agents-ia: the CTA carries the installed role — the
  // hint no longer tells the user to go pick the expert themselves (this
  // test's gateway seeding lands on the zh locale, so assert the OLD manual
  // instruction is gone rather than pinning one locale's new copy), and the
  // navigation carries the preset param.
  await expect(next).not.toContainText("选择框");
  await expect(next).not.toContainText("pick this");
  await page.getByTestId("pack-install-open-chat").click();
  await page.waitForURL(/\/chat\?preset=pack-wizard-reviewer/);
  await expect(page.getByTestId("pack-install-report")).toHaveCount(0);
});

test("creator guide: complete guide publishes into the manifest, partial does not", async ({ page }) => {
  const gw = seedableGateway(page);
  gw.install();
  await gotoPacksTab(page, "mine");
  await page.getByTestId("pack-draft-create").click();
  await expect(page.getByTestId("pack-editor")).toBeVisible();

  await page.locator("#pack-name").fill("指南包");
  await page.getByTestId("pack-skill-add").click();
  await page.getByTestId("pack-skill-entry-0").locator("input").nth(0).fill("guide-e2e-skill");
  await page.getByTestId("pack-skill-entry-0").locator("input").nth(1).fill("指南技能");
  await page.getByTestId("pack-skill-entry-0").locator("textarea").fill(SKILL_V1);

  // Partial guide (two steps) → publish carries NO guide.
  await page.getByTestId("pack-guide-editor-toggle").click();
  await page.getByTestId("pack-guide-title-0").fill("准备合同");
  await page.getByTestId("pack-guide-body-0").fill("把合同粘贴进来");
  await page.getByTestId("pack-guide-title-1").fill("提出审查");
  await page.getByTestId("pack-guide-body-1").fill("说：审查这份合同");
  await page.getByTestId("pack-draft-publish").click();
  await expect(page.getByTestId("pack-card-pack-e2e-1")).toBeVisible({ timeout: 10_000 });
  const v1 = gw.state.packs.find((p) => p.id === "pack-e2e-1");
  expect(v1.manifest.guide).toBeUndefined();

  // Complete the third step → republish carries the full guide.
  await gotoPacksTab(page, "mine");
  await page.locator('[data-testid^="pack-draft-item-"]').first().click();
  await expect(page.getByTestId("pack-editor")).toBeVisible();
  await page.getByTestId("pack-guide-editor-toggle").click();
  await page.getByTestId("pack-guide-title-2").fill("取走成果");
  await page.getByTestId("pack-guide-body-2").fill("成果自动保存");
  await page.getByTestId("pack-draft-publish").click();
  await expect(page.getByTestId("pack-card-pack-e2e-1")).toContainText("v2", { timeout: 10_000 });
  const v2 = gw.state.packs.find((p) => p.id === "pack-e2e-1");
  expect(v2.version).toBe(2);
  expect(v2.manifest.guide?.steps?.[0]?.title).toBe("准备合同");
  expect(v2.manifest.guide?.steps?.[2]?.title).toBe("取走成果");
});

// ── Facade matters (add-matter-threads) ──────────────────────────────────────
//
// The principal's queue on the pack detail: a facade pack with one open
// matter renders the panel (stranger-blindness is server-side — the mock
// answers the owner's list here), the reply round-trips verbatim, and close
// is terminal (the reply box goes away with the closed badge).

test("facade matters: the owner queue replies and closes through the detail dialog", async ({ page }) => {
  const gw = seedableGateway(page);
  gw.install();
  const facadeManifest = {
    name: "分身事项包",
    description: "matters 面板 e2e",
    tags: ["分身"],
    skills: [{ name: "corpus-one", description: "语料", content: "# c" }],
    agents: [{ id: "reception", name: "接待", persona: "p", serving: { protocol: "a2a" } }],
    facade: { reception: "reception", corpus: ["corpus-one"], delegation: [], stance: "hosted" },
  };
  seedPack(gw.state, facadeManifest, "pack-matters");

  const actions = [];
  const now = Date.now();
  await page.route("**/api/packs/pack-matters/matters**", async (route) => {
    const req = route.request();
    const method = req.method();
    const path = new URL(req.url()).pathname;
    const base = {
      id: "mt_e2e1", packId: "pack-matters", agentId: "reception", deployer: "creator@e2e.test",
      summary: "请问企业版怎么收费？", visitorHint: "访客自述：张三", status: "open",
      timeline: [{ kind: "open", by: "reception", text: "请问企业版怎么收费？", at: now - 3_600_000 }],
      createdAt: now - 3_600_000, updatedAt: now - 3_600_000,
    };
    if (method === "GET") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ matters: [base] }) });
    }
    const m = path.match(/\/matters\/(mt_e2e1)\/(reply|close)$/);
    if (method === "POST" && m) {
      const body = req.postDataJSON();
      actions.push({ kind: m[2], body });
      const out =
        m[2] === "reply"
          ? { ...base, status: "responded", updatedAt: now, timeline: [...base.timeline, { kind: "reply", by: "owner", text: body.text, at: now }] }
          : { ...base, status: "closed", updatedAt: now, timeline: [...base.timeline, { kind: "close", by: "owner", text: body.note ?? "", at: now }] };
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ matter: out }) });
    }
    return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "unmocked" }) });
  });

  await gotoPacksTab(page, "market");
  await page.getByTestId("pack-card-pack-matters").click();
  const detail = page.getByTestId("pack-detail");
  await expect(detail).toBeVisible();

  // The facade panel and the matter queue both render; the matter is open.
  await expect(detail.getByTestId("pack-facade-info")).toBeVisible();
  const panel = detail.getByTestId("pack-facade-matters");
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId("pack-matter-mt_e2e1")).toContainText("请问企业版怎么收费？");
  await expect(panel.getByTestId("pack-matter-visitor-mt_e2e1")).toContainText("张三");
  await expect(panel.getByTestId("pack-matter-mt_e2e1")).toContainText("待回应");

  // Reply round-trips: the owner's text reaches the route verbatim, the badge flips.
  await panel.getByTestId("pack-matter-reply-input-mt_e2e1").fill("本周四下午三点，链接稍后发。");
  await panel.getByTestId("pack-matter-reply-btn-mt_e2e1").click();
  await expect(panel.getByTestId("pack-matter-mt_e2e1")).toContainText("已回应");
  expect(actions).toHaveLength(1);
  expect(actions[0].kind).toBe("reply");
  expect(actions[0].body.text).toBe("本周四下午三点，链接稍后发。");

  // Close is terminal: the badge flips, the reply box disappears.
  await panel.getByTestId("pack-matter-close-btn-mt_e2e1").click();
  await expect(panel.getByTestId("pack-matter-mt_e2e1")).toContainText("已关闭");
  await expect(panel.getByTestId("pack-matter-reply-input-mt_e2e1")).toHaveCount(0);
  expect(actions).toHaveLength(2);
  expect(actions[1].kind).toBe("close");
});

// ── P3 4.7/4.8/4.9 · 作者端工作台 + 词表选择器 + 分级提示 ────────────────────
test("工作台填英文、词表多选（上限3），发布 manifest 逐字携带 i18n/domain (4.7/4.8)", async ({ page }) => {
  const gw = seedableGateway(page);
  gw.install();
  await gotoPacksTab(page, "mine");
  await page.getByTestId("pack-draft-create").click();
  await page.locator("#pack-name").fill("双语法务包");
  await page.locator("#pack-tags").fill("法律, 合同");
  await page.locator("#pack-desc").fill("合同审查工作流。");
  await page.getByTestId("pack-skill-add").click();
  await page.getByTestId("pack-skill-entry-0").locator("input").nth(0).fill("bilingual-skill");
  await page.getByTestId("pack-skill-entry-0").locator("input").nth(1).fill("五阶段合同审查");
  await page.getByTestId("pack-skill-entry-0").locator("textarea").fill(SKILL_V1);

  // 4.8: vocabulary chips; the 3-cap refuses a 4th pick.
  await page.getByTestId("pack-domain-pick-legal").click();
  await page.getByTestId("pack-domain-pick-investing").click();
  await page.getByTestId("pack-domain-pick-risk").click();
  await page.getByTestId("pack-domain-pick-knowledge").click();
  await expect(page.getByTestId("pack-domain-pick-knowledge")).toHaveAttribute("aria-pressed", "false");

  // 4.7: the workbench pairs en inputs against the zh state.
  await page.getByTestId("pack-workbench-toggle").click();
  await page.locator("#pack-en-name").fill("Bilingual Legal Pack");
  await page.locator("#pack-en-description").fill("Contract review workflow.");
  await page.locator("#pack-en-tags-0").fill("Law");
  await page.locator("#pack-en-tags-1").fill("Contract");
  await page.getByTestId("pack-workbench-recompute").click();
  await expect(page.getByTestId("pack-workbench-coverage")).toContainText("2/4");

  await page.getByTestId("pack-draft-publish").click();
  await expect(page.getByTestId("pack-card-pack-e2e-1")).toBeVisible({ timeout: 10_000 });

  // The published manifest carries the authored overlay + picks VERBATIM.
  const published = gw.state.packs[0].manifest;
  expect(published.i18n.en.name).toBe("Bilingual Legal Pack");
  expect(published.i18n.en.description).toBe("Contract review workflow.");
  expect(published.i18n.en.tags).toEqual(["Law", "Contract"]);
  expect(published.domain).toEqual(["legal", "investing", "risk"]);
});

test("词表外存量取值：标示不合法、阻发布、保存零静默改写 (4.8 三态)", async ({ page }) => {
  const gw = seedableGateway(page);
  gw.install();
  // 造一份带表外旧值的草稿（柏讯是线词不是领域 slug）。
  const created = await page.request.post("/api/pack-drafts", { data: { name: "旧词表包", description: "旧草稿。", tags: ["法律"] } });
  const draftId = (await created.json()).draft.id;
  const put = await page.request.put(`/api/pack-drafts/${draftId}`, {
    data: {
      name: "旧词表包",
      description: "旧草稿。",
      tags: ["法律"],
      entries: { skills: [{ name: "s", description: "技能", content: "# s" }], mcpServers: [], agents: [], domain: ["柏讯"], audience: ["legal", "made-up"] },
    },
  });
  expect(put.ok(), JSON.stringify(await put.json().catch(() => ({})))).toBeTruthy();

  await gotoPacksTab(page, "mine");
  await page.locator('[data-testid^="pack-draft-item-"]').first().click();
  await expect(page.getByTestId("pack-editor")).toBeVisible();
  // 非法态：表外值以 invalid chip 原样呈现（不消失、不改写）。
  await expect(page.getByTestId("pack-domain-invalid-柏讯")).toContainText("柏讯");
  await expect(page.getByTestId("pack-audience-invalid-made-up")).toContainText("made-up");

  // 发布被拦（客户端预检点名全部越界值）。
  await page.getByTestId("pack-draft-publish").click();
  await expect(page.getByTestId("pack-editor-error")).toContainText("柏讯");
  await expect(page.getByTestId("pack-editor-error")).toContainText("made-up");

  // 保存零静默改写：authored NEW content in the same write (an en name via
  // the workbench) proves save ran, and the out-of-table picks come back
  // VERBATIM in that same stored draft — no silent normalization.
  await page.getByTestId("pack-workbench-toggle").click();
  await page.locator("#pack-en-name").fill("Legacy Pack");
  await page.getByRole("button", { name: "保存草稿" }).click();
  await expect
    .poll(async () => (await (await page.request.get(`/api/pack-drafts/${draftId}`)).json()).draft)
    .toHaveProperty(["entries", "i18n", "en", "name"], "Legacy Pack");
  const stored = await (await page.request.get(`/api/pack-drafts/${draftId}`)).json();
  expect(stored.draft.entries.domain).toEqual(["柏讯"]);
  expect(stored.draft.entries.audience).toEqual(["legal", "made-up"]);
});

test("官方 422 分级提示：逐项缺项可点跳工作台并聚焦对应输入 (4.9)", async ({ page }) => {
  const gw = seedableGateway(page);
  gw.state.publishGate = {
    error: "official publishes must carry full en coverage on the display surface (2/4 covered)",
    code: "official_en_coverage_incomplete",
    coverage: { locale: "en", total: 4, covered: 2, missing: ["description", "skills['gate-skill'].description"] },
  };
  gw.install();
  await gotoPacksTab(page, "mine");
  await page.getByTestId("pack-draft-create").click();
  await page.locator("#pack-name").fill("官门包");
  await page.locator("#pack-desc").fill("官方发布门用例。");
  await page.getByTestId("pack-skill-add").click();
  await page.getByTestId("pack-skill-entry-0").locator("input").nth(0).fill("gate-skill");
  await page.getByTestId("pack-skill-entry-0").locator("input").nth(1).fill("门技");
  await page.getByTestId("pack-skill-entry-0").locator("textarea").fill(SKILL_V1);

  await page.getByTestId("pack-draft-publish").click();
  await expect(page.getByTestId("pack-publish-gate")).toBeVisible();
  await expect(page.getByTestId("pack-editor-error")).toContainText("full en coverage");
  // 点击缺项 → 工作台打开并聚焦该项输入。
  await page.getByTestId("pack-publish-gap-description").click();
  await expect(page.getByTestId("pack-workbench")).toBeVisible();
  await expect(page.evaluate(() => document.activeElement?.id ?? "")).resolves.toBe("pack-en-description");
});
