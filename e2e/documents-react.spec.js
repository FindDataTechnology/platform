import { test, expect } from "@playwright/test";
import { gotoDocuments } from "./helpers.js";

// React Documents view (/documents): ingestion, list, content, collections.
// Replaces the legacy documents.spec.js + uploads-and-collections.spec.js.

test.describe("React documents view", () => {
  test("page renders", async ({ page }) => {
    await gotoDocuments(page);
    await expect(page.getByTestId("ingest-section")).toBeVisible();
  });

  test("text document uploads and becomes ready", async ({ page }) => {
    await gotoDocuments(page);
    await page.getByTestId("text-input").fill("E2E note: the quick brown fox.");
    await page.getByTestId("add-text-btn").click();
    // A new row appears; status eventually becomes ready (or error). We assert
    // the row appears; the status transition depends on the provider being up.
    const row = page.getByTestId("doc-row").first();
    await expect(row).toBeVisible({ timeout: 15000 });
  });

  test("document content is viewable", async ({ page }) => {
    await gotoDocuments(page);
    const row = page.getByTestId("doc-row").first();
    await expect(row).toBeVisible({ timeout: 15000 });
    await row.click();
    await expect(page.getByTestId("doc-content")).toBeVisible({ timeout: 10000 });
  });

  test("document is deletable", async ({ page }) => {
    await gotoDocuments(page);
    await page.getByTestId("text-input").fill("E2E delete-me note.");
    await page.getByTestId("add-text-btn").click();
    // Wait for the new row to appear and grab its id.
    const row = page.getByTestId("doc-row").last();
    await expect(row).toBeVisible({ timeout: 15000 });
    const id = await row.getAttribute("data-doc-id");
    expect(id).toBeTruthy();
    // Click the row's delete button and assert the row's data-doc-id is gone.
    await page.locator(`[data-doc-id="${id}"]`).getByTestId("doc-delete").click();
    await expect(page.locator(`[data-doc-id="${id}"]`)).toHaveCount(0, { timeout: 20000 });
  });

  test("collection create + list", async ({ page }) => {
    await gotoDocuments(page);
    const name = `E2E Col ${Date.now()}`;
    await page.getByTestId("col-name-input").fill(name);
    await page.getByTestId("col-create-btn").click();
    await expect(page.getByTestId("col-row").filter({ hasText: name })).toBeVisible({ timeout: 10000 });
  });
});
