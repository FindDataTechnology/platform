import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { gotoChat, gotoResources } from "./helpers.js";

// Save-to-resources from the chat's preview drawer (openspec:
// add-resource-library 7.3), end to end: a workspace file linked in assistant
// output → drawer → save → the library page shows the STORED copy.
//
// The assistant text is pushed straight into the client store (the e2e seam),
// so the test spends no LLM turn; the server side of the save is real — it
// resolves the workspace root, copies the bytes, and answers the second click
// with "already in resources".

async function injectAssistantText(page, text) {
  await page.evaluate((t) => {
    const s = window.__chatStore.getState();
    s.apply({ type: "agent_start" });
    s.apply({ type: "text", delta: t });
    s.apply({ type: "done" });
  }, text);
}

async function openDrawerFromLink(page, name) {
  await page.getByRole("link", { name }).click();
  await expect(page.getByTestId("preview-drawer")).toBeVisible();
  await expect(page.getByTestId("preview-name")).toHaveText(name);
}

test.describe("save to resources", () => {
  test("saving a workspace file from the drawer: durable copy, dedupe, failures", async ({ page }) => {
    const name = `e2e-save-${Date.now()}.md`;
    const file = path.join(process.cwd(), name);
    const body = "# Fixture\n\nsaved from the drawer\n";
    fs.writeFileSync(file, body);

    try {
      await gotoChat(page);
      await injectAssistantText(page, `I wrote the report to [${name}](${name}).`);

      await openDrawerFromLink(page, name);

      // The drawer offers save-to-resources for workspace files only.
      const saveButton = page.getByTestId("preview-save-resource");
      await expect(saveButton).toBeVisible();
      await saveButton.click();
      // Toast v2 (web-operate-states「异步成败反馈双通道」) replaced the legacy
      // single-message Toast; the host is the surface, and a successful save
      // must arrive as a success toast — not the error-severity one the drawer
      // used to raise for BOTH outcomes.
      const toast = page.getByTestId("toast-v2-host").getByText("Saved to resources");
      await expect(toast).toBeVisible();
      await expect(toast.locator("xpath=ancestor::div[contains(@class,'border-status-failed')]")).toHaveCount(0);

      // The library holds the copy — and it survives the source disappearing.
      await page.getByTestId("preview-close").click();
      fs.rmSync(file, { force: true });
      await gotoResources(page);
      const card = page.getByTestId("resource-card").filter({ hasText: name });
      await expect(card).toBeVisible();
      await expect(card).toHaveAttribute("data-resource-type", "file");
      await card.getByTestId("resource-open").click();
      await expect(page.getByTestId("preview-drawer")).toBeVisible();
      await expect(page.getByTestId("preview-markdown")).toContainText("saved from the drawer", {
        timeout: 10000,
      });
      await page.getByTestId("preview-close").click();

      // Saving byte-identical content again reports the existing resource
      // instead of duplicating it. (The transcript is client state, so the
      // turn is re-injected after the navigation.)
      fs.writeFileSync(file, body);
      await gotoChat(page);
      await injectAssistantText(page, `I wrote the report to [${name}](${name}).`);
      await openDrawerFromLink(page, name);
      await page.getByTestId("preview-save-resource").click();
      // Dedupe is an INFO outcome, not a failure: same v2 host, honest wording.
      await expect(page.getByTestId("toast-v2-host").getByText("Already in resources")).toBeVisible();
      await page.getByTestId("preview-close").click();

      // A save whose source has vanished answers with a clear, localized
      // reason — the server's own code, not its raw text.
      fs.rmSync(file, { force: true });
      const ghost = `e2e-ghost-${Date.now()}.md`;
      await injectAssistantText(page, `Missing file: [${ghost}](${ghost}).`);
      await openDrawerFromLink(page, ghost);
      await page.getByTestId("preview-save-resource").click();
      // A known refusal carries its localized reason on the same host.
      await expect(
        page.getByTestId("toast-v2-host").getByText("The file no longer exists in the workspace."),
      ).toBeVisible();
    } finally {
      fs.rmSync(file, { force: true });
    }
  });

  test("an upload's stored original is not saveable (it already has a home)", async ({ page }) => {
    // The drawer shows the save action only for workspace roots; an attachment
    // previews from the uploads root and must not offer it.
    await gotoChat(page);
    const dir = fs.mkdtempSync(path.join(process.cwd(), ".e2e-attach-"));
    const name = `attach-${Date.now()}.txt`;
    const file = path.join(dir, name);
    fs.writeFileSync(file, "attachment bytes");
    try {
      await page.getByTestId("composer-file-input").setInputFiles(file);
      const chip = page.getByTestId("composer-attachment").first();
      await expect(chip).toHaveAttribute("data-state", "attached", { timeout: 20_000 });
      await chip.getByRole("button", { name: "Preview" }).click();
      await expect(page.getByTestId("preview-drawer")).toBeVisible();
      await expect(page.getByTestId("preview-save-resource")).toHaveCount(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});