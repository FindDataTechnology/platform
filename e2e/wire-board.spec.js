import { test, expect } from "@playwright/test";
import { pinLocaleEn } from "./helpers.js";

// Wire line board sentinel (openspec: add-wire-line-board, tasks 3.3 / 3.4 /
// 5.2 / 5.3 / 7.1). The hermetic server has no wire credential and the
// deployment switch is OFF by default, so:
//   - the switch is exercised for real (default → disabled notice), and
//   - everything behind it is exercised by mocking /api/config (flip the
//     switch), /api/boards/wire (the adapter's three states) and the gate
//     routes (/api/actions/*) with page.route — no model, no 柏讯, no token.

const ORIGIN = "https://wire.finddatatech.cloud";
const CONNECT = "/settings/connections?panel=line-wire-customer";

function connectedBoard({ artifactsError = false } = {}) {
  return {
    line: "wire",
    title: "柏讯",
    originUrl: ORIGIN,
    // The API derives this from the adapter's own blocks (unify-line-board-tabs
    // D1); the mock mirrors the server so the page's single path is exercised.
    tabs: ["overview", "datasets", "artifacts", "demands"],
    connected: true,
    blocks: [
      {
        id: "overview_metrics",
        tab: "overview",
        type: "metrics",
        title: "概览",
        href: `${ORIGIN}/#/console/datasets`,
        data: { 数据集: 1, 产物: 2, 需求单: 2, 免费档配额: "1/3" },
        ...(artifactsError ? { partial: ["产物"] } : {}),
      },
      {
        id: "datasets_list",
        tab: "datasets",
        type: "list",
        title: "我的数据",
        href: `${ORIGIN}/#/console/datasets`,
        data: [{ id: "ds_1", title: "销售台账", subtitle: "csv", badges: ["免费档", "120 行"], href: `${ORIGIN}/#/console/datasets` }],
        actions: [{ id: "wire.dataset.create", label: "新建数据集", args: {} }],
      },
      artifactsError
        ? { id: "artifacts_list", type: "list", title: "产物", error: "柏讯返回 HTTP 500", href: `${ORIGIN}/#/console/artifacts` }
        : {
            id: "artifacts_list",
            tab: "artifacts",
            type: "list",
            title: "产物",
            href: `${ORIGIN}/#/console/artifacts`,
            data: [
              {
                id: 7,
                title: "进货单",
                subtitle: "form",
                badges: ["draft", "v2"],
                href: `${ORIGIN}/#/console/artifacts`,
                rowActions: [
                  { id: "wire.artifact.publish", label: "发布", args: { artifact_id: 7 } },
                  { id: "wire.artifact.archive", label: "归档", args: { artifact_id: 7 } },
                ],
              },
            ],
          },
      {
        id: "demands_timeline",
        tab: "demands",
        type: "timeline",
        title: "需求单",
        href: `${ORIGIN}/#/console/demands`,
        data: [{ id: 4, code: "D-0004", status: "queued", text: "D-0004 · queued · 门店清单", created_at: "2026-10-20T08:00:00Z", href: `${ORIGIN}/#/console/demands` }],
        links: [{ label: "去柏讯新建需求单", href: `${ORIGIN}/#/console/demands/new` }],
      },
    ],
  };
}

function unconnectedBoard(reason) {
  return {
    line: "wire",
    title: "柏讯",
    originUrl: ORIGIN,
    connected: false,
    reason,
    connectPath: CONNECT,
    blocks: [{ id: "connection", type: "metrics", title: "连接状态", data: { connected: false }, error: "x" }],
  };
}

const json = (body, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });

// Flip the deployment switch for the browser without touching the server env:
// the real /api/config answer with one field patched.
async function enableBoards(page) {
  await page.route("**/api/config", async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    body.lineBoardsEnabled = true;
    await route.fulfill({ response: res, json: body });
  });
}

function connectionsResponse(overrides) {
  const states = {
    registry: "disconnected",
    "facet-market": "disconnected",
    connector: "disconnected",
    "line-wire-customer": "disconnected",
    "line-lex": "disconnected",
    "ciyuan-account": "disconnected",
    "paper-trading": "disconnected",
    search: "not-configured",
    ...overrides,
  };
  return json({ connections: Object.entries(states).map(([id, state]) => ({ id, state })) });
}

test("switch off by default: /boards/wire renders the disabled notice and calls no board API", async ({ page }) => {
  await pinLocaleEn(page);
  const boardCalls = [];
  await page.route("**/api/boards/**", (route) => {
    boardCalls.push(route.request().url());
    route.fulfill(json({ error: "line_boards_disabled" }, 404));
  });
  await page.goto("/boards/wire");
  await expect(page.getByTestId("board-disabled")).toBeVisible({ timeout: 15000 });
  expect(boardCalls).toEqual([]);
});

test("connected: four real blocks across tabs, deep links into the 柏讯 console", async ({ page }) => {
  await pinLocaleEn(page);
  await enableBoards(page);
  await page.route("**/api/boards/wire", (route) => route.fulfill(json(connectedBoard())));
  await page.goto("/boards/wire");
  await expect(page.getByTestId("board-wire")).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId("board-unconnected")).toHaveCount(0);

  await expect(page.getByTestId("block-overview_metrics")).toBeVisible();
  await expect(page.getByTestId("block-overview_metrics")).toContainText("1/3");

  await page.getByTestId("board-tab-datasets").click();
  await expect(page.getByTestId("block-datasets_list")).toBeVisible();
  await expect(page.getByTestId("datasets_list-row")).toContainText("销售台账");
  await expect(page.getByTestId("block-datasets_list").locator(`a[href="${ORIGIN}/#/console/datasets"]`).first()).toBeVisible();

  await page.getByTestId("board-tab-artifacts").click();
  await expect(page.getByTestId("block-artifacts_list")).toBeVisible();
  await expect(page.getByTestId("row-action-wire.artifact.archive")).toBeVisible();
  await expect(page.getByTestId("row-action-wire.artifact.publish")).toBeVisible();

  await page.getByTestId("board-tab-demands").click();
  await expect(page.getByTestId("block-demands_timeline")).toBeVisible();
  await expect(page.getByTestId("demands_timeline-event")).toContainText("D-0004");
  await expect(page.getByTestId("block-demands_timeline").locator(`a[href="${ORIGIN}/#/console/demands/new"]`)).toBeVisible();
});

test("not connected: no data, connect pointer lands on the wire connection card", async ({ page }) => {
  await pinLocaleEn(page);
  await enableBoards(page);
  await page.route("**/api/boards/wire", (route) => route.fulfill(json(unconnectedBoard("not_connected"))));
  await page.goto("/boards/wire");
  await expect(page.getByTestId("board-unconnected")).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId("board-unconnected")).toContainText("Not connected");
  await expect(page.locator("[data-testid^='block-']")).toHaveCount(0);
  await page.getByTestId("board-connect").click();
  await expect(page).toHaveURL(/\/settings\/connections\?panel=line-wire-customer$/);
});

test("expired credential: re-authorize copy, never a paste-a-key prompt", async ({ page }) => {
  await pinLocaleEn(page);
  await enableBoards(page);
  await page.route("**/api/boards/wire", (route) => route.fulfill(json(unconnectedBoard("expired"))));
  await page.goto("/boards/wire");
  await expect(page.getByTestId("board-unconnected")).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId("board-unconnected")).toContainText("Session expired");
  await expect(page.getByTestId("board-unconnected")).toContainText("re-authorize");
  // ID-token line: re-authorize is a click, never a key to type in.
  await expect(page.getByTestId("board-unconnected").locator("input, textarea")).toHaveCount(0);
});

test("single-block failure degrades alone", async ({ page }) => {
  await pinLocaleEn(page);
  await enableBoards(page);
  await page.route("**/api/boards/wire", (route) => route.fulfill(json(connectedBoard({ artifactsError: true }))));
  await page.goto("/boards/wire");
  await expect(page.getByTestId("board-wire")).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId("block-overview_metrics-partial")).toContainText("产物");
  await page.getByTestId("board-tab-artifacts").click();
  await expect(page.getByTestId("block-artifacts_list-error")).toContainText("HTTP 500");
  await page.getByTestId("board-tab-datasets").click();
  await expect(page.getByTestId("datasets_list-row")).toHaveCount(1);
});

test("inline archive: propose → confirmation card → confirm executes; nothing executes before confirm", async ({ page }) => {
  await pinLocaleEn(page);
  await enableBoards(page);
  await page.route("**/api/boards/wire", (route) => route.fulfill(json(connectedBoard())));
  const proposals = [];
  const approvals = [];
  await page.route("**/api/actions/propose", (route) => {
    proposals.push(route.request().postDataJSON());
    route.fulfill(
      json({
        proposalId: "p-archive-1",
        state: "pending",
        impact: "归档产物 #7（可逆：可在柏讯控制台 restore）",
        risk: "write",
        target: "cloud",
        tier: "inline",
        userFilledArgs: [],
      }),
    );
  });
  await page.route("**/api/actions/p-archive-1/approve", (route) => {
    approvals.push(route.request().postDataJSON());
    route.fulfill(json({ state: "executed", resultSummary: "artifact 7 archived" }));
  });

  await page.goto("/boards/wire#artifacts");
  await expect(page.getByTestId("row-action-wire.artifact.archive")).toBeVisible({ timeout: 15000 });
  await page.getByTestId("row-action-wire.artifact.archive").click();

  await expect(page.getByTestId("action-card-pending")).toBeVisible();
  expect(proposals).toEqual([{ actionId: "wire.artifact.archive", args: { artifact_id: 7 } }]);
  expect(approvals).toEqual([]); // the gate executes nothing before the user confirms
  await expect(page.getByTestId("action-card-pending")).toContainText("可逆");
  await expect(page.getByTestId("action-confirm")).toBeEnabled();

  await page.getByTestId("action-confirm").click();
  await expect(page.getByTestId("action-card-executed")).toBeVisible();
  await expect(page.getByTestId("action-card-summary")).toContainText("artifact 7 archived");
  expect(approvals).toEqual([{ userArgs: {} }]);
});

test("user-filled fields: confirm stays disabled until filled; approve carries exactly the user values; cost tier shows double-confirm", async ({ page }) => {
  await pinLocaleEn(page);
  await enableBoards(page);
  await page.route("**/api/boards/wire", (route) => route.fulfill(json(connectedBoard())));
  const approvals = [];
  // The server strips model compliance values and returns the schema; the
  // card must render the two fields EMPTY and gate the confirm on them.
  await page.route("**/api/actions/propose", (route) =>
    route.fulfill(
      json({
        proposalId: "p-demand-1",
        state: "pending",
        impact: "提交需求单「竞品价格」（公开源 URL 与公开数据声明由你亲自填写，不采纳模型取值）",
        risk: "cost",
        target: "cloud",
        tier: "second",
        userFilledArgs: [
          { key: "source_urls", label: "公开源 URL", kind: "url[]", required: true },
          { key: "public_data_asserted", label: "公开数据声明", kind: "boolean", required: true },
        ],
      }),
    ),
  );
  await page.route("**/api/actions/p-demand-1/approve", (route) => {
    approvals.push(route.request().postDataJSON());
    route.fulfill(json({ state: "executed", resultSummary: "demand D-0100 created" }));
  });

  await page.goto("/boards/wire#datasets");
  await expect(page.getByTestId("block-action-wire.dataset.create")).toBeVisible({ timeout: 15000 });
  await page.getByTestId("block-action-wire.dataset.create").click();

  await expect(page.getByTestId("action-card-pending")).toBeVisible();
  await expect(page.getByTestId("action-card-pending")).toContainText("Double confirm");
  await expect(page.getByTestId("action-user-fill")).toBeVisible();
  await expect(page.getByTestId("action-field-source_urls")).toHaveValue("");
  await expect(page.getByTestId("action-field-public_data_asserted")).not.toBeChecked();
  await expect(page.getByTestId("action-confirm")).toBeDisabled();

  await page.getByTestId("action-field-source_urls").fill("https://public.test/a\nhttps://public.test/b");
  await expect(page.getByTestId("action-confirm")).toBeDisabled(); // the declaration is still unchecked
  await page.getByTestId("action-field-public_data_asserted").check();
  await expect(page.getByTestId("action-confirm")).toBeEnabled();

  await page.getByTestId("action-confirm").click();
  await expect(page.getByTestId("action-card-executed")).toBeVisible();
  expect(approvals).toEqual([
    { userArgs: { source_urls: ["https://public.test/a", "https://public.test/b"], public_data_asserted: true } },
  ]);
});

test("upstream 422 shows the field errors verbatim and marks the proposal failed", async ({ page }) => {
  await pinLocaleEn(page);
  await enableBoards(page);
  await page.route("**/api/boards/wire", (route) => route.fulfill(json(connectedBoard())));
  await page.route("**/api/actions/propose", (route) =>
    route.fulfill(json({ proposalId: "p-422", state: "pending", impact: "归档产物 #7", risk: "write", target: "cloud", tier: "inline", userFilledArgs: [] })),
  );
  await page.route("**/api/actions/p-422/approve", (route) =>
    route.fulfill(
      json(
        {
          error: "execution failed",
          state: "failed",
          code: "upstream_422",
          message: '[{"loc":["body","artifact_id"],"msg":"already archived","type":"value_error"}]',
          fields: [{ field: "artifact_id", message: "already archived", type: "value_error" }],
        },
        422,
      ),
    ),
  );
  await page.goto("/boards/wire#artifacts");
  await page.getByTestId("row-action-wire.artifact.archive").click({ timeout: 15000 });
  await page.getByTestId("action-confirm").click();
  await expect(page.getByTestId("action-card-failed")).toBeVisible();
  await expect(page.getByTestId("action-card-fields")).toContainText("artifact_id");
  await expect(page.getByTestId("action-card-fields")).toContainText("already archived");
});

test("app center: wire card offers the board on its own credential (partial aggregate), keeps 打开原站, no early badge", async ({ page }) => {
  await pinLocaleEn(page);
  await enableBoards(page);
  await page.route("**/api/connections", (route) => route.fulfill(connectionsResponse({ "line-wire-customer": "connected" })));
  await page.goto("/apps");
  await expect(page.getByTestId("app-center-page")).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId("app-card-wire-connection-badge")).toHaveAttribute("data-state", "partial");
  await expect(page.getByTestId("app-card-wire-board")).toBeVisible();
  await expect(page.getByTestId("app-card-wire-open")).toHaveAttribute("href", ORIGIN);
  await expect(page.getByTestId("app-card-wire-early-badge")).toHaveCount(0);
  await page.route("**/api/boards/wire", (route) => route.fulfill(json(connectedBoard())));
  await page.getByTestId("app-card-wire-board").click();
  await expect(page).toHaveURL(/\/boards\/wire$/);
  await expect(page.getByTestId("board-wire")).toBeVisible();
});

test("app center: switch off → no board action on any card even when connected", async ({ page }) => {
  await pinLocaleEn(page);
  await page.route("**/api/connections", (route) =>
    route.fulfill(connectionsResponse({ "line-wire-customer": "connected", "paper-trading": "connected", "facet-market": "connected" })),
  );
  await page.goto("/apps");
  await expect(page.getByTestId("app-center-page")).toBeVisible({ timeout: 15000 });
  for (const id of ["facet", "wanxing", "wire"]) {
    await expect(page.getByTestId(`app-card-${id}-board`)).toHaveCount(0);
    await expect(page.getByTestId(`app-card-${id}-open`)).toBeVisible();
  }
});
