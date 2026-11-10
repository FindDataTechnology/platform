// ── Visual walkthrough capture (② 5.5 · ④ 4.6) ──────────────────────────────
//
// The two "走查" tasks ask for screenshots of (a) the five line boards and
// (b) the five market tabs in their card states, at desktop and narrow widths.
// Both were blocked on an image roll, but the shots do not need production data:
// the surfaces are deterministic under mocked payloads, so capture them here on
// the real built dist and re-shoot on production after the roll.
//
// Output: evidence/walkthrough-<date>/<surface>-<width>.png (untracked).
// Run:   npx playwright test e2e/visual-walkthrough.spec.js --project=fast

import fs from "node:fs";
import path from "node:path";
import { test, expect } from "@playwright/test";
import { pinLocaleEn } from "./helpers.js";

const OUT = path.resolve(import.meta.dirname, "..", "..", "evidence", "walkthrough-2026-11-10");
const WIDTHS = [
  { label: "1440", width: 1440, height: 900 },
  { label: "640", width: 640, height: 900 },
];

const shot = async (page, name) => {
  fs.mkdirSync(OUT, { recursive: true });
  await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: true });
};

// ── ④ 4.6: the five market tabs, with cards in three relation states ─────────
const pack = (id, version, extra = {}) => ({
  id,
  authorEmail: "creator@e2e.test",
  createdAt: Date.now(),
  publishedAt: Date.now(),
  version,
  name: id,
  description: `pack ${id}`,
  tags: [],
  visibility: "public",
  unlisted: false,
  category: "demo",
  ...extra,
});

test.describe("market tabs walkthrough", () => {
  for (const w of WIDTHS) {
    test(`five tabs at ${w.label}`, async ({ page }) => {
      await page.setViewportSize({ width: w.width, height: w.height });
      await page.route("**/api/packs?**", (route) =>
        route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            total: 3,
            page: 1,
            pageSize: 50,
            packs: [pack("rel-installed", 3, { official: true }), pack("rel-stale", 4), pack("rel-fresh", 1)],
          }),
        }),
      );
      await page.route("**/api/mypacks*", (route) =>
        route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            packs: [
              { packId: "rel-installed", name: "rel-installed", version: 3, manifest: {}, installedAt: "", updatedAt: "" },
              { packId: "rel-stale", name: "rel-stale", version: 3, manifest: {}, installedAt: "", updatedAt: "" },
            ],
          }),
        }),
      );
      await page.route("**/api/plugin-catalog**", (route) =>
        route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            plugins: [
              { id: "p-on", name: "Supplied, on", description: "…" },
              { id: "p-off", name: "Supplied, off", description: "…" },
              { id: "p-missing", name: "Not supplied", description: "…" },
            ],
          }),
        }),
      );

      await pinLocaleEn(page);
      await page.goto("/agents");
      await expect(page.getByTestId("agent-market-page")).toBeVisible({ timeout: 15_000 });
      await page.evaluate(() =>
        window.__chatStore.getState().apply({
          type: "plugins",
          available: true,
          bundles: [
            { id: "p-on", name: "p-on", version: "0.0.1", enabled: true, installed: true, optional: false, removable: true },
            { id: "p-off", name: "p-off", version: "0.0.1", enabled: false, installed: true, optional: false, removable: true },
          ],
        }),
      );

      for (const tab of ["agents", "tools", "skills", "plugins", "mine"]) {
        await page.getByTestId(`agent-market-tab-${tab}`).click();
        await page.waitForTimeout(400); // let the panel's own fetch settle
        await shot(page, `market-${tab}-${w.label}`);
      }
    });
  }
});

// ── ② 5.5: the five line boards (four live + the host line) ─────────────────
const BOARD = (line, title, tabs, blocks) => ({ line, title, originUrl: `https://${line}.example`, tabs, blocks });

test("five line boards at 1440", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const boards = {
    facet: BOARD("facet", "谦面", ["overview", "my-packs", "publish-history"], [
      { id: "overview_metrics", type: "metrics", tab: "overview", title: "概览", data: { my_packs: 2, published_versions: 3 } },
      { id: "my_packs", type: "list", tab: "my-packs", title: "我的包", data: [{ id: "a", title: "台账助手", subtitle: "v3" }] },
      { id: "publish_history", type: "timeline", tab: "publish-history", title: "发布记录", data: [] },
    ]),
    lex: BOARD("lex", "识律", ["overview", "credentials", "suites", "billing"], [
      { id: "overview_metrics", type: "metrics", tab: "overview", title: "概览", data: { usage: 12 } },
      { id: "credentials_list", type: "list", tab: "credentials", title: "我的凭据", data: [{ id: "k1", title: "合同线" }] },
      { id: "suites_matrix", type: "list", tab: "suites", title: "识律套件", data: [{ id: "s1", title: "合同审查" }] },
      { id: "billing_timeline", type: "timeline", tab: "billing", title: "账单", data: [] },
    ]),
    wire: BOARD("wire", "柏讯", ["overview", "datasets", "artifacts", "demands"], [
      { id: "overview_metrics", type: "metrics", tab: "overview", title: "概览", data: { 数据集: 1, 产物: 2 } },
      { id: "datasets_list", type: "list", tab: "datasets", title: "我的数据", data: [{ id: "d1", title: "销售台账" }] },
      { id: "artifacts_list", type: "list", tab: "artifacts", title: "产物", data: [{ id: "a1", title: "进货单" }] },
      { id: "demands_timeline", type: "timeline", tab: "demands", title: "需求单", data: [] },
    ]),
    // A wholly under-construction line: one statement, no tab strip (D2).
    wanxing: BOARD("wanxing", "萬星", ["fleet-summary", "missions", "deployments"], [
      { id: "fleet_summary_metrics", type: "metrics", tab: "fleet-summary", title: "集群概况", error: "under_construction" },
      { id: "missions", type: "list", tab: "missions", title: "任务", error: "under_construction" },
      { id: "deployments", type: "list", tab: "deployments", title: "部署", error: "under_construction" },
    ]),
  };

  for (const [line, board] of Object.entries(boards)) {
    await page.route(`**/api/config`, async (route) => {
      const res = await route.fetch();
      const body = await res.json();
      body.lineBoardsEnabled = true;
      await route.fulfill({ response: res, json: body });
    });
    await page.route(`**/api/boards/${line}`, (route) => route.fulfill({ json: { ...board, connected: true } }));
    await pinLocaleEn(page);
    await page.goto(`/boards/${line}`);
    await expect(page.getByTestId(`board-${line}`)).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(300);
    await shot(page, `board-${line}-1440`);
  }

  // The host line: not "un-onboarded", it IS the host.
  await page.route("**/api/boards/base", (route) =>
    route.fulfill({ status: 404, json: { error: "line_not_found", message: "该线尚未接入 (base)" } }),
  );
  await page.goto("/boards/base");
  await expect(page.getByTestId("board-host-line")).toBeVisible({ timeout: 15_000 });
  await shot(page, "board-base-1440");
});
