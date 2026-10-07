import { test, expect } from "@playwright/test";
import { gotoChat } from "./helpers.js";

// add-permission-mode-selector: the composer control strip shows the session's
// effective permission preset, switches it live (no restart, no pending
// window), and every connected client agrees. The fast suite runs against the
// real composed dsh profile, so the roster is the shipped
// read-only / workspace-write / danger-full-access table with the
// workspace-write deployment default (DSH_PERMISSION_MODE unset).

test.describe("permission mode selector", () => {
  test("strip shows the deployment default and switches live", async ({ page }) => {
    await gotoChat(page);
    // Roster received → the control renders, showing the default preset.
    const strip = page.getByTestId("strip-permission");
    await expect(strip).toBeVisible({ timeout: 15000 });
    await expect(strip).toContainText(/workspace write/i);

    await strip.click();
    const menu = page.getByTestId("strip-permission-menu");
    await expect(menu.getByTestId("strip-menu-item")).toHaveCount(3);

    // Pick read-only: the confirming current_permission broadcast updates the
    // chip with no composer blocking (no pendingConfig for this control).
    await menu.getByRole("menuitemradio").filter({ hasText: /read only/i }).click();
    await expect
      .poll(() => page.evaluate(() => window.__chatStore.getState().currentPermission), { timeout: 15000 })
      .toBe("read-only");
    await expect(page.getByTestId("strip-permission")).toContainText(/read only/i);
    await expect
      .poll(() => page.evaluate(() => window.__chatStore.getState().pendingConfig))
      .toBe(null);

    // Switch back so the shared sequential session keeps the default posture.
    await page.getByTestId("strip-permission").click();
    await page
      .getByTestId("strip-permission-menu")
      .getByRole("menuitemradio")
      .filter({ hasText: /workspace write/i })
      .click();
    await expect
      .poll(() => page.evaluate(() => window.__chatStore.getState().currentPermission), { timeout: 15000 })
      .toBe("workspace-write");
  });

  test("a restart-carrying switch resets the permission to the default", async ({ page }) => {
    await gotoChat(page);
    const strip = page.getByTestId("strip-permission");
    await expect(strip).toBeVisible({ timeout: 15000 });

    // Loosen the mode first. Full access is the gated preset: selecting it
    // opens the risk confirmation and sends nothing until it is acknowledged.
    await strip.click();
    await page
      .getByTestId("strip-permission-menu")
      .getByRole("menuitemradio")
      .filter({ hasText: /full access/i })
      .click();
    await page.getByTestId("full-access-ack").check();
    await page.getByTestId("full-access-confirm").click();
    await expect
      .poll(() => page.evaluate(() => window.__chatStore.getState().currentPermission), { timeout: 15000 })
      .toBe("danger-full-access");

    // A model switch restarts the dsh child; the fresh session runs under the
    // deployment default, and the post-restart roster fetch reports that.
    const original = await page.evaluate(() => window.__chatStore.getState().currentModel);
    const target = await page.evaluate(
      (orig) => window.__chatStore.getState().models.find((m) => m.id !== orig)?.id,
      original,
    );
    await page.getByTestId("strip-model").click();
    await page
      .getByTestId("strip-model-menu")
      .getByRole("menuitemradio")
      .filter({ hasText: target })
      .click();
    await expect
      .poll(() => page.evaluate(() => window.__chatStore.getState().pendingConfig), { timeout: 15000 })
      .toBe(null);
    await expect
      .poll(() => page.evaluate(() => window.__chatStore.getState().currentPermission), { timeout: 60000 })
      .toBe("workspace-write");
  });

  test("a second client syncs to a switch made elsewhere", async ({ page, context }) => {
    await gotoChat(page);
    const strip = page.getByTestId("strip-permission");
    await expect(strip).toBeVisible({ timeout: 15000 });

    await strip.click();
    await page
      .getByTestId("strip-permission-menu")
      .getByRole("menuitemradio")
      .filter({ hasText: /read only/i })
      .click();
    await expect
      .poll(() => page.evaluate(() => window.__chatStore.getState().currentPermission), { timeout: 15000 })
      .toBe("read-only");

    // A second tab connects mid-session: the connect-time push (or its roster
    // fetch) must report the preset the first client switched to.
    const page2 = await context.newPage();
    await gotoChat(page2);
    await expect(page2.getByTestId("strip-permission")).toContainText(/read only/i, { timeout: 15000 });
    await page2.close();

    // Restore the default for later specs.
    await strip.click();
    await page
      .getByTestId("strip-permission-menu")
      .getByRole("menuitemradio")
      .filter({ hasText: /workspace write/i })
      .click();
    await expect
      .poll(() => page.evaluate(() => window.__chatStore.getState().currentPermission), { timeout: 15000 })
      .toBe("workspace-write");
  });
});
