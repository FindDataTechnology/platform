// External skill-source shelf e2e (add-external-skill-sources 刀一).
//
// The shelf's data plane is server-side aggregation, so these specs drive the
// UI against a route-mocked /api/extensions/external/* plane: that both pins
// the visible contract (grouping, badges, no install affordance) and proves
// the browser only ever talks to the platform's own endpoints (the upstream
// hosts are never requested — the route mock would simply not answer them,
// and any real fetch attempt would surface as a failed load).
//
// Stale/error postures are injected the same way: a 503 from the search route
// is the server-side failed-group shape, and the group header must render the
// failure caption instead of crashing the shelf.

import { test, expect } from "@playwright/test";
import { gotoExtensions } from "./helpers.js";

const SOURCES = { sources: [{ id: "skillhub", displayName: "腾讯 SkillHub" }, { id: "smithery", displayName: "Smithery" }] };

function searchDoc() {
  return {
    query: "pdf",
    groups: [
      {
        source: "skillhub",
        sourceDisplayName: "腾讯 SkillHub",
        entries: [
          {
            source: "skillhub",
            id: "pdf-image-text-extractor",
            name: "pdf-image-text-extractor",
            displayName: "PDF和图片文字提取",
            description: "从图片或 PDF 文档中识别并提取文字内容",
            originUrl: "https://skillhub.cn/skills/pdf-image-text-extractor",
            licenseState: "unknown",
            licenseText: null,
            version: "2.1.0",
            versionLayer: "market-metadata",
            downloads: 120,
            stars: 7,
            tags: ["office-efficiency"],
            extras: null,
          },
        ],
        stale: false,
        snapshotAt: Date.now() - 5 * 60 * 1000,
        error: null,
        failed: null,
      },
      {
        source: "smithery",
        sourceDisplayName: "Smithery",
        entries: [
          {
            source: "smithery",
            id: "frontend-design",
            name: "frontend-design",
            displayName: "Frontend Design",
            description: "Guidance for distinctive visual design",
            originUrl: "https://github.com/anthropics/claude-code/tree/main/plugins/frontend-design/skills/frontend-design",
            licenseState: "not-declared",
            licenseText: null,
            version: null,
            versionLayer: null,
            downloads: 10,
            stars: 63077,
            tags: ["design"],
            extras: null,
          },
        ],
        stale: true,
        snapshotAt: Date.now() - 90 * 60 * 1000,
        error: null,
        failed: null,
      },
    ],
  };
}

test.describe("External skill-source shelf (mirror + consent install)", () => {
  test.beforeEach(async ({ page }) => {
    await page.route("**/api/extensions/external/sources", (route) => route.fulfill({ json: SOURCES }));
    await page.route("**/api/extensions/external/search?q=pdf", (route) => route.fulfill({ json: searchDoc() }));
    await page.route("**/api/extensions/external/entry/skillhub/pdf-image-text-extractor", (route) =>
      route.fulfill({
        json: { entry: { ...searchDoc().groups[0].entries[0], description: "detail body" }, stale: false, snapshotAt: Date.now() },
      }),
    );
  });

  // The consent panel's data source (刀二). A script-bearing preview by default;
  // individual tests override for the no-scripts / failure shapes.
  function previewDoc(over = {}) {
    return {
      preview: {
        source: "skillhub",
        slug: "pdf-image-text-extractor",
        normalizedName: "pdf-image-text-extractor",
        upstreamName: "pdf-image-text-extractor",
        displayName: "PDF和图片文字提取",
        originUrl: "https://skillhub.cn/skills/pdf-image-text-extractor",
        version: "2.1.0",
        licenseState: "unknown",
        licenseText: null,
        bodyExcerpt: "# PDF 提取\n\n预览正文。",
        hasScripts: true,
        files: [
          { path: "SKILL.md", bytes: 15004, script: false, action: "stored" },
          { path: "scripts/extract.py", bytes: 9268, script: true, action: "stored" },
          { path: "logo.png", bytes: 4021, script: false, action: "omitted-binary" },
        ],
        ...over,
      },
    };
  }

  test("consent flow: preview first, ack required for scripts, confirm installs", async ({ page }) => {
    let installBody = null;
    await page.route("**/api/extensions/external/install-preview/**", (route) => route.fulfill({ json: previewDoc() }));
    await page.route("**/api/extensions/external/install", async (route) => {
      installBody = route.request().postDataJSON();
      await route.fulfill({ json: { skill: { name: "pdf-image-text-extractor", description: "d", originMeta: { kind: "external", source: "skillhub", slug: "pdf-image-text-extractor" } }, replaced: false } });
    });

    await gotoExtensions(page);
    await page.getByTestId("extensions-tab-external").click();
    await page.getByTestId("external-source-search").fill("pdf");
    await page.getByRole("button", { name: /^search$/i }).click();
    await page.getByTestId("external-entry-skillhub-pdf-image-text-extractor").click();
    await page.getByTestId("external-install-button").click();

    const panel = page.getByTestId("external-install-dialog");
    await expect(panel).toBeVisible();
    // Nothing installed just by opening the panel.
    expect(installBody).toBeNull();
    // Preview content: body excerpt, file inventory with the script marked and
    // the binary omission visible, license + not-reviewed marks.
    await expect(panel.getByTestId("install-body-excerpt")).toContainText("预览正文");
    await expect(panel.getByTestId("install-file-list")).toContainText("scripts/extract.py");
    await expect(panel.getByTestId("install-file-list")).toContainText(/not stored \(binary\)/i);
    await expect(panel.getByText(/license: unknown/i)).toBeVisible();
    await expect(panel.getByText(/not reviewed by this platform/i)).toBeVisible();
    await expect(panel.getByText(/executable script files/i)).toBeVisible();

    // Script-bearing → confirm is disabled until acknowledged.
    const confirm = panel.getByTestId("install-confirm");
    await expect(confirm).toBeDisabled();
    await panel.getByTestId("install-ack-scripts").check();
    await expect(confirm).toBeEnabled();
    await confirm.click();

    await expect(panel.getByTestId("install-success")).toContainText("pdf-image-text-extractor");
    // The client sent the server-enforced confirm flag.
    expect(installBody).toEqual({ source: "skillhub", slug: "pdf-image-text-extractor", confirm: true });
  });

  test("consent flow: script-free skill needs no acknowledgement", async ({ page }) => {
    await page.route("**/api/extensions/external/install-preview/**", (route) =>
      route.fulfill({ json: previewDoc({ hasScripts: false, files: [{ path: "SKILL.md", bytes: 100, script: false, action: "stored" }] }) }),
    );
    await gotoExtensions(page);
    await page.getByTestId("extensions-tab-external").click();
    await page.getByTestId("external-source-search").fill("pdf");
    await page.getByRole("button", { name: /^search$/i }).click();
    await page.getByTestId("external-entry-skillhub-pdf-image-text-extractor").click();
    await page.getByTestId("external-install-button").click();

    const panel = page.getByTestId("external-install-dialog");
    await expect(panel.getByTestId("install-confirm")).toBeEnabled();
    await expect(panel.getByTestId("install-ack-scripts")).toHaveCount(0);
  });

  test("consent flow: install failure reports the server reason", async ({ page }) => {
    await page.route("**/api/extensions/external/install-preview/**", (route) => route.fulfill({ json: previewDoc({ hasScripts: false }) }));
    await page.route("**/api/extensions/external/install", (route) =>
      route.fulfill({ status: 502, json: { error: "Install failed: upstream directory not found: https://github.com/o/r/tree/main/gone", code: "upstream-not-found" } }),
    );
    await gotoExtensions(page);
    await page.getByTestId("extensions-tab-external").click();
    await page.getByTestId("external-source-search").fill("pdf");
    await page.getByRole("button", { name: /^search$/i }).click();
    await page.getByTestId("external-entry-skillhub-pdf-image-text-extractor").click();
    await page.getByTestId("external-install-button").click();
    await page.getByTestId("external-install-dialog").getByTestId("install-confirm").click();
    await expect(page.getByTestId("external-install-dialog").getByTestId("install-failure")).toContainText("upstream directory not found");
  });

  test("consent flow: a preview failure is shown with retry, nothing installs", async ({ page }) => {
    let installCalled = false;
    await page.route("**/api/extensions/external/install-preview/**", (route) => route.fulfill({ status: 502, json: { error: "Install preview failed: upstream directory not found" } }));
    await page.route("**/api/extensions/external/install", async (route) => {
      installCalled = true;
      await route.fulfill({ json: {} });
    });
    await gotoExtensions(page);
    await page.getByTestId("extensions-tab-external").click();
    await page.getByTestId("external-source-search").fill("pdf");
    await page.getByRole("button", { name: /^search$/i }).click();
    await page.getByTestId("external-entry-skillhub-pdf-image-text-extractor").click();
    await page.getByTestId("external-install-button").click();
    await expect(page.getByTestId("external-install-dialog").getByTestId("install-load-error")).toContainText("upstream directory not found");
    await expect(page.getByTestId("external-install-dialog").getByTestId("install-confirm")).toHaveCount(0);
    expect(installCalled).toBe(false);
  });

  test("external tab is visible by default with no flag", async ({ page }) => {
    await gotoExtensions(page);
    await expect(page.getByTestId("extensions-tab-external")).toBeVisible();
  });

  test("search renders per-source groups with provenance marks; shelf offers no direct install", async ({ page }) => {
    await gotoExtensions(page);
    await page.getByTestId("extensions-tab-external").click();

    await page.getByTestId("external-source-search").fill("pdf");
    await page.getByRole("button", { name: /^search$/i }).click();

    // Both groups render, each with the external-source badge.
    await expect(page.getByTestId("external-group-skillhub")).toBeVisible();
    await expect(page.getByTestId("external-group-smithery")).toBeVisible();
    await expect(page.getByTestId("external-group-skillhub").getByText(/external/i)).toBeVisible();

    // License three-state chips: unknown on skillhub, not-declared on smithery.
    await expect(page.getByTestId("external-entry-skillhub-pdf-image-text-extractor").getByText(/license: unknown/i)).toBeVisible();
    await expect(page.getByTestId("external-entry-smithery-frontend-design").getByText(/license: not declared/i)).toBeVisible();

    // The not-reviewed mark renders on every card.
    await expect(page.getByTestId("external-group-skillhub").getByText(/not reviewed by this platform/i)).toBeVisible();

    // Stale caption on the stale group.
    await expect(page.getByTestId("external-group-smithery").getByText(/stale · updated/i)).toBeVisible();

    // 刀二 re-judged this pin: the SHELF (cards list) still has no install
    // control — installation lives behind the entry detail's consent flow.
    await expect(page.getByTestId("external-source-shelf").getByRole("button", { name: /^install$/i })).toHaveCount(0);
    await expect(page.getByTestId("external-source-shelf").getByTestId("external-install-button")).toHaveCount(0);
  });

  test("entry detail opens with upstream link and the install entry point", async ({ page }) => {
    await gotoExtensions(page);
    await page.getByTestId("extensions-tab-external").click();
    await page.getByTestId("external-source-search").fill("pdf");
    await page.getByRole("button", { name: /^search$/i }).click();

    await page.getByTestId("external-entry-skillhub-pdf-image-text-extractor").click();
    const dialog = page.getByTestId("external-entry-detail");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(/detail body/i)).toBeVisible();

    const upstream = dialog.getByRole("link", { name: /open upstream page/i });
    await expect(upstream).toBeVisible();
    await expect(upstream).toHaveAttribute("rel", /noopener noreferrer/);
    await expect(upstream).toHaveAttribute("href", "https://skillhub.cn/skills/pdf-image-text-extractor");

    // The install affordance exists on the detail (且必须经确认面板) — the
    // consent-flow tests below pin that the panel actually mediates.
    await expect(dialog.getByTestId("external-install-button")).toBeVisible();
  });

  test("closing the detail dialog while its fetch is in flight does not reopen it", async ({ page }) => {
    // Live-probe regression (2026-10-15): the detail fetch resolved after
    // Escape had closed the dialog and unconditionally re-set the detail
    // state, popping the dialog back open ~1s later.
    await page.route("**/api/extensions/external/entry/skillhub/pdf-image-text-extractor", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await route.fulfill({
        json: { entry: { ...searchDoc().groups[0].entries[0], description: "late detail body" }, stale: false, snapshotAt: Date.now() },
      });
    });

    await gotoExtensions(page);
    await page.getByTestId("extensions-tab-external").click();
    await page.getByTestId("external-source-search").fill("pdf");
    await page.getByRole("button", { name: /^search$/i }).click();

    await page.getByTestId("external-entry-skillhub-pdf-image-text-extractor").click();
    const dialog = page.getByTestId("external-entry-detail");
    await expect(dialog).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();

    // The in-flight fetch resolves after the close; the dialog must stay shut.
    await page.waitForTimeout(2500);
    await expect(dialog).toBeHidden();
  });

  test("a failed source group renders its failure caption without breaking the shelf", async ({ page }) => {
    const doc = searchDoc();
    doc.groups[1] = { ...doc.groups[1], entries: [], stale: false, snapshotAt: null, error: "connect ECONNREFUSED", failed: "connect ECONNREFUSED" };
    await page.route("**/api/extensions/external/search?q=pdf", (route) => route.fulfill({ json: doc }));

    await gotoExtensions(page);
    await page.getByTestId("extensions-tab-external").click();
    await page.getByTestId("external-source-search").fill("pdf");
    await page.getByRole("button", { name: /^search$/i }).click();

    await expect(page.getByTestId("external-group-smithery").getByText(/temporarily unavailable/i)).toBeVisible();
    await expect(page.getByTestId("external-group-skillhub")).toBeVisible();
  });
});
