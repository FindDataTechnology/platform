import { test, expect } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gotoChat } from "./helpers.js";

// An attached file's chip opens the preview drawer (openspec:
// preview-attached-files). Deterministic and offline: CSV extraction is local,
// so the whole path — upload → stored original → chip → drawer → table — runs
// without an LLM turn.

const FIXTURE = "name,score\nalice,10\nbob,20\n";

test.describe("attachment preview", () => {
  test("an attached file's chip opens the preview drawer", async ({ page }) => {
    await gotoChat(page);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paas-attach-"));
    const name = `paas-attach-${Date.now()}.csv`;
    const file = path.join(dir, name);
    fs.writeFileSync(file, FIXTURE);

    try {
      await page.getByTestId("composer-file-input").setInputFiles(file);

      const chip = page.getByTestId("composer-attachment").first();
      await expect(chip).toHaveAttribute("data-state", "attached", { timeout: 20_000 });
      await expect(chip).toContainText(name);

      // The chip's name is a control, not inert text: it opens the drawer with
      // the file's ORIGINAL, which the server stored alongside ingestion.
      await chip.getByRole("button", { name: "Preview" }).click();
      await expect(page.getByTestId("preview-drawer")).toBeVisible({ timeout: 10_000 });
      await expect(page.getByTestId("preview-name")).toHaveText(name);
      // The CSV's own renderer ran, so the stored bytes really came back.
      await expect(page.getByTestId("preview-csv")).toContainText("alice", { timeout: 10_000 });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a file whose extraction fails is still previewable", async ({ page }) => {
    await gotoChat(page);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paas-attach-"));
    const name = `paas-empty-${Date.now()}.txt`;
    const file = path.join(dir, name);
    // Whitespace-only: extraction yields empty text, so ingestion reports an
    // error — but the server stored the original before that mattered.
    fs.writeFileSync(file, "   \n\n  ");

    try {
      await page.getByTestId("composer-file-input").setInputFiles(file);

      const chip = page.getByTestId("composer-attachment").first();
      await expect(chip).toHaveAttribute("data-state", "error", { timeout: 20_000 });
      // A failed ingestion is exactly the file a user most wants to look at, so
      // the error chip keeps the preview affordance.
      await chip.getByRole("button", { name: "Preview" }).click();
      await expect(page.getByTestId("preview-drawer")).toBeVisible({ timeout: 10_000 });
      await expect(page.getByTestId("preview-text")).toBeVisible({ timeout: 10_000 });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
