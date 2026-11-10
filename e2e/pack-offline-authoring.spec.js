// ── Offline pack authoring e2e (add-offline-pack-authoring, fast lane) ──────
//
// The full authoring loop against the REAL cell (the e2e webServer runs the
// real server on a temp store — no mocks): create a draft with content →
// export it as a `.yizpack` download → import that very file back as a NEW
// editable draft → nothing was installed anywhere.
//
//   npm run test:e2e -- e2e/pack-offline-authoring.spec.js

import fs from "node:fs";
import { expect, test } from "@playwright/test";
import { pinLocaleEn } from "./helpers.js";

const DRAFT_NAME = `Offline Authoring ${Date.now()}`;

test.beforeEach(async ({ page }) => {
  await pinLocaleEn(page);
});

test("draft → .yizpack download → import as a new draft, nothing installed", async ({ page }) => {
  // A draft with real content (skill tree + serving agent + guide), seeded
  // through the cell's own CRUD.
  const created = await page.request.post("/api/pack-drafts", {
    data: {
      name: DRAFT_NAME,
      description: "authored offline",
      tags: ["offline"],
      entries: {
        skills: [{ name: "offline-skill", description: "d", content: "# body\n" }],
        agents: [{ id: "offline-worker", name: "Offline Worker", persona: "w", serving: { protocol: "a2a" } }],
        mcpServers: [],
      },
    },
  });
  expect(created.ok()).toBeTruthy();
  const { draft } = await created.json();

  test.setTimeout(120_000);
  await page.goto("/packs");
  await expect(page.getByTestId("agent-market-page")).toBeVisible({ timeout: 15_000 });
  await page.getByTestId("agent-market-tab-mine").click();
  await page.locator(`[data-testid^="pack-draft-item-"]`).filter({ hasText: DRAFT_NAME }).first().click();
  await expect(page.getByTestId("pack-editor")).toBeVisible({ timeout: 15_000 });

  // Export → a real file download.
  const downloadPromise = page.waitForEvent("download");
  await page.getByTestId("pack-draft-export").click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^offline-authoring-.*\.yizpack$/);
  const exportedPath = await download.path();
  expect(fsStatSize(exportedPath)).toBeGreaterThan(100);

  // Import the very same file back — a NEW editable draft appears.
  await page.getByTestId("pack-draft-import-input").setInputFiles({
    name: "roundtrip.yizpack",
    mimeType: "application/zip",
    buffer: fsRead(exportedPath),
  });
  await expect(page.getByTestId("pack-import-result")).toContainText(DRAFT_NAME, { timeout: 15_000 });

  // The store now carries TWO drafts (original + imported) and ZERO installs.
  const drafts = (await page.request.get("/api/pack-drafts").then((r) => r.json())).drafts ?? [];
  expect(drafts.length).toBe(2);
  const imported = drafts.find((d) => d.id !== draft.id);
  expect(imported.entries.skills?.[0]?.name).toBe("offline-skill");
  expect(imported.entries.agents?.[0]?.serving?.protocol).toBe("a2a");

  const mine = await page.request.get("/api/mypacks").then((r) => r.json());
  expect((mine.packs ?? []).length).toBe(0);
});

function fsStatSize(p) {
  return fs.statSync(p).size;
}
function fsRead(p) {
  return fs.readFileSync(p);
}
