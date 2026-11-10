// RETIRED 2026-11-08 (add-supply-studio-migration 4.1/4.6): the workspace and
// its /api/blueprints plane moved to the supply domain — this server no longer
// mounts those routes, so the platform-side authoring surface never renders here
// (verified: the whole group fails at seed/render). Coverage moved to the facet
// host; the live walkthrough is the record (tasks.md 5.2/5.3). Kept, skipped.
// agent-studio-starter.spec.js — 8.2: the empty library's official-starter
// picker seeds a document through the SAME createBlueprint lane. The fast
// lane's market is the registry stub's roster, so the test seeds its own
// official-looking pack detail via route mock (the /api/packs/official list
// and the /api/packs/:id manifest — the two read faces the picker uses; the
// REAL shelf's projections are the production walkthrough's job).
import { test, expect } from "@playwright/test";
import { pinLocaleEn } from "./helpers.js";

const PACK_ID = "pk_starter_seed";

test.describe.skip("official starter seeds (retired to the supply domain — see header)", () => {
  test("empty library → starter picker → seed a validating document", async ({ page }) => {
    await pinLocaleEn(page);
    await page.route("**/api/packs/official", (r) =>
      r.fulfill({ json: { templates: [
        { id: PACK_ID, name: "Morning Digest Crew", description: "Watch, digest, report.", category: "fleet", version: 2 },
      ] } }));
    await page.route(`**/api/packs/${PACK_ID}`, (r) =>
      r.fulfill({ json: { pack: {
        id: PACK_ID, name: "Morning Digest Crew",
        manifest: {
          name: "Morning Digest Crew",
          description: "Watch, digest, report.",
          agents: [{ id: "agent-1", name: "Watcher", persona: "Watch things." }],
          fleet: {
            name: "Morning Digest Crew",
            members: [{ ref: "agent-1", title: "Watcher", target: { kind: "existing-persona", id: "agent-1" } }],
            orchestration: { pattern: "solo" },
          },
          mcpServers: [],
        },
      } } }));
    await page.goto("/studio");
    const empty = page.getByTestId("ws-library-empty");
    await expect(empty).toBeVisible({ timeout: 20000 });
    await page.getByTestId("ws-library-starters-toggle").click();
    const item = page.getByTestId(`ws-starter-${PACK_ID}`);
    await expect(item).toBeVisible();
    await item.click();
    // The seeded document opens; its boundary name is the pack's display name.
    await expect(page).toHaveURL(/\/studio\?doc=bp_/, { timeout: 15000 });
    await expect(page.getByTestId("ws-doc-name")).toHaveValue("Morning Digest Crew", { timeout: 15000 });
    // The seed validates clean against the REAL chain — openDoc auto-validates.
    await expect(page.getByTestId("ws-validation-ok")).toBeVisible({ timeout: 20000 });
  });
});
