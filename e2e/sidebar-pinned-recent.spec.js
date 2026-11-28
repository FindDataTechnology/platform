import { test, expect } from "@playwright/test";
import { gotoChat } from "./helpers.js";

// sidebar-pinned-and-recent: the session area defaults to 置顶 + 最近, with a
// 最近 / 按项目 switch. Sessions are injected through the e2e store seam — the
// UI derives everything from the sessions payload, so no real turn is needed.

async function injectSessions(page, sessions, currentSessionId) {
  await page.evaluate(
    ([list, current]) => {
      window.__chatStore.setState({ sessions: list, currentSessionId: current });
    },
    [sessions, currentSessionId],
  );
}

const iso = (hoursAgo) => new Date(Date.now() - hoursAgo * 3600 * 1000).toISOString();

const row = (id, title, hoursAgo, extra = {}) => ({
  id,
  title,
  updatedAt: iso(hoursAgo),
  workspace: null,
  agentPreset: null,
  projectId: null,
  pinnedAt: null,
  ...extra,
});

async function stubProjects(page) {
  await page.route("**/api/projects", (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify({ projects: [] }) }),
  );
}

test.describe("sidebar pinned and recent", () => {
  test("pinned sessions get their own group and are not repeated in recent", async ({ page }) => {
    await stubProjects(page);
    await gotoChat(page);
    await injectSessions(
      page,
      [
        row("s-old", "old pinned", 40, { pinnedAt: iso(2) }),
        row("s-new", "newest unpinned", 1),
        row("s-mid", "middle unpinned", 2),
      ],
      "s-new",
    );

    const pinned = page.getByTestId("session-pinned-group");
    await expect(pinned).toBeVisible();
    await expect(pinned).toContainText("old pinned");
    await expect(page.getByTestId("session-recent-group")).toContainText("newest unpinned");
    // The pinned row is not duplicated in the recent list.
    await expect(page.getByTestId("session-recent-group")).not.toContainText("old pinned");
  });

  test("no pinned group when nothing is pinned", async ({ page }) => {
    await stubProjects(page);
    await gotoChat(page);
    await injectSessions(page, [row("s1", "only chat", 1)], "s1");
    await expect(page.getByTestId("session-pinned-group")).toHaveCount(0);
    await expect(page.getByTestId("session-recent-group")).toContainText("only chat");
  });

  test("the 最近 / 按项目 switch persists across reloads", async ({ page }) => {
    await stubProjects(page);
    await gotoChat(page);
    await injectSessions(page, [row("s1", "only chat", 1)], "s1");

    await page.getByTestId("session-group-project").click();
    await expect(page.getByTestId("session-pinned-group")).toHaveCount(0);
    // Project mode renders the existing workspace groups.
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("composer-input")).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId("session-group-project")).toHaveAttribute("aria-pressed", "true");

    await page.getByTestId("session-group-recent").click();
    await expect(page.getByTestId("session-recent-group")).toBeVisible();
  });
});
