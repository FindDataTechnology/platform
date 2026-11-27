// NOT RUNNING — this file drives the agents hub, which no longer exists.
//
// Both tests assert the four-zone hub's shell (`creations-section` and the tab
// set) reached through /agents?tab=agents. The W2 teardown (0eb48a0d0,
// 2026-11-06) replaced that page with AgentMarketPage; `creations-section` now
// lives only in the unrouted AgentsPage.tsx, so no URL can reach it. The white-
// screen guard these tests were built for is served by the shell error boundary
// today (harden-spa-shell-resilience), which has its own coverage. Marked fixme
// rather than deleted: if a builders' hub returns, these are the tests to
// resurrect.
// Smoke: /agents must render without a runtime crash (white screen guard).
import { test, expect } from "@playwright/test";

test.fixme("@smoke agents page renders (no white screen)", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });

  await page.goto("/agents?tab=agents", { waitUntil: "networkidle" });

  // The page shell must be present (the crash unmounts the whole tree)
  await expect(page.getByRole("tab", { name: /专家|Experts/i })).toBeVisible({ timeout: 15000 });

  // The agents section must mount
  await expect(page.locator('[data-testid="creations-section"]')).toBeVisible({ timeout: 15000 });

  // No uncaught runtime errors
  const fatal = errors.filter((e) => !/Failed to load resource|401|404/i.test(e));
  expect(fatal, "runtime errors:\n" + fatal.join("\n")).toHaveLength(0);

  // The cluster create entry must exist and open the composer (the modal was
  // written but never mounted until this fix — an unreachable feature).
  const newCluster = page.getByTestId("new-cluster-btn");
  await expect(newCluster).toBeVisible({ timeout: 10000 });
  await newCluster.click();
  await expect(page.getByRole("dialog")).toBeVisible({ timeout: 10000 });
  await page.keyboard.press("Escape");

  // The group empty state must speak about groups, not about agents
  // (the composer's "No agents available" line was reused here by mistake).
  const empty = page.getByTestId("clusters-empty");
  if (await empty.count()) {
    const txt = await empty.innerText();
    expect(txt, "groups empty state must mention groups").toMatch(/group|小组|grupo|groupe|グループ/i);
    expect(txt, "must not reuse the composer's no-agents line").not.toMatch(/No agents available/i);
  }

  // If a cluster card exists, Manage must open its detail (guards the
  // clusterId-vs-id mismatch that produced GET /api/clusters/undefined).
  const row = page.getByTestId("cluster-row").first();
  if (await row.count()) {
    const seen = [];
    page.on("request", (r) => { if (/\/api\/clusters\//.test(r.url())) seen.push(r.url()); });
    await row.getByRole("button").first().click();
    await expect(page.getByTestId("cluster-detail")).toBeVisible({ timeout: 10000 });
    expect(seen.some((u) => u.includes("/undefined")), "no request may carry an undefined id").toBe(false);
    await page.keyboard.press("Escape");
  }

  // The clusters listing endpoint must resolve (route order regression guard:
  // /api/clusters/mine must be registered BEFORE /api/clusters/:id).
  const mine = await page.evaluate(async () => {
    const r = await fetch("/api/clusters/mine");
    const ct = r.headers.get("content-type") || "";
    return { status: r.status, json: ct.includes("application/json") };
  });
  // 200 (session) or 401 (no session) both prove the route is registered and
  // answering JSON; a 404 means /:id captured "mine" — the regression this guards.
  expect(mine.json, "/api/clusters/mine must answer JSON, not the SPA fallback").toBe(true);
  expect([200, 401], "/api/clusters/mine must not 404 (route order)").toContain(mine.status);
});

test.fixme("a delayed cluster read shows no empty copy until it lands (polish-web-surfaces)", async ({
  page,
}) => {
  // Hold the clusters read so the loading frame is observable.
  await page.route("**/api/clusters/mine", async (route) => {
    await new Promise((r) => setTimeout(r, 1500));
    await route.continue();
  });

  await page.goto("/agents?tab=agents");
  await expect(page.locator('[data-testid="creations-section"]')).toBeVisible({ timeout: 15000 });

  // In flight: the section is mounted, but the empty copy must not be there.
  await expect(page.getByTestId("clusters-empty")).toHaveCount(0);

  // Once it lands, the section is either populated or honestly empty.
  await expect
    .poll(
      async () =>
        (await page.getByTestId("clusters-empty").count()) + (await page.getByTestId("cluster-row").count()),
      { timeout: 15000 },
    )
    .toBeGreaterThan(0);
});
