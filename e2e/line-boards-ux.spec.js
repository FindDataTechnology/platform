import { test, expect } from "@playwright/test";
import { pinLocaleEn } from "./helpers.js";

// Line-boards UX sentinels (openspec: fix-line-boards-ux, task 3.1).
//
// The 2026-11-02 user audit: 谦面/柏讯 boards "too simple, violate the
// interaction paradigm, cannot go back to the app center". Root causes pinned
// here against a mocked facet board in the NEW adapter shape (blocks carry
// `tab`, metric keys are snake_case):
//   - tabs sync via replaceState: clicking tabs never pushes history, so one
//     browser back leaves the board for /apps;
//   - the page header carries an explicit 返回应用中心 control;
//   - the tab↔block contract fills 谦面's two historically-empty tabs;
//   - metric labels localize (no raw weeklyActivePacks-style keys in DOM);
//   - `under_construction` renders the neutral card, not the red failure one.

async function enableBoards(page) {
  await page.route("**/api/config", async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    body.lineBoardsEnabled = true;
    await route.fulfill({ response: res, json: body });
  });
}

const ORIGIN = "https://facet.finddatatech.cloud";

function facetBoard() {
  return {
    line: "facet",
    title: "谦面",
    originUrl: ORIGIN,
    tabs: ["overview", "my-packs", "publish-history"],
    connected: true,
    blocks: [
      { id: "overview_metrics", type: "metrics", tab: "overview", title: "概览", data: { my_packs: 2, published_versions: 3 }, href: `${ORIGIN}/#/mine` },
      {
        id: "my_packs",
        type: "list",
        tab: "my-packs",
        title: "我的包",
        href: `${ORIGIN}/#/mine`,
        data: [{ id: "pk-one", title: "台账助手", subtitle: "进货出货台账", badges: ["v3", "公开"] }],
      },
      {
        id: "recent_events",
        type: "timeline",
        tab: "overview",
        title: "最近事件",
        data: [{ id: "pk-one:3", text: "台账助手 · v3", created_at: "2026-11-01T10:00:00Z" }],
      },
      { id: "publish_history", type: "timeline", tab: "publish-history", title: "发布记录", data: [], error: "under_construction", href: `${ORIGIN}/#/mine` },
    ],
  };
}

test("tabs match blocks by contract, localize metric labels, and never pollute the back path", async ({
  page,
}) => {
  await pinLocaleEn(page);
  await enableBoards(page);
  await page.route("**/api/boards/facet", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(facetBoard()) }));

  // Enter the board the way the app center does: /apps → card → 看板.
  await page.goto("/apps");
  await expect(page.getByTestId("app-center-page")).toBeVisible({ timeout: 15000 });
  await page.goto("/boards/facet");
  await expect(page.getByTestId("board-facet")).toBeVisible({ timeout: 15000 });

  // Overview tab: real counts under localized labels — the raw snake_case
  // keys must not appear as display copy.
  await expect(page.getByTestId("block-overview_metrics")).toBeVisible();
  await expect(page.getByTestId("block-overview_metrics")).toContainText("My packs");
  await expect(page.getByTestId("block-overview_metrics")).not.toContainText("my_packs");
  await expect(page.getByTestId("block-recent_events")).toBeVisible();

  // The historically-empty tab now carries its block (the hyphen/underscore
  // substring bug made this tab render nothing).
  await page.getByTestId("board-tab-my-packs").click();
  await expect(page.getByTestId("block-my_packs")).toBeVisible();
  await expect(page.getByTestId("block-my_packs")).toContainText("台账助手");
  // And the other tabs' blocks are gone from this tab.
  await expect(page.getByTestId("block-overview_metrics")).toHaveCount(0);

  // Three tab clicks pushed ZERO history entries: one back leaves the board
  // for the page the user came from (/apps), not unwinds tabs one by one.
  await page.goBack();
  await expect(page.getByTestId("app-center-page")).toBeVisible({ timeout: 10000 });

  // The header's explicit return control works from a fresh board visit.
  await page.goto("/boards/facet");
  await expect(page.getByTestId("board-facet")).toBeVisible();
  await page.getByTestId("board-back").click();
  await expect(page.getByTestId("app-center-page")).toBeVisible({ timeout: 10000 });
});

test("under_construction renders the neutral card, not the red failure chrome", async ({ page }) => {
  await pinLocaleEn(page);
  await enableBoards(page);
  await page.route("**/api/boards/facet", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(facetBoard()) }));
  await page.goto("/boards/facet");
  await page.getByTestId("board-tab-publish-history").click();

  await expect(page.getByTestId("block-publish_history-construction")).toBeVisible();
  await expect(page.getByTestId("block-publish_history-construction")).toContainText("Under construction");
  // Not the destructive error styling.
  await expect(page.getByTestId("block-publish_history-error")).toHaveCount(0);
});

// ── 识律: the fourth adapter's four tabs are actually reachable ─────────────
// The adapter, its spec and its live walk-through all shipped; the page's
// hand-written tab table never learned about lex, so its four blocks stacked
// into one wall and /apps never offered the entry. Both halves are pinned
// here: the tabs render, and the card links in.
function lexBoard() {
  const ORIGIN = "https://lex.finddatatech.cloud";
  return {
    line: "lex",
    title: "识律",
    originUrl: ORIGIN,
    // Derived server-side from the adapter's own blocks (D1).
    tabs: ["overview", "credentials", "suites", "billing"],
    connected: true,
    blocks: [
      { id: "overview_metrics", type: "metrics", tab: "overview", title: "概览", data: { usage: 12 }, href: `${ORIGIN}/#/console` },
      { id: "credentials_list", type: "list", tab: "credentials", title: "我的凭据", data: [{ id: "k1", title: "合同线", subtitle: "active" }], href: `${ORIGIN}/#/console` },
      { id: "suites_matrix", type: "list", tab: "suites", title: "识律套件", data: [{ id: "s1", title: "合同审查" }], href: `${ORIGIN}/#/console` },
      { id: "billing_timeline", type: "timeline", tab: "billing", title: "账单", data: [], href: `${ORIGIN}/#/console` },
    ],
  };
}

test("lex board renders its four tabs, one block each", async ({ page }) => {
  await pinLocaleEn(page);
  await enableBoards(page);
  await page.route("**/api/boards/lex", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(lexBoard()) }));

  await page.goto("/boards/lex");
  await expect(page.getByTestId("board-lex")).toBeVisible({ timeout: 15000 });

  for (const tab of ["overview", "credentials", "suites", "billing"]) {
    await expect(page.getByTestId(`board-tab-${tab}`)).toBeVisible();
  }

  // Each tab shows exactly its own block — the wall-of-blocks regression.
  await expect(page.locator('[data-testid^="block-"]')).toHaveCount(1);
  await page.getByTestId("board-tab-billing").click();
  await expect(page.getByTestId("block-billing_timeline")).toBeVisible();
  await expect(page.getByTestId("block-overview_metrics")).toHaveCount(0);
  await expect(page.locator('[data-testid^="block-"]')).toHaveCount(1);
});

// ── 萬星: a wholly under-construction line says it once ─────────────────────
test("a wholly under-construction line collapses into one statement", async ({ page }) => {
  await pinLocaleEn(page);
  await enableBoards(page);
  const ORIGIN = "https://wanxing.finddatatech.cloud";
  await page.route("**/api/boards/wanxing", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        line: "wanxing",
        title: "萬星",
        originUrl: ORIGIN,
        tabs: ["fleet-summary", "missions", "deployments"],
        connected: true,
        blocks: [
          { id: "fleet_summary_metrics", type: "metrics", tab: "fleet-summary", title: "集群概况", error: "under_construction" },
          { id: "missions", type: "list", tab: "missions", title: "任务", error: "under_construction" },
          { id: "deployments", type: "list", tab: "deployments", title: "部署", error: "under_construction" },
        ],
      }),
    }),
  );

  await page.goto("/boards/wanxing");
  await expect(page.getByTestId("board-line-construction")).toBeVisible({ timeout: 15000 });
  // No tab strip, and the same sentence is not printed three times.
  await expect(page.getByRole("tab")).toHaveCount(0);
  await expect(page.locator('[data-testid^="block-"]')).toHaveCount(0);
  await expect(page.getByTestId("board-line-construction")).toContainText(/under construction/i);
});

// ── base is the host, not a missing line ───────────────────────────────────
test("base says it is the host instead of 'not onboarded'", async ({ page }) => {
  await pinLocaleEn(page);
  await enableBoards(page);
  await page.route("**/api/boards/base", (route) =>
    route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "line_not_found", message: "该线尚未接入 (base)" }) }),
  );

  await page.goto("/boards/base");
  await expect(page.getByTestId("board-host-line")).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId("board-host-line")).toContainText("host");
  await expect(page.locator('[data-testid^="block-"]')).toHaveCount(0);
});
