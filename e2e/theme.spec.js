import { test, expect } from "@playwright/test";
import { gotoChat, openSettings, pinLocaleEn } from "./helpers.js";

// Theming — light / dark / system.
//
// The mechanism under test: `data-theme` on <html> selects a palette via CSS
// `light-dark()`, and its ABSENCE means "follow the OS". So "system" is
// asserted as no attribute, not as the string "system" — writing that string
// would break the no-JavaScript system path and therefore the no-flash
// guarantee.

const html = (page) => page.locator("html");

// oklch(0.16) vs oklch(0.98) — any sane parse separates them by luminance.
async function isDarkSurface(page) {
  return page.evaluate(() => {
    const c = getComputedStyle(document.body).backgroundColor;
    const nums = c.match(/[\d.]+/g)?.map(Number) ?? [];
    if (nums.length < 3) return null;
    // Works for both rgb() and oklab()/oklch() serializations: in rgb the first
    // three are 0-255 channels, in oklab the first is 0-1 lightness.
    return nums[0] > 1 ? (nums[0] + nums[1] + nums[2]) / 3 < 128 : nums[0] < 0.5;
  });
}

test.describe("theming", () => {
  test("switches between all three choices", async ({ page }) => {
    await gotoChat(page);
    await openSettings(page, "general");
    await expect(page.getByTestId("theme-control")).toBeVisible();

    await page.getByTestId("theme-option-light").click();
    await expect(html(page)).toHaveAttribute("data-theme", "light");
    expect(await isDarkSurface(page)).toBe(false);

    await page.getByTestId("theme-option-dark").click();
    await expect(html(page)).toHaveAttribute("data-theme", "dark");
    expect(await isDarkSurface(page)).toBe(true);

    // System is the absence of the attribute, not a third value.
    await page.getByTestId("theme-option-system").click();
    await expect(html(page)).not.toHaveAttribute("data-theme", /.*/);
  });

  test("an explicit choice persists across reload", async ({ page }) => {
    await gotoChat(page);
    await openSettings(page, "general");
    await page.getByTestId("theme-option-light").click();
    await expect(html(page)).toHaveAttribute("data-theme", "light");

    await page.reload();
    await expect(html(page)).toHaveAttribute("data-theme", "light");
    expect(await isDarkSurface(page)).toBe(false);
    await expect(page.getByTestId("theme-option-light")).toHaveAttribute("data-active", "true");
  });

  test("system follows the OS preference, live", async ({ page }) => {
    await gotoChat(page);
    await openSettings(page, "general");
    await page.getByTestId("theme-option-system").click();
    await expect(html(page)).not.toHaveAttribute("data-theme", /.*/);

    await page.emulateMedia({ colorScheme: "light" });
    expect(await isDarkSurface(page)).toBe(false);

    // No reload — the OS change alone must repaint, because the system path is
    // pure CSS.
    await page.emulateMedia({ colorScheme: "dark" });
    expect(await isDarkSurface(page)).toBe(true);
  });

  test("no flash of the wrong theme on first paint", async ({ page }) => {
    await pinLocaleEn(page);
    // Store light, then load under a DARK OS preference: if the pre-paint
    // script were missing or deferred, the first frame would be dark.
    await page.addInitScript(() => {
      try {
        localStorage.setItem("platform-theme", "light");
      } catch {
        /* ignore */
      }
    });
    await page.emulateMedia({ colorScheme: "dark" });

    await page.goto("/chat/", { waitUntil: "commit" });
    // Assert as early as the document exists — before React has mounted.
    await page.waitForFunction(() => document.documentElement.dataset.theme === "light");
    await expect(html(page)).toHaveAttribute("data-theme", "light");
    expect(await isDarkSurface(page)).toBe(false);
  });

  test("code blocks follow the theme", async ({ page }) => {
    await gotoChat(page);

    // Shiki emits --shiki-light / --shiki-dark per token and a CSS rule picks
    // between them. Producing a real highlighted block needs an LLM turn, so
    // this drives the rule directly with a stand-in that carries the same
    // custom properties — the rule is the part that can break, not shiki.
    await page.evaluate(() => {
      const pre = document.createElement("pre");
      pre.className = "shiki";
      pre.id = "shiki-probe";
      pre.style.setProperty("--shiki-light", "#111111");
      pre.style.setProperty("--shiki-dark", "#eeeeee");
      pre.style.setProperty("--shiki-light-bg", "#ffffff");
      pre.style.setProperty("--shiki-dark-bg", "#000000");
      pre.textContent = "const x = 1";
      document.body.appendChild(pre);
    });

    const read = () =>
      page.evaluate(() => {
        const cs = getComputedStyle(document.getElementById("shiki-probe"));
        return { color: cs.color, bg: cs.backgroundColor };
      });

    await page.evaluate(() => {
      document.documentElement.dataset.theme = "dark";
    });
    const dark = await read();

    await page.evaluate(() => {
      document.documentElement.dataset.theme = "light";
    });
    const light = await read();

    expect(light.color).not.toBe(dark.color);
    expect(light.bg).not.toBe(dark.bg);
    // And the right way round: light theme takes the --shiki-light values.
    expect(light.bg).toBe("rgb(255, 255, 255)");
    expect(dark.bg).toBe("rgb(0, 0, 0)");
  });

  test("both palettes define every token the UI reads", async ({ page }) => {
    await gotoChat(page);
    const TOKENS = [
      "background",
      "foreground",
      "card",
      "muted",
      "muted-foreground",
      "border",
      "primary",
      "primary-deep",
      "destructive",
      "destructive-deep",
      "success",
      "warning",
      "scrim",
    ];
    for (const theme of ["light", "dark"]) {
      await page.evaluate((t) => {
        document.documentElement.dataset.theme = t;
      }, theme);
      const missing = await page.evaluate((tokens) => {
        const cs = getComputedStyle(document.documentElement);
        return tokens.filter((t) => !cs.getPropertyValue(`--color-${t}`).trim());
      }, TOKENS);
      expect(missing, `undefined tokens in the ${theme} palette`).toEqual([]);
    }
  });
});
