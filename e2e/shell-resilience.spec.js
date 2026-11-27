import { test, expect } from "@playwright/test";
import { pinLocaleEn } from "./helpers.js";

// Shell-resilience sentinels (openspec: harden-spa-shell-resilience, task 3.1).
//
// A: the stale-shell race — a lazy chunk 404s (simulating a rollout that
// renamed it while an old index.html is still in play) → the boundary
// auto-reloads EXACTLY once; when the same chunk fails again the app lands
// on the shell error card instead of looping. The chunk request is counted:
// two attempts, never three.
//
// B: a render crash — the module evaluates but throws → not classified as a
// chunk failure → no reload at all; the content area degrades to the error
// card while the rail stays alive (the white-screen regression this change
// exists to kill).

test("stale chunk auto-reloads once, then the error card — no loop", async ({ page }) => {
  await pinLocaleEn(page);
  await page.goto("/chat");
  await expect(page.getByTestId("nav-apps")).toBeVisible({ timeout: 15000 });

  let attempts = 0;
  await page.route("**/assets/ZhiyuPage-*.js", (route) => {
    attempts += 1;
    void route.abort();
  });

  await page.getByTestId("nav-zhiyu").click();

  // The first failure claims the once-reload; the second (post-reload) lands
  // on the card. Poll the attempt count first: React renders the card
  // momentarily BEFORE componentDidCatch reloads, so asserting the card
  // directly would race the transient first-document card.
  await expect.poll(() => attempts, { timeout: 20000 }).toBe(2);
  await expect(page.getByTestId("shell-error-card")).toBeVisible({ timeout: 20000 });
  expect(attempts).toBe(2); // reload happened exactly once, no loop
  // The rail survived — this is the difference from a white screen.
  await expect(page.getByTestId("nav-apps")).toBeVisible();
});

test("a crashing route degrades the content area, rail and both exits intact", async ({ page }) => {
  await pinLocaleEn(page);
  await page.goto("/chat");
  await expect(page.getByTestId("nav-apps")).toBeVisible({ timeout: 15000 });

  let reloads = 0;
  page.on("framenavigated", () => (reloads += 1));

  // The module loads (200) but throws at evaluation — a render crash, not a
  // stale-chunk signal: the boundary must NOT reload.
  await page.route("**/assets/MachinesPage-*.js", (route) =>
    route.fulfill({
      contentType: "application/javascript",
      body: 'throw new Error("e2e fixture render crash");',
    }),
  );

  const navBefore = reloads;
  await page.getByTestId("nav-machines").click();

  await expect(page.getByTestId("shell-error-card")).toBeVisible({ timeout: 15000 });
  // No auto-reload for a non-chunk crash (only the SPA navigation itself).
  expect(reloads - navBefore).toBeLessThanOrEqual(1);
  // Both exits present; the rail stays alive.
  await expect(page.getByTestId("shell-error-card").getByRole("button")).toHaveCount(2);
  await expect(page.getByTestId("nav-apps")).toBeVisible();

  // Retry re-renders the subtree: the card owns the failure again (the module
  // still throws) without blanking the shell.
  await page.getByTestId("shell-error-card").getByRole("button").first().click();
  await expect(page.getByTestId("shell-error-card")).toBeVisible();
  await expect(page.getByTestId("nav-apps")).toBeVisible();
});
