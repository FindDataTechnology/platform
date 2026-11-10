import { test, expect } from "@playwright/test";
import { pinLocaleEn } from "./helpers.js";

// App center sentinel (openspec: app-center-unified-grid 5.x): nav
// reachability, ONE grid with brand-ordered cards (brand cards + the bundled
// catalog products 壹座·Packs / 萬星·词元 / 萬星·连接器), the platform-self
// card has no outbound link, early lines wear the honest badge, outbound
// links carry the right hrefs, the embedded product routes in-app, and the
// connection badges / connect actions follow /api/connections. The hermetic
// store reports every connection disconnected, so the four badge states are
// exercised by mocking the endpoint with page.route.

const GRID_ORDER = [
  "yizuo",
  "yizuo-packs",
  "facet",
  "wanxing",
  "wanxing-token",
  "wanxing-connector",
  "lex",
  "wire",
  // agents.json gained the CRM desk (add-crm-desk-pack-embed) without this
  // list following; the grid renders it between the brand line and templates.
  "crm-desk",
  "fleet-templates",
];

const BADGED = ["yizuo-packs", "facet", "wanxing-token", "wanxing-connector", "lex", "wire"];

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
  return {
    contentType: "application/json",
    body: JSON.stringify({ connections: Object.entries(states).map(([id, state]) => ({ id, state })) }),
  };
}

test("nav item reaches the app center", async ({ page }) => {
  await pinLocaleEn(page);
  await page.goto("/chat");
  await expect(page.getByTestId("nav-apps")).toBeVisible({ timeout: 15000 });
  await page.getByTestId("nav-apps").click();
  await expect(page.getByTestId("app-center-page")).toBeVisible();
});

test("a revisit paints the catalog in full from cache — no placeholders (polish-web-surfaces)", async ({
  page,
}) => {
  await pinLocaleEn(page);
  await page.goto("/chat");
  await expect(page.getByTestId("nav-apps")).toBeVisible({ timeout: 15000 });

  // First visit: the catalog lands and the product placeholders clear.
  await page.getByTestId("nav-apps").click();
  await expect(page.getByTestId("app-card-skeleton")).toHaveCount(0, { timeout: 15000 });
  await expect(page.getByTestId("app-card-yizuo-packs")).toBeVisible();

  // Leave and return WITHOUT a page reload (the client cache is what is under
  // test): the product cards paint immediately, so no placeholder frame shows.
  await page.getByTestId("nav-chat").click();
  await expect(page.getByTestId("app-center-page")).toHaveCount(0);
  await page.getByTestId("nav-apps").click();
  await expect(page.getByTestId("app-center-page")).toBeVisible();
  await expect(page.getByTestId("app-card-yizuo-packs")).toBeVisible();
  await expect(page.getByTestId("app-card-skeleton")).toHaveCount(0);
});

test("one grid renders ten cards in brand order, retired sections gone", async ({ page }) => {
  await pinLocaleEn(page);
  await page.goto("/apps");
  await expect(page.getByTestId("app-center-page")).toBeVisible({ timeout: 15000 });

  // The two retired section containers must not come back.
  await expect(page.getByTestId("app-center-lines")).toHaveCount(0);
  await expect(page.getByTestId("app-center-platform-apps")).toHaveCount(0);

  // Cached-first paint (polish-web-surfaces): while the catalog lands the
  // product slots are placeholders, so wait for them to settle before reading
  // the final card order.
  await expect(page.getByTestId("app-card-skeleton")).toHaveCount(0, { timeout: 15000 });

  const ids = await page.getByTestId("app-center-grid").evaluate((el) =>
    Array.from(el.children).map((c) => (c.dataset.testid ?? "").replace(/^app-card-/, "")),
  );
  expect(ids).toEqual(GRID_ORDER);

  // The platform itself: "you are here", no outbound link.
  await expect(page.getByTestId("app-card-yizuo-self")).toBeVisible();
  await expect(page.getByTestId("app-card-yizuo-open")).toHaveCount(0);

  // The badge follows the board, not the roadmap: every line has one now, so
  // no card wears it (wire dropped it in add-wire-line-board, lex in
  // add-lex-line-board — appCatalog.ts is the source of truth).
  await expect(page.getByTestId("app-card-lex-early-badge")).toHaveCount(0);
  await expect(page.getByTestId("app-card-wire-early-badge")).toHaveCount(0);
  await expect(page.getByTestId("app-card-facet-early-badge")).toHaveCount(0);
});

test("open actions: brand and product hrefs out, embedded product routes in-app", async ({ page }) => {
  await pinLocaleEn(page);
  await page.goto("/apps");
  await expect(page.getByTestId("app-center-page")).toBeVisible({ timeout: 15000 });

  await expect(page.getByTestId("app-card-facet-open")).toHaveAttribute(
    "href",
    "https://facet.finddatatech.cloud",
  );
  await expect(page.getByTestId("app-card-wanxing-open")).toHaveAttribute(
    "href",
    "https://wanxing.finddatatech.cloud",
  );
  await expect(page.getByTestId("app-card-lex-open")).toHaveAttribute(
    "href",
    "https://lex.finddatatech.cloud",
  );
  await expect(page.getByTestId("app-card-wire-open")).toHaveAttribute(
    "href",
    "https://wire.finddatatech.cloud",
  );
  // Products from the bundled agents.json carry their authored urls.
  await expect(page.getByTestId("app-card-yizuo-packs-open")).toHaveAttribute(
    "href",
    "https://mcp.finddatatech.cloud",
  );
  await expect(page.getByTestId("app-card-wanxing-connector-open")).toHaveAttribute(
    "href",
    "https://connector.finddatatech.cloud",
  );

  // The embedded external-service product opens the in-app proxy route.
  await page.getByTestId("app-card-wanxing-token-open").click();
  await expect(page).toHaveURL(/\/external\/wanxing-token$/);
});

test("fresh store: six cards disconnected with connect actions; two brand cards badge-free", async ({ page }) => {
  await pinLocaleEn(page);
  await page.goto("/apps");
  await expect(page.getByTestId("app-center-page")).toBeVisible({ timeout: 15000 });

  for (const id of BADGED) {
    await expect(page.getByTestId(`app-card-${id}-connection-badge`)).toHaveAttribute(
      "data-state",
      "disconnected",
    );
    await expect(page.getByTestId(`app-card-${id}-connect`)).toBeVisible();
  }
  // 壹座 and 萬星 are brand umbrellas: no badge, no connect action.
  await expect(page.getByTestId("app-card-yizuo-connection-badge")).toHaveCount(0);
  await expect(page.getByTestId("app-card-yizuo-connect")).toHaveCount(0);
  await expect(page.getByTestId("app-card-wanxing-connection-badge")).toHaveCount(0);
  await expect(page.getByTestId("app-card-wanxing-connect")).toHaveCount(0);

  // 去连接 lands on the connections section with the right panel highlighted.
  await page.getByTestId("app-card-wanxing-token-connect").click();
  await expect(page).toHaveURL(/\/settings\/connections\?panel=ciyuan-account$/);
  await expect(page.locator("[data-panel-active='true']")).toHaveCount(1);
});

test("ciyuan account binding turns the 词元 card green", async ({ page }) => {
  await pinLocaleEn(page);
  await page.route("**/api/connections", (route) =>
    route.fulfill(connectionsResponse({ "ciyuan-account": "connected" })),
  );
  await page.goto("/apps");
  await expect(page.getByTestId("app-center-page")).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId("app-card-wanxing-token-connection-badge")).toHaveAttribute(
    "data-state",
    "connected",
  );
  await expect(page.getByTestId("app-card-wanxing-token-connect")).toHaveCount(0);
});

test("partial: wire card shows partial and connects the missing leg first", async ({ page }) => {
  await pinLocaleEn(page);
  await page.route("**/api/connections", (route) =>
    route.fulfill(connectionsResponse({ "line-wire-customer": "connected" })),
  );
  await page.goto("/apps");
  await expect(page.getByTestId("app-center-page")).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId("app-card-wire-connection-badge")).toHaveAttribute(
    "data-state",
    "partial",
  );
  await page.getByTestId("app-card-wire-connect").click();
  await expect(page).toHaveURL(/\/settings\/connections\?panel=paper-trading$/);
});

test("stale: connector card demands a re-connect", async ({ page }) => {
  await pinLocaleEn(page);
  await page.route("**/api/connections", (route) =>
    route.fulfill(connectionsResponse({ connector: "stale" })),
  );
  await page.goto("/apps");
  await expect(page.getByTestId("app-center-page")).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId("app-card-wanxing-connector-connection-badge")).toHaveAttribute(
    "data-state",
    "stale",
  );
});

test("connected: facet card goes quiet — badge green, no connect action", async ({ page }) => {
  await pinLocaleEn(page);
  await page.route("**/api/connections", (route) =>
    route.fulfill(connectionsResponse({ "facet-market": "connected" })),
  );
  await page.goto("/apps");
  await expect(page.getByTestId("app-center-page")).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId("app-card-facet-connection-badge")).toHaveAttribute(
    "data-state",
    "connected",
  );
  await expect(page.getByTestId("app-card-facet-connect")).toHaveCount(0);
});

test("nango-connect products render a Connect action through the broker", async ({ page }) => {
  await pinLocaleEn(page);
  // A nango product joins the catalog (the retired Agents-page Apps tab's
  // entry kind): the card's primary action mints a connect session via the
  // platform broker — never a raw outbound link.
  await page.route("**/api/catalog", async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    body.apps = [
      ...(body.apps ?? []),
      { id: "lex-calendar", kind: "nango-connect", name: "Calendar", url: "https://nango.example/c" },
    ];
    await route.fulfill({ response: res, json: body });
  });
  const seen = [];
  await page.route("**/api/apps/lex-calendar/connect", async (route) => {
    seen.push(route.request().method());
    await route.fulfill({ json: { url: "https://connect.example/session?token=1" } });
  });
  await page.goto("/apps");
  const card = page.getByTestId("app-card-lex-calendar");
  await expect(card).toBeVisible({ timeout: 15000 });
  await expect(card.getByTestId("app-card-lex-calendar-nango-connect")).toBeVisible();
  await card.getByTestId("app-card-lex-calendar-nango-connect").click();
  await expect.poll(() => seen).toEqual(["POST"]);
  // The broker's URL took the browser off the app (the fake host cannot
  // resolve — chrome-error is the honest outcome; what matters is the mint
  // happened and the app was left).
  await expect
    .poll(() => page.url())
    .not.toMatch(/127\.0\.0\.1/);
});

test("nango-connect failure stays on the card, named", async ({ page }) => {
  await pinLocaleEn(page);
  await page.route("**/api/catalog", async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    body.apps = [
      ...(body.apps ?? []),
      { id: "lex-calendar", kind: "nango-connect", name: "Calendar", url: "https://nango.example/c" },
    ];
    await route.fulfill({ response: res, json: body });
  });
  await page.route("**/api/apps/lex-calendar/connect", async (route) => {
    await route.fulfill({ status: 400, json: { error: "Authentication required" } });
  });
  await page.goto("/apps");
  const card = page.getByTestId("app-card-lex-calendar");
  await card.getByTestId("app-card-lex-calendar-nango-connect").click();
  await expect(card.getByTestId("app-card-lex-calendar-nango-error")).toHaveText("Authentication required");
  await expect(page).toHaveURL(/\/apps/);
});

test("status endpoint failure: badges and connect actions vanish, cards stay", async ({ page }) => {
  await pinLocaleEn(page);
  await page.route("**/api/connections", (route) => route.fulfill({ status: 500, body: "" }));
  await page.goto("/apps");
  await expect(page.getByTestId("app-center-page")).toBeVisible({ timeout: 15000 });

  await expect(page.locator("[data-testid$='-connection-badge']")).toHaveCount(0);
  await expect(page.locator("[data-testid$='-connect']")).toHaveCount(0);
  // The rest of the card is unaffected.
  for (const id of GRID_ORDER) {
    await expect(page.getByTestId(`app-card-${id}`)).toBeVisible();
  }
  await expect(page.getByTestId("app-card-facet-open")).toHaveAttribute(
    "href",
    "https://facet.finddatatech.cloud",
  );
});
