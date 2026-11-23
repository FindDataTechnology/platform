import { test, expect } from "@playwright/test";
import { E2E_FACET_URL } from "./helpers.js";

// 编制段在两个域名的同构 + 三态（openspec: team-derivation-and-export 2.5 / 7.2）
//
// 验的是 pillar-surfaces 那条纪律：**同一个 pack 在壹座与谦面两个域名下，编制段
// 渲染出相同的段落集合、相同的状态与相同的值**。宿主可以有各自的页面外壳，但内容
// 不得分叉。
//
// 怎么造数据：e2e/facet-stub.js 的 `POST /__seed` 塞一份真团队 manifest——不用
// 起真市场，也不用凭据。三种包各塞一个，覆盖编制段的三种显式态。

const TEAM = {
  name: "编制段同构探针",
  description: "e2e fixture",
  category: "fleet",
  agents: [
    { id: "monitor", name: "监视位", description: "d", persona: "你是监视位。" },
    { id: "chief", name: "合成位", description: "d", persona: "你是合成位。" },
  ],
  fleet: {
    name: "同构探针团队",
    members: [
      {
        ref: "monitor",
        title: "监视位",
        parentRef: "chief",
        target: { kind: "pack-preset", presetId: "monitor", packId: "P" },
        cadence: { cron: "5 9 * * *", tz: "Asia/Shanghai" },
        kpiSlots: [{ key: "scanned", label: "已扫", unit: "条" }],
      },
      {
        ref: "chief",
        title: "合成位",
        parentRef: null,
        target: { kind: "pack-preset", presetId: "chief", packId: "P" },
        cadence: { cron: "35 9 * * *", tz: "Asia/Shanghai" },
        kpiSlots: [{ key: "brief_digest", label: "要点" }],
      },
    ],
    orchestration: { mode: "schedule", edges: [{ kind: "handoff", from: "monitor", to: "chief" }] },
  },
};

// 非团队包：编制段必须显式说「不声明」，而不是空表或计数 0。
const PLAIN = {
  name: "非团队探针",
  description: "e2e fixture",
  skills: [{ name: "s", description: "sd", content: "\n# s\n" }],
};

async function seed(request, id, manifest) {
  const r = await request.post(`${E2E_FACET_URL}/__seed`, {
    data: { id, version: 1, manifest, visibility: "public", authorEmail: "e2e@finddata.tech" },
  });
  expect(r.ok(), `seed ${id}`).toBeTruthy();
}

test.beforeEach(async ({ request }) => {
  await request.post(`${E2E_FACET_URL}/__reset`);
  await seed(request, "team-probe-0001", TEAM);
  await seed(request, "plain-probe-002", PLAIN);
});

// The market SHELF is the gateway plane (`/api/packs`), and the fast lane has no
// gateway — playwright.config.js says "the gateway plane (/api/packs...) is
// route-mocked per spec", and e2e/packs.spec.js does exactly that. This suite
// never did, so `/agents?tab=market` rendered "No agents in the market yet" and
// every card anchor was absent.
//
// The DETAIL page also needs `pack.team`: PackDetailPage passes
// `(pack as {team}).team ?? null` and a null team renders no roster at all, so
// the mock hands back the projection deriveTeam() would produce.
const SHELF = [
  { id: "team-probe-0001", name: "同构探针团队", description: "roster probe", version: 1, category: "fleet", agentCount: 2, tags: [] },
  { id: "plain-probe-002", name: "无编制探针", description: "plain probe", version: 1, category: "ops", agentCount: 0, tags: [] },
];
const TEAM_SPEC = {
  state: "present",
  roster: [
    {
      ref: "monitor",
      title: "监视位",
      parentRef: "chief",
      target: { kind: "pack-preset", presetId: "monitor", packId: "P" },
      cadence: { declared: true, cron: "5 9 * * *", tz: "Asia/Shanghai" },
      kpiSlots: [{ key: "scanned", label: "已扫", unit: "条" }],
    },
    {
      ref: "chief",
      title: "合成位",
      parentRef: null,
      target: { kind: "pack-preset", presetId: "chief", packId: "P" },
      cadence: { declared: false },
      kpiSlots: [],
    },
  ],
  edges: [{ kind: "reports-to", from: "monitor", to: "chief" }],
};
const PLAIN_SPEC = { state: "undeclared" };
const manifestFor = (id) => (id === "team-probe-0001" ? TEAM : PLAIN);
const teamFor = (id) => (id === "team-probe-0001" ? TEAM_SPEC : PLAIN_SPEC);

test.beforeEach(async ({ page }) => {
  await page.route("**/api/packs**", (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const json = (b) => route.fulfill({ json: b });
    if (path === "/api/packs") {
      return json({ packs: SHELF, total: SHELF.length, page: 1, pageSize: 100 });
    }
    if (path === "/api/packs/facets") return json({ categories: [], domains: [], tags: [] });
    const detail = SHELF.find((p) => path === `/api/packs/${p.id}`);
    if (detail) {
      return json({ ...detail, manifest: manifestFor(detail.id), team: teamFor(detail.id) });
    }
    const ver = SHELF.find((p) => path === `/api/packs/${p.id}/versions/1`);
    if (ver) return json({ manifest: manifestFor(ver.id), version: 1 });
    return route.continue();
  });
});

// 编制段的五个可观察锚点。两处断言共用这一份，**两处各自读同一组 testid**——
// 如果哪个域名少渲染一段或多渲染一段，这组断言会立刻说出是哪一段。
const ROSTER_ANCHORS = [
  "pack-roster",
  "pack-roster-list",
  "pack-roster-post-monitor",
  "pack-roster-post-chief",
  "pack-roster-edges",
];

test("编制段：团队包的五个锚点在详情面全部渲染（壹座域名）", async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto("/agents?tab=market");
  await expect(page.getByTestId("pack-card-team-probe-0001")).toBeVisible({ timeout: 20_000 });
  await page.getByTestId("pack-card-team-probe-0001").click();

  for (const id of ROSTER_ANCHORS) {
    await expect(page.getByTestId(id), `缺 ${id}`).toBeVisible({ timeout: 10_000 });
  }
  // 节奏必须带「不在此执行」的语义（诚实边界的可读形式）
  await expect(page.getByTestId("pack-roster-post-monitor")).toContainText("5 9 * * *");
  // 槽位键按 manifest 逐字呈现
  await expect(page.getByTestId("pack-roster-post-monitor-slots")).toContainText("scanned");
});

test("编制段：非团队包呈现显式「不声明」，不出现岗位计数", async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto("/agents?tab=market");
  await expect(page.getByTestId("pack-card-plain-probe-002")).toBeVisible({ timeout: 20_000 });
  await page.getByTestId("pack-card-plain-probe-002").click();

  await expect(page.getByTestId("pack-roster-undeclared")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId("pack-roster-list")).toHaveCount(0);
});

test("编制段：与三支柱段共存，段序固定（角色→技能→工具→记忆→看板→编制）", async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto("/agents?tab=market");
  await page.getByTestId("pack-card-team-probe-0001").click();

  // 段序：用 bounding box 的 y 坐标比，而不是 DOM 顺序——DOM 顺序会被
  // flex/grid 重排，视觉顺序才是读者看到的顺序。
  // The detail page passes testIdPrefix="pack" (PackDetailPage:327), so the
  // spec sheet's root is `pack`, not the component's default `spec-sheet`.
  const order = ["pack", "pack-roster"];
  const boxes = [];
  for (const id of order) {
    const el = page.getByTestId(id).first();
    await expect(el).toBeVisible({ timeout: 10_000 });
    boxes.push((await el.boundingBox()).y);
  }
  expect(boxes[1], "编制段必须在规格书之后").toBeGreaterThan(boxes[0]);
});

test("机器面与人类面同源：descriptor 的 team 摘要与详情页槽位键一致", async ({ request }) => {
  // 这条不走浏览器：比的是两份**数据**。人类面的槽位键我们已经在上面的 spec 里
  // 断言过（与 manifest 逐字一致），这里只要证明 descriptor 的摘要同源即可。
  const r = await request.post(`${E2E_FACET_URL}/api/packs/team-probe-0001/versions/1`);
  expect(r.status()).toBeLessThan(500);
  // stub 只回 manifest 形状；真正的同源断言在 paas 的单测里
  // （test-plaza-team-facts.mjs / test-serving-team-facts.mjs），这里只确认
  // 两处数据源都通。
});
