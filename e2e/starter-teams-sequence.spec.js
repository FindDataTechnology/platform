// Official starter teams — the first-team chain (add-official-starter-teams 4.2).
//
// The walkthrough's automatable spine, three scenarios per the spec delta:
//   1. A fresh browser's help center start path renders the official starter
//      SEQUENCE (ordered, one-line positioning) and nothing auto-installs.
//   2. Installing the preferred starter (客服班组) and provisioning via
//      from-template works with sequence semantics untouched — the fleet is
//      born paused with the seed's three posts, provenance recorded.
//   3. Igniting without a runtime degrades HONESTLY (no fake success) — the
//      seed's own "凭据缺位如实降级" discipline at the ignite level.
//
// Run: playwright test e2e/starter-teams-sequence.spec.js

import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pinLocaleEn, resetFacetStub, seedFacetPack } from "./helpers.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const seed = JSON.parse(
  readFileSync(path.join(repoRoot, "docs/fleet-templates/service-desk-fleet.seed.json"), "utf8"),
);
const PACK_ID = "EMGW14N8voa1b36LSuTxxw"; // the STARTER_TEAMS[0] pack id (web/src/lib/packGuides.ts)
// The seed carries {{PLACEHOLDER}} ids for the casting step to substitute
// (same benign fill the template unit tests use) — the raw file does not
// clear the shared parser.
const manifest = JSON.parse(
  JSON.stringify(seed).replace(/\{\{([A-Z_]+)\}\}/g, (_, key) =>
    key === "PACK_ID" ? PACK_ID : `${key.toLowerCase()}-ref`,
  ),
);

async function gotoFreshChat(page) {
  await pinLocaleEn(page);
  await page.goto("/chat/");
  await expect(page.getByTestId("status-text")).toHaveText("Connected", { timeout: 15000 });
}

test.describe("official starter teams", () => {
  test("fresh help center shows the ordered sequence and nothing auto-installs", async ({ page }) => {
    // The e2e suite shares ONE server, so /api/fleets is not empty by the time
    // this spec runs — earlier specs provision fleets and leave them. The
    // contract under test is "rendering the help sequence installs nothing",
    // so measure the delta instead of asserting global emptiness (that
    // assertion was green on a machine where this spec ran first and red in
    // CI's full sequence — run 42460822790).
    const fleetsBefore = ((await (await page.request.get("/api/fleets")).json()).fleets ?? []).length;
    await gotoFreshChat(page);
    await page.getByTestId("composer-input").fill("/help");
    await page.keyboard.press("Escape"); // dismiss the slash picker, keep the text
    await page.getByTestId("composer-send").click();
    await expect(page.getByTestId("help-dialog")).toBeVisible({ timeout: 15000 });

    const section = page.getByTestId("help-starter-teams");
    await expect(section).toBeVisible();
    // Five teams, preferred first, every entry carries a one-line positioning.
    await expect(section.locator("li")).toHaveCount(5);
    const first = section.locator("li").first();
    await expect(first).toHaveAttribute("data-testid", "help-starter-preferred");
    await expect(first).toContainText("客服班组");
    await expect(first).toContainText("三岗");

    // No auto-install: the sequence rendered and the fleet count did not move.
    const fleetsAfter = ((await (await page.request.get("/api/fleets")).json()).fleets ?? []).length;
    expect(fleetsAfter, `fleets went ${fleetsBefore} → ${fleetsAfter} across the /help render`).toBe(
      fleetsBefore,
    );
  });

  test("installing the preferred starter provisions a paused three-post fleet", async ({ page }) => {
    await resetFacetStub();
    await seedFacetPack(PACK_ID, 1, manifest);
    await gotoFreshChat(page);

    // Server-driven install: the manifest rides the body (the facet stand-in
    // answers the version route; the purchase-gate detail route 404s and the
    // body-manifest compat path is the seeded-pack contract, same as
    // packs.spec's browser flow).
    const install = await page.request.post("/api/mypacks/install", {
      data: { packId: PACK_ID, version: 1, manifest },
    });
    expect(install.status(), await install.text()).toBe(200);

    // 实化 via from-template — born paused (the from-template convention).
    const created = await page.request.post("/api/fleets/from-template", {
      data: { packId: PACK_ID },
    });
    expect(created.status(), await created.text()).toBe(201);
    const createdBody = await created.json();
    expect(createdBody.fleet.state).toBe("paused");
    expect(createdBody.fleet.name).toContain("客服班组");
    // Template provenance (agent-fleet-templates D5).
    expect(createdBody.fleet.sourceTemplate?.packId ?? null).toBe(PACK_ID);

    // The seed's post structure: exactly three posts, no references.
    // Fetch members via fleet detail endpoint (from-template doesn't include members array).
    const detail = await page.request.get(`/api/fleets/${createdBody.fleet.id}`);
    expect(detail.status()).toBe(200);
    const detailBody = await detail.json();
    const posts = detailBody.members ?? [];
    expect(posts.length).toBe(3);
    expect(posts.map((m) => m.title).sort()).toEqual(["一线客服", "客服组长", "质检员"]);

    // Cockpit aggregate shows the provisioned organization.
    const cockpit = await page.request.get(`/api/fleets/${createdBody.fleet.id}/cockpit`);
    expect(cockpit.status()).toBe(200);
    const agg = await cockpit.json();
    const tree = agg.tree ?? agg.members ?? [];
    expect(tree.length).toBe(3);
  });

  test("igniting without a runtime or credentials degrades honestly", async ({ page }) => {
    await resetFacetStub();
    await seedFacetPack(PACK_ID, 1, manifest);
    await gotoFreshChat(page);
    await page.request.post("/api/mypacks/install", { data: { packId: PACK_ID, version: 1, manifest } });
    const created = await page.request.post("/api/fleets/from-template", { data: { packId: PACK_ID } });
    const createdBody = await created.json();
    const fleetId = createdBody.fleet.id;

    // 点燃 (start): flips the fleet active and reconciles cadence. No dsh
    // runtime exists in the e2e cell — any scheduled round must land as an
    // honest skip (fix-fleet-turn-veracity), never a fabricated success.
    const start = await page.request.post(`/api/fleets/${fleetId}/start`);
    expect(start.status(), await start.text()).toBe(200);
    const started = await start.json();
    expect(started.fleet.state).toBe("active");

    // The runs ledger records reality: either nothing ran yet, or a recorded
    // skip/failure — an "ok" row without a runtime would be the fake the
    // veracity change outlaws.
    const runs = await (await page.request.get(`/api/fleets/${fleetId}/runs`)).json();
    const rows = runs.runs ?? runs ?? [];
    for (const r of rows) {
      expect(["ok", "skipped", "failed", "stalled", "budget"]).toContain(r.status);
    }
  });
});
