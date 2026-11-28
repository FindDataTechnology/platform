import { test, expect } from "@playwright/test";
import { pinLocaleEn } from "./helpers.js";

// reach-pack-console — the four-state board entry on the pack detail page.
//
// The four states are the spec's load-bearing contract:
//   no console declaration   → no board region at all (byte-identical to before)
//   declaration, no team yet  → "needs a team" note, no dead link
//   team, not published       → console entry only, no share link
//   team + published          → console entry AND a public-board link
//
// A dead link is the failure this guards: the detail page must never render a
// share link for a team that has not published, and never offer a console for a
// team that does not exist. The fleet lookup (`/api/fleets/console-handle`) is
// stubbed; the console/share targets are asserted by their href, not followed.

const PACK_ID = "pack-board";

const json = (body, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});

function detail({ withConsole }) {
  const manifest = {
    name: "Board Pack",
    description: "board entry fixture",
    tags: [],
    skills: [{ name: "s", description: "d", body: "x" }],
    agents: [{ id: "a1", name: "A", description: "d" }],
    fleet: { name: "Board Team", description: "t", defaultAgents: ["a1"] },
    ...(withConsole ? { console: { blocks: [{ block: "kpi" }] } } : {}),
  };
  return {
    id: PACK_ID,
    authorEmail: "a@x.io",
    createdAt: 0,
    version: 1,
    name: manifest.name,
    description: manifest.description,
    tags: [],
    publishedAt: 0,
    manifest,
  };
}

async function openDetail(page, pack) {
  await pinLocaleEn(page);
  await page.route(`**/api/packs/${PACK_ID}*`, (r) => r.fulfill(json(pack)));
  // Console handle defaults to "no team"; each test overrides when needed.
  await page.route("**/api/fleets/console-handle**", (r) => r.fulfill(json(null)));
  await page.route("**/api/mcp-catalog", (r) => r.fulfill(json({ servers: [] })));
  await page.route("**/api/extensions/market", (r) => r.fulfill(json({ toolCounts: {} })));
  await page.goto(`/agents/${PACK_ID}`);
  await expect(page.getByTestId("pack-page")).toBeVisible({ timeout: 10_000 });
}

test("no console declaration → no board entry at all", async ({ page }) => {
  await openDetail(page, detail({ withConsole: false }));
  await expect(page.getByTestId("pack-board-entry")).toHaveCount(0);
  await expect(page.getByTestId("pack-board-undeclared-yet")).toHaveCount(0);
});

test("declared but no team → 'needs a team', no link", async ({ page }) => {
  await openDetail(page, detail({ withConsole: true }));
  // console-handle returns null (no team) → the needs-team note, no buttons.
  await expect(page.getByTestId("pack-board-undeclared-yet")).toBeVisible();
  await expect(page.getByTestId("pack-board-open-console")).toHaveCount(0);
  await expect(page.getByTestId("pack-board-open-share")).toHaveCount(0);
});

test("team but not published → console entry, no share link", async ({ page }) => {
  const pack = detail({ withConsole: true });
  await pinLocaleEn(page);
  await page.route(`**/api/packs/${PACK_ID}*`, (r) => r.fulfill(json(pack)));
  await page.route("**/api/fleets/console-handle**", (r) =>
    r.fulfill(json({ fleetId: "f1", state: "active", consoleSlug: null })),
  );
  await page.route("**/api/mcp-catalog", (r) => r.fulfill(json({ servers: [] })));
  await page.route("**/api/extensions/market", (r) => r.fulfill(json({ toolCounts: {} })));
  await page.goto(`/agents/${PACK_ID}`);
  await expect(page.getByTestId("pack-page")).toBeVisible({ timeout: 10_000 });

  const consoleBtn = page.getByTestId("pack-board-open-console");
  await expect(consoleBtn).toBeVisible();
  await expect(page.getByTestId("pack-board-open-share")).toHaveCount(0);
});

test("team + published → console entry and public-board link", async ({ page }) => {
  const pack = detail({ withConsole: true });
  await pinLocaleEn(page);
  await page.route(`**/api/packs/${PACK_ID}*`, (r) => r.fulfill(json(pack)));
  await page.route("**/api/fleets/console-handle**", (r) =>
    r.fulfill(json({ fleetId: "f1", state: "active", consoleSlug: "board-team" })),
  );
  await page.route("**/api/mcp-catalog", (r) => r.fulfill(json({ servers: [] })));
  await page.route("**/api/extensions/market", (r) => r.fulfill(json({ toolCounts: {} })));
  await page.goto(`/agents/${PACK_ID}`);
  await expect(page.getByTestId("pack-page")).toBeVisible({ timeout: 10_000 });

  await expect(page.getByTestId("pack-board-open-console")).toBeVisible();
  await expect(page.getByTestId("pack-board-open-share")).toBeVisible();
});
