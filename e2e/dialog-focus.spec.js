import { test, expect } from "@playwright/test";
import { pinLocaleEn } from "./helpers.js";

// Regression guard for the dialog focus trap (web/src/components/ui/dialog.tsx).
//
// The trap's effect used to depend on `onOpenChange`, which every call site
// passes as an inline arrow — a new function on each parent render. A form
// dialog re-renders on every keystroke, so the effect re-ran per character:
// its cleanup restored focus to the opener and the re-run stole focus to the
// FIRST focusable child. Typing in any field but the first therefore lost the
// caret after one character.
//
// The assertion that fails without the fix is not "the dialog opened" but
// "the whole string landed in the field the user was typing into".

test.describe("dialog focus trap", () => {
  test("typing into a non-first field keeps the caret there (/bots)", async ({ page }) => {
    await pinLocaleEn(page);
    await page.goto("/bots");
    await expect(page.getByTestId("bots-page")).toBeVisible({ timeout: 15000 });

    await page.getByTestId("bots-add").click();
    // The type <select> is the dialog's first focusable child; the name input
    // is the second — which is what makes this the exact repro.
    await expect(page.getByTestId("bot-type")).toBeFocused();

    const name = page.getByTestId("bot-name");
    await name.click();
    // Per-character typing, not fill(): fill() sets the value in one shot and
    // would pass even with the bug present.
    await name.pressSequentially("regression", { delay: 20 });

    await expect(name).toBeFocused();
    await expect(name).toHaveValue("regression");
  });

  test("typing into a credential field keeps the caret there (/bots)", async ({ page }) => {
    await pinLocaleEn(page);
    await page.goto("/bots");
    await expect(page.getByTestId("bots-page")).toBeVisible({ timeout: 15000 });

    await page.getByTestId("bots-add").click();
    // Telegram is the first offered type, so its token field is present.
    const token = page.getByTestId("bot-cred-token");
    await token.click();
    await token.pressSequentially("123456:abcdef", { delay: 20 });

    await expect(token).toBeFocused();
    await expect(token).toHaveValue("123456:abcdef");
  });

  test("Escape still closes the dialog", async ({ page }) => {
    await pinLocaleEn(page);
    await page.goto("/bots");
    await expect(page.getByTestId("bots-page")).toBeVisible({ timeout: 15000 });

    await page.getByTestId("bots-add").click();
    await expect(page.getByTestId("bot-name")).toBeVisible();
    // The Escape handler reads onOpenChange through a ref now — this is the
    // check that the ref is kept current rather than captured at mount.
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("bot-name")).toBeHidden();
  });
});
