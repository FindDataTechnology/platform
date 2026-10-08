import { test, expect } from "@playwright/test";
import { pinLocaleEn } from "./helpers.js";

// The redesigned composer control row (redesign-composer-controls): one row,
// two clusters — the `+` menu and the permission chip on the left, the model,
// the effort, the `⋯` overflow and send/stop on the right.
//
// Two things this file owns that no other spec covers:
//   1. the `+` menu's two entries both delegate to the pre-existing paths (the
//      composer's own file input, and the text-derived slash picker);
//   2. the full-access risk gate — the only preset that must not reach the
//      runtime on a bare selection.
//
// set_permission is recorded and swallowed (the agent-control.spec.js trick):
// these assert the CLIENT contract, and a real switch would leave the shared
// e2e session in a different sandbox mode for every later test.

const FULL_ACCESS = "danger-full-access";

test.describe("Composer control row", () => {
  test.beforeEach(async ({ page }) => {
    await pinLocaleEn(page);
    await page.addInitScript(() => {
      window.__sent = [];
      const origSend = WebSocket.prototype.send;
      WebSocket.prototype.send = function (data) {
        let parsed = null;
        try {
          parsed = JSON.parse(data);
        } catch {
          parsed = null;
        }
        if (parsed) window.__sent.push(parsed);
        if (parsed && parsed.type === "set_permission") return;
        return origSend.call(this, data);
      };
    });
    await page.goto("/chat");
    await expect(page.getByTestId("composer-control-strip")).toBeVisible({ timeout: 15000 });
  });

  const sentPermissions = (page) =>
    page.evaluate(() => window.__sent.filter((m) => m.type === "set_permission"));

  test("the + menu offers attachment and commands", async ({ page }) => {
    await page.getByTestId("strip-plus").click();
    await expect(page.getByTestId("strip-plus-menu")).toBeVisible();
    await expect(page.getByTestId("composer-attach")).toBeVisible();
    await expect(page.getByTestId("strip-commands")).toBeVisible();
  });

  test("the attachment entry opens the composer's own file picker", async ({ page }) => {
    await page.getByTestId("strip-plus").click();
    // No second upload path: the entry clicks the composer's input, so the
    // native chooser it opens is that input's (multiple-file) one.
    const [chooser] = await Promise.all([
      page.waitForEvent("filechooser"),
      page.getByTestId("composer-attach").click(),
    ]);
    expect(chooser.isMultiple()).toBe(true);
  });

  test("the commands entry opens the same slash picker the typed / path does", async ({ page }) => {
    await page.getByTestId("strip-plus").click();
    await page.getByTestId("strip-commands").click();

    await expect(page.getByTestId("slash-picker")).toBeVisible();
    await expect(page.getByTestId("composer-input")).toHaveValue("/");
    await expect(page.getByTestId("slash-picker-item").first()).toBeVisible();
  });

  test("the overflow carries the workspace section, and no agent section without a catalog", async ({
    page,
  }) => {
    await page.getByTestId("strip-more").click();
    await expect(page.getByTestId("strip-more-menu")).toBeVisible();
    await expect(page.getByTestId("strip-workspace-input")).toBeVisible();
    // The hermetic server configures no catalog: a single agent means no agent
    // control at all, rather than one showing an unchangeable value.
    await expect(page.getByTestId("strip-agent")).toHaveCount(0);
  });

  test("full access asks for acknowledgement before anything is sent", async ({ page }) => {
    await page.getByTestId("strip-permission").click();
    await page.getByTestId("strip-permission-menu").getByText("Full access").click();

    const dialog = page.getByTestId("full-access-dialog");
    await expect(dialog).toBeVisible();
    expect(await sentPermissions(page)).toEqual([]);

    const confirm = page.getByTestId("full-access-confirm");
    await expect(confirm).toBeDisabled();
    await page.getByTestId("full-access-ack").check();
    await expect(confirm).toBeEnabled();
    await confirm.click();

    await expect.poll(() => sentPermissions(page)).toEqual([{ type: "set_permission", name: FULL_ACCESS }]);
    await expect(dialog).toHaveCount(0);
  });

  test("dismissing the confirmation sends nothing and keeps the preset", async ({ page }) => {
    await page.getByTestId("strip-permission").click();
    await page.getByTestId("strip-permission-menu").getByText("Full access").click();
    await expect(page.getByTestId("full-access-dialog")).toBeVisible();

    await page.keyboard.press("Escape");

    await expect(page.getByTestId("full-access-dialog")).toHaveCount(0);
    expect(await sentPermissions(page)).toEqual([]);
    await expect(page.getByTestId("strip-permission")).toContainText("Workspace write");
  });

  test("every other preset still applies on selection", async ({ page }) => {
    await page.getByTestId("strip-permission").click();
    await page.getByTestId("strip-permission-menu").getByText("Read only").click();

    await expect(page.getByTestId("full-access-dialog")).toHaveCount(0);
    await expect
      .poll(() => sentPermissions(page))
      .toEqual([{ type: "set_permission", name: "read-only" }]);
  });
});
