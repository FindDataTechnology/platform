import { test, expect } from "@playwright/test";
import { gotoChat, openSettings, pinLocaleEn } from "./helpers.js";

// Settings modal — the surface that replaced the sidebar's settings popover.
//
// The first five tests carry forward what settings-menu.spec.js asserted (open
// on click, reach System Status, reach Models, dismiss on outside click,
// dismiss on Escape). The rest cover what the popover could not do: routing,
// deep links, back-button history, and the legacy redirects.
//
// The popover's "help" entry is gone — the help center's remaining entry point
// is the composer, covered by composer-stop.spec.js.

test.describe("settings modal", () => {
  test("opens on gear click and reaches System Status", async ({ page }) => {
    await gotoChat(page);
    await expect(page.getByTestId("settings-panel")).toBeHidden();

    await page.getByTestId("settings-btn").click();
    await expect(page.getByTestId("settings-panel")).toBeVisible();

    await page.getByTestId("settings-section-status").click();
    await expect(page).toHaveURL(/\/settings\/status$/);
    await expect(page.getByTestId("system-status-page")).toBeVisible({ timeout: 15000 });
  });

  test("reaches LLM Models", async ({ page }) => {
    await gotoChat(page);
    await page.getByTestId("settings-btn").click();
    await page.getByTestId("settings-section-models").click();
    await expect(page).toHaveURL(/\/settings\/models$/);
    await expect(page.getByTestId("models-page")).toBeVisible({ timeout: 15000 });
  });

  test("closes on backdrop click", async ({ page }) => {
    await gotoChat(page);
    await page.getByTestId("settings-btn").click();
    await expect(page.getByTestId("settings-panel")).toBeVisible();

    await page.getByTestId("settings-backdrop").click({ position: { x: 5, y: 5 } });
    await expect(page.getByTestId("settings-panel")).toBeHidden();
  });

  test("closes on Escape", async ({ page }) => {
    await gotoChat(page);
    await page.getByTestId("settings-btn").click();
    await expect(page.getByTestId("settings-panel")).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(page.getByTestId("settings-panel")).toBeHidden();
  });

  test("closes via the explicit close control", async ({ page }) => {
    await gotoChat(page);
    await page.getByTestId("settings-btn").click();
    await page.getByTestId("settings-close").click();
    await expect(page.getByTestId("settings-panel")).toBeHidden();
  });

  test("Cmd/Ctrl + , opens it from any view", async ({ page }) => {
    await gotoChat(page);
    await page.keyboard.press(process.platform === "darwin" ? "Meta+," : "Control+,");
    await expect(page.getByTestId("settings-panel")).toBeVisible();
    await expect(page).toHaveURL(/\/settings\//);
  });

  test("dismissing restores the view it was opened from", async ({ page }) => {
    await gotoChat(page);
    await page.goto("/knowledge");
    await expect(page.getByTestId("documents-page")).toBeVisible({ timeout: 15000 });

    await page.getByTestId("settings-btn").click();
    await expect(page.getByTestId("settings-panel")).toBeVisible();
    // The underlying view stays mounted — that is the point of a modal.
    await expect(page.getByTestId("documents-page")).toBeAttached();

    await page.keyboard.press("Escape");
    await expect(page).toHaveURL(/\/knowledge$/);
    await expect(page.getByTestId("documents-page")).toBeVisible();
  });

  test("deep link opens a section over the chat view", async ({ page }) => {
    await openSettings(page, "models");
    await expect(page.getByTestId("models-page")).toBeVisible({ timeout: 15000 });
    // No background location on a cold load, so /chat stands in behind it.
    await page.keyboard.press("Escape");
    await expect(page).toHaveURL(/\/chat$/);
  });

  test("switching sections updates the URL and the back button walks it", async ({ page }) => {
    await openSettings(page, "general");

    // `models` is a section that still exists (tools/skills left for the market).
    await page.getByTestId("settings-section-models").click();
    await expect(page).toHaveURL(/\/settings\/models$/);
    await expect(page.getByTestId("settings-panel")).toHaveAttribute("data-section", "models");

    await page.goBack();
    await expect(page).toHaveURL(/\/settings\/general$/);
    await expect(page.getByTestId("settings-panel")).toHaveAttribute("data-section", "general");
  });

  test("bare /settings and an unknown slug both resolve to General", async ({ page }) => {
    await pinLocaleEn(page);

    await page.goto("/settings");
    await expect(page).toHaveURL(/\/settings\/general$/);
    await expect(page.getByTestId("settings-panel")).toHaveAttribute("data-section", "general");

    await page.goto("/settings/nonexistent-section");
    await expect(page).toHaveURL(/\/settings\/general$/);
    await expect(page.getByTestId("settings-panel")).toHaveAttribute("data-section", "general");
  });

  test("every legacy configuration route redirects to its section", async ({ page }) => {
    await pinLocaleEn(page);
    const cases = [
      ["/models", "models"],
      ["/dashboard", "status"],
      // /trace is the trace TAB of the status section now (restructure-yizuo-ia):
      // the alias slug stays in the URL, the canonical section is `status`.
      ["/trace", "diagnostics", "status"],
    ];
    for (const [legacy, section, canonical] of cases) {
      await page.goto(legacy);
      await expect(page).toHaveURL(new RegExp(`/settings/${section}$`));
      await expect(page.getByTestId("settings-panel")).toHaveAttribute(
        "data-section",
        canonical ?? section,
      );
    }

    // /bots and /settings/channels LEFT Settings for the nav surface
    // (restructure-yizuo-ia): both hand over to /channels without a modal.
    // unify-material-market: tools/skills left Settings for the market tabs.
    for (const [legacy, tab] of [
      ["/mcp", "tools"],
      ["/extensions", "tools"],
      ["/extensions/mcp", "tools"],
      ["/settings/mcp", "tools"],
      ["/skills", "skills"],
      ["/extensions/skills", "skills"],
      ["/settings/skills", "skills"],
      ["/settings/plugins", "plugins"],
    ]) {
      await page.goto(legacy);
      await expect(page).toHaveURL(new RegExp(`/agents\\?tab=${tab}$`));
      await expect(page.getByTestId("settings-panel")).toHaveCount(0);
      await expect(page.getByTestId(`agent-market-tab-${tab}`)).toHaveAttribute("data-active", "true");
    }

    for (const legacy of ["/bots", "/settings/channels"]) {
      await page.goto(legacy);
      await expect(page).toHaveURL(/\/channels$/);
      await expect(page.getByTestId("settings-panel")).toHaveCount(0);
      await expect(page.getByTestId("bots-page")).toBeVisible();
    }
  });

  test("a Manage link to another section switches panes without closing", async ({ page }) => {
    await openSettings(page, "status");
    await expect(page.getByTestId("system-status-page")).toBeVisible({ timeout: 15000 });

    // 模型 is still a Settings section, so a Manage link into it keeps the modal
    // open and switches panes (unify-material-market: the tools link now leaves
    // for the market tab, which is a different assertion below).
    await page.getByTestId("config-row-manage").first().click();
    await expect(page).toHaveURL(/\/settings\/models$/);
    await expect(page.getByTestId("settings-panel")).toBeVisible();
    await expect(page.getByTestId("settings-panel")).toHaveAttribute("data-section", "models");
  });

  test("the tools Manage link leaves the modal for the market tab", async ({ page }) => {
    await openSettings(page, "status");
    await expect(page.getByTestId("system-status-page")).toBeVisible({ timeout: 15000 });
    await page.getByTestId("mcp-manage-link").click();
    await expect(page).toHaveURL(/\/agents\?tab=tools$/);
    await expect(page.getByTestId("settings-panel")).toHaveCount(0);
    await expect(page.getByTestId("agent-market-tab-tools")).toHaveAttribute("data-active", "true");
  });

  test("a Manage link to a work surface closes the modal", async ({ page }) => {
    await gotoChat(page);
    await page.getByTestId("settings-btn").click();
    await page.getByTestId("settings-section-status").click();
    await expect(page.getByTestId("system-status-page")).toBeVisible({ timeout: 15000 });

    // The Agents link targets /agents, which is a nav tab, not a section.
    await page.getByTestId("config-row-manage").last().click();
    await expect(page).toHaveURL(/\/agents$/);
    await expect(page.getByTestId("settings-panel")).toBeHidden();
    // /agents renders the agent-market face since the W2 teardown dissolved the
    // four-zone hub (0eb48a0d0); `agents-page` now only exists in the unrouted
    // AgentsPage. What this test cares about is that the modal closed and the
    // work surface behind it mounted.
    await expect(page.getByTestId("agent-market-page")).toBeVisible({ timeout: 15000 });
  });

  test("a section Manage link preserves what the modal was covering", async ({ page }) => {
    await gotoChat(page);
    await page.goto("/knowledge");
    await expect(page.getByTestId("documents-page")).toBeVisible({ timeout: 15000 });

    await page.getByTestId("settings-btn").click();
    await page.getByTestId("settings-section-status").click();
    await page.getByTestId("config-row-manage").first().click();
    await expect(page.getByTestId("settings-panel")).toHaveAttribute("data-section", "models");

    // Closing must still return to the Library — the Manage link has to carry
    // the background location forward or this lands on /chat.
    await page.keyboard.press("Escape");
    await expect(page).toHaveURL(/\/knowledge$/);
  });

  test("only the active section is mounted", async ({ page }) => {
    await openSettings(page, "status");
    await expect(page.getByTestId("system-status-page")).toBeVisible({ timeout: 15000 });
    // The Models section is listed but not rendered until selected.
    await expect(page.getByTestId("models-page")).toHaveCount(0);
  });
});
