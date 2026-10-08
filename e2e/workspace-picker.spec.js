import { test, expect } from "@playwright/test";
import { pinLocaleEn } from "./helpers.js";

// Native folder picker (Electron shell only). The web bundle gates the browse
// button on `window.platform.pickWorkdir` existing — computed at module load —
// so the stub must be installed via addInitScript before the app evaluates.
// These tests assert the client contract only: the picked path flows through
// the same set_workspace send as a typed path. The interceptor swallows the
// message so no real runtime restart happens.

const PICKED = "/tmp/picked-folder";

test.describe("workspace browse buttons (Electron bridge)", () => {
  test.beforeEach(async ({ page }) => {
    await pinLocaleEn(page);
    await page.addInitScript((picked) => {
      window.platform = { pickWorkdir: async () => picked };
      window.__sent = [];
      const origSend = WebSocket.prototype.send;
      WebSocket.prototype.send = function (data) {
        let parsed;
        try {
          parsed = JSON.parse(data);
        } catch {
          parsed = null;
        }
        if (parsed) window.__sent.push(parsed);
        if (parsed && parsed.type === "set_workspace") return;
        return origSend.call(this, data);
      };
    }, PICKED);
    await page.goto("/chat");
    await expect(page.getByTestId("composer-control-strip")).toBeVisible({ timeout: 15000 });
  });

  test("sidebar new-workspace popover offers browse and sends the pick", async ({ page }) => {
    await page.getByTestId("workspace-new").click();
    const browse = page.getByTestId("workspace-new-browse");
    await expect(browse).toBeVisible();
    await browse.click();
    await expect
      .poll(() => page.evaluate(() => window.__sent.filter((m) => m.type === "set_workspace")))
      .toEqual([{ type: "set_workspace", path: PICKED }]);
  });

  test("composer strip workspace menu offers browse and sends the pick", async ({ page }) => {
    // The workspace control lives inside the composer's overflow popover now.
    await page.getByTestId("strip-more").click();
    const browse = page.getByTestId("strip-workspace-browse");
    await expect(browse).toBeVisible();
    await browse.click();
    await expect
      .poll(() => page.evaluate(() => window.__sent.filter((m) => m.type === "set_workspace")))
      .toEqual([{ type: "set_workspace", path: PICKED }]);
  });
});

test.describe("workspace browse without the Electron bridge", () => {
  test("no browse button renders in a plain browser", async ({ page }) => {
    await pinLocaleEn(page);
    await page.goto("/chat");
    await expect(page.getByTestId("composer-control-strip")).toBeVisible({ timeout: 15000 });
    await page.getByTestId("workspace-new").click();
    await expect(page.getByTestId("workspace-new-input")).toBeVisible();
    await expect(page.getByTestId("workspace-new-browse")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await page.getByTestId("strip-more").click();
    await expect(page.getByTestId("strip-workspace-input")).toBeVisible();
    await expect(page.getByTestId("strip-workspace-browse")).toHaveCount(0);
  });
});
