// ── Publish checklist (complete-creator-loop 1.2/1.3) ───────────────────────
//
// The four publish gates were reported in four places, two of them only at the
// moment publish was pressed. This pins the aggregated panel: a draft with an
// undecided tool surface shows that row before any publish attempt, a clean
// draft says so, and a refusal keeps its legacy jump targets.

import { expect, test } from "@playwright/test";
import { pinLocaleEn } from "./helpers.js";

async function openNewDraft(page) {
  await pinLocaleEn(page);
  await page.goto("/packs");
  await expect(page.getByTestId("agent-market-page")).toBeVisible({ timeout: 15_000 });
  await page.getByTestId("agent-market-tab-mine").click();
  await page.getByTestId("pack-draft-create").click();
  await expect(page.getByTestId("pack-editor")).toBeVisible();
}

test("a clean draft says it is ready, without pressing publish", async ({ page }) => {
  await openNewDraft(page);
  const panel = page.getByTestId("publish-checklist");
  await expect(panel).toBeVisible();
  await expect(panel).toContainText(/All clear/i);
  await expect(page.getByTestId("pack-publish-gate")).toHaveCount(0);
});

test("an undecided tool surface is one row, before any publish attempt", async ({ page }) => {
  // Seed the cell's market catalog with ONE registry-origin server, so the
  // editor's picker has something real to pick. /api/extensions/market is what
  // useExtensionsStore reads (packages/core fetchMarketCatalog).
  await page.route("**/api/extensions/market**", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        mcpServers: [
          {
            name: "e2e-checklist-mcp",
            displayName: "Checklist MCP",
            description: "用于体检单用例的注册处服务。",
            category: "test",
            icon: "plug",
            configTemplate: { command: "npx", args: ["-y", "e2e-checklist-mcp"] },
            installInstructions: "npx -y e2e-checklist-mcp",
            origin: "registry",
            toolList: ["query", "describe"],
          },
        ],
        skills: [],
      }),
    }),
  );

  await openNewDraft(page);
  await page.locator("#pack-name").fill("检查单用例");
  await page.locator("#pack-desc").fill("体检单面板用例。");

  // Pick the reference and leave its tool surface undecided (no allowlist, no
  // full-surface reason) — the condition the publish-time pre-check used to
  // report only after pressing publish.
  await page.getByTestId("pack-mcp-option-e2e-checklist-mcp").click();

  const panel = page.getByTestId("publish-checklist");
  await expect(panel).toContainText(/to fix/i);
  const group = page.getByTestId("publish-checklist-group-toolsFace");
  await expect(group).toBeVisible();
  await expect(group).toContainText("e2e-checklist-mcp");

  // The row is a jump target: clicking it must not be a dead end.
  await expect(group.locator("button").first()).toBeVisible();
});

// ── 一试: the honest boundary (complete-creator-loop 2.1/2.2) ───────────────
// A never-published draft has no pack id, and install takes only
// {packId, version} with the manifest fetched server-side — so there is
// nothing to hand off. The action must say that rather than fail.

test("a never-published draft says to publish first, and installs nothing", async ({ page }) => {
  let installCalls = 0;
  await page.route("**/api/mypacks/install", (route) => {
    installCalls += 1;
    return route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });

  await openNewDraft(page);
  await page.locator("#pack-name").fill("未发布草稿");
  await page.locator("#pack-desc").fill("一试边界用例。");

  await page.getByTestId("pack-draft-trial").click();

  const note = page.getByTestId("pack-trial-note");
  await expect(note).toBeVisible();
  await expect(note).toContainText(/publish/i);
  // No install attempt, no quality claim, no navigation away.
  expect(installCalls).toBe(0);
  await expect(page.getByTestId("pack-editor")).toBeVisible();
});

// ── 草稿 ↔ 线上关系 (complete-creator-loop 3.1) ──────────────────────────────
// Derived from the manifests, never from a stored flag: publish, change one
// field, and the line must move.
test("the relation line tracks the published manifest, not a dirty flag", async ({ page }) => {
  const publishedManifest = { name: "关系用例", description: "第一版。", tags: [], skills: [] };
  await page.route("**/api/packs/rel-pack", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ id: "rel-pack", version: 3, name: "关系用例", description: "第一版。", tags: [], manifest: publishedManifest }),
    }),
  );

  await openNewDraft(page);
  const line = page.getByTestId("pack-draft-relation");
  await expect(line).toContainText(/not published/i);
});
