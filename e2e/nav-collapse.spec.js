import { test, expect } from "@playwright/test";
import { pinLocaleEn } from "./helpers.js";

// Nav family collapse semantics (openspec: fix-ia-shell-polish,
// sidebar-nav-families MODIFIED).
//
// The shipped rule was `collapsed = !isActiveFamily && stored.has(id)`: the
// family holding the current route could never collapse, so clicking its header
// changed state with no visual effect — a dead control. And "collapse all" wrote
// every family into the stored set while rendering force-expanded the active
// one, so the toggle said "expand all" with a family still open.
//
// The rules this spec pins:
//   1. ANY family collapses on click, including the active one.
//   2. A collapsed family that still holds the active route keeps a marker, so
//      collapsing never hides where you are.
//   3. Collapse-all leaves every family collapsed — no exception for the active
//      one — and the global control's own state agrees with the render.
//   4. Entering a collapsed family (deep link / navigation) reveals it once.

const family = (page, id) => page.getByTestId(`nav-family-${id}`);

async function gotoAgents(page) {
  await pinLocaleEn(page);
  await page.goto("/agents");
  await expect(page.getByTestId("agent-market-page")).toBeVisible({ timeout: 15000 });
}

test.describe("nav family collapse", () => {
  test("the active family collapses on click, and keeps an active marker", async ({ page }) => {
    await gotoAgents(page);
    const build = family(page, "build");
    await expect(build.getByTestId("nav-agents")).toBeVisible();

    // Click the header of the family we are INSIDE. Before the fix this did
    // nothing visible.
    await build.getByTestId("nav-family-toggle-build").click();
    await expect(build.getByTestId("nav-agents")).toHaveCount(0, { timeout: 5000 });
    await expect(build.getByTestId("nav-family-active-dot-build")).toBeVisible();

    // Clicking again restores it (the control is not a one-way trap).
    await build.getByTestId("nav-family-toggle-build").click();
    await expect(build.getByTestId("nav-agents")).toBeVisible();
    await expect(build.getByTestId("nav-family-active-dot-build")).toHaveCount(0);
  });

  test("collapse-all folds every family and the control agrees with the render", async ({ page }) => {
    await gotoAgents(page);
    const toggleAll = page.getByTestId("nav-families-toggle-all");
    await expect(toggleAll).toBeVisible({ timeout: 15000 });

    await toggleAll.click();
    // No exception for the active family.
    for (const id of ["knowledge", "build", "run", "access"]) {
      const fam = family(page, id);
      if ((await fam.count()) === 0) continue; // flattened single-member family
      await expect(fam.getByTestId(`nav-family-toggle-${id}`)).toHaveAttribute("aria-expanded", "false");
    }
    await expect(page.getByTestId("nav-agents")).toHaveCount(0);
    // The control now reads "expand all" — it used to stay on "collapse all"
    // whenever the active family was force-expanded.
    await expect(toggleAll).toHaveAttribute("data-collapsed", "true");

    await toggleAll.click();
    await expect(page.getByTestId("nav-agents")).toBeVisible();
    await expect(toggleAll).toHaveAttribute("data-collapsed", "false");
  });

  test("a deep link into a collapsed family reveals it once", async ({ page }) => {
    await pinLocaleEn(page);
    await page.goto("/chat");
    const toggleAll = page.getByTestId("nav-families-toggle-all");
    await expect(toggleAll).toBeVisible({ timeout: 15000 });
    await toggleAll.click();

    // Navigate INTO a collapsed family: it must open so the surface is visible.
    await page.goto("/tuning");
    await expect(page.getByTestId("tuning-page")).toBeVisible({ timeout: 15000 });
    await expect(family(page, "build").getByTestId("nav-tuning")).toBeVisible();

    // …and the user can still fold it afterwards (entry reveal is one-shot).
    await family(page, "build").getByTestId("nav-family-toggle-build").click();
    await expect(family(page, "build").getByTestId("nav-tuning")).toHaveCount(0);
  });
});

// The first-run tour card used to render its own i18n KEY as body text
// (`onboarding.tour.steponboarding.tour.step1.title`) — the key was built by
// concatenating `step` + a value that was already a full key. A raw key on the
// very first screen is the most visible failure the shell can produce, so it
// gets its own assertion rather than relying on the copy looking right.
test.describe("first-run tour copy", () => {
  test("the tour card carries real copy, never a raw i18n key", async ({ page }) => {
    // Opt back IN to the tour (every other spec opts out) and land on chat.
    await page.addInitScript(() => {
      // Every other spec opts out of the tour in its own init script; this one
      // opts back in by REMOVING the marker on a short interval, because the
      // opt-out may run after this script on the same page.
      try {
        localStorage.setItem("platform.locale", "en");
        const clear = () => localStorage.removeItem("onboarding.tour.done");
        clear();
        const timer = setInterval(clear, 50);
        setTimeout(() => clearInterval(timer), 4000);
      } catch {
        /* ignore */
      }
    });
    await page.goto("/chat");
    // Assert on the CARD: the outer `onboarding-tour` node is a zero-box
    // wrapper (its children are `fixed`), so "visible" on it is meaningless.
    const card = page.getByTestId("tour-card");
    await expect(card).toBeVisible({ timeout: 15000 });
    const text = await card.innerText();
    expect(text).not.toMatch(/onboarding\.[a-z]/i);
    expect(text.trim().length).toBeGreaterThan(10);
  });
});
