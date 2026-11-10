import { test, expect } from "@playwright/test";
import { gotoChat } from "./helpers.js";

// add-sidebar-workspaces: the sidebar session region groups sessions under
// the workspace they were stamped with, with client-side search and per-group
// pagination. The UI derives everything from the sessions payload, so the
// hermetic path injects stamped sessions through the e2e store seam instead
// of performing slow real workspace switches (each restarts the dsh child).

async function injectSessions(page, sessions, currentSessionId) {
  await page.evaluate(
    ([list, current]) => {
      window.__chatStore.setState({ sessions: list, currentSessionId: current });
    },
    [sessions, currentSessionId],
  );
}

const _DAY = 24 * 60 * 60 * 1000;
const iso = (hoursAgo) => new Date(Date.now() - hoursAgo * 3600 * 1000).toISOString();

function stampedSession(id, title, workspace, hoursAgo, projectId = null) {
  return { id, title, updatedAt: iso(hoursAgo), workspace, agentPreset: null, projectId };
}

// The two projects the web surface groups by (add-web-project-container). The
// stub answers the sidebar's /api/projects read; sessions carry projectId.
const PROJECTS = [
  { id: "p-paas", name: "paas", backingPath: "/home/me/paas" },
  { id: "p-other", name: "other", backingPath: "/home/me/other" },
];
async function stubProjects(page, projects = PROJECTS) {
  await page.route("**/api/projects", (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify({ projects }) }),
  );
}

// Simulate the Electron shell so IS_DESKTOP evaluates true at module load —
// the desktop fork groups by workspace PATH, the web fork by project NAME.
async function asDesktop(page) {
  await page.addInitScript(() => {
    window.platform = { pickWorkdir: () => Promise.resolve(null) };
  });
}

test.describe("sidebar workspaces", () => {
  test("web groups by project name with the 默认项目 fallback", async ({ page }) => {
    await stubProjects(page);
    await gotoChat(page);
    await injectSessions(page, [
      stampedSession("a1", "alpha", "/home/me/paas", 1, "p-paas"),
      stampedSession("a2", "alpha two", "/home/me/paas", 2, "p-paas"),
      stampedSession("b1", "beta", "/home/me/other", 3, "p-other"),
      { id: "u1", title: "legacy row", updatedAt: iso(4), agentPreset: null },
    ], "a1");

    const groups = page.getByTestId("workspace-group");
    await expect(groups).toHaveCount(3);
    // Labels are project NAMES (never the absolute path); the unattributed row
    // falls to the read-time 默认项目 group.
    await expect(page.getByTestId("workspace-group").filter({ hasText: "paas" })).toBeVisible();
    await expect(page.getByTestId("workspace-group").filter({ hasText: "other" })).toBeVisible();
    await expect(page.getByTestId("workspace-group").filter({ hasText: "Default project" })).toBeVisible();
    // No absolute path leaks into a web group label.
    await expect(groups.filter({ hasText: "/home/me" })).toHaveCount(0);
    // The current session's group opens by default and holds the active row.
    const paasGroup = page.getByTestId("workspace-group").filter({ hasText: "paas" });
    await expect(paasGroup.getByTestId("session-row")).toHaveCount(2);
    await expect(paasGroup.getByTestId("session-row").first()).toHaveAttribute("data-current", "true");
    // Non-current groups stay collapsed by default.
    await expect(page.getByTestId("workspace-group").filter({ hasText: "other" }).getByTestId("session-row")).toHaveCount(0);
  });

  test("desktop still groups by workspace path with the Ungrouped fallback", async ({ page }) => {
    await asDesktop(page);
    await gotoChat(page);
    await injectSessions(page, [
      stampedSession("a1", "alpha", "/home/me/paas", 1),
      stampedSession("a2", "alpha two", "/home/me/paas", 2),
      stampedSession("b1", "beta", "/home/me/other", 3),
      { id: "u1", title: "legacy row", updatedAt: iso(4), agentPreset: null },
    ], "a1");

    const groups = page.getByTestId("workspace-group");
    await expect(groups).toHaveCount(3);
    // Desktop labels are path basenames; the null-workspace row is Ungrouped.
    await expect(page.getByTestId("workspace-group").filter({ hasText: "paas" })).toBeVisible();
    await expect(page.getByTestId("workspace-group").filter({ hasText: "other" })).toBeVisible();
    await expect(page.getByTestId("workspace-group").filter({ hasText: "Ungrouped" })).toBeVisible();
  });

  test("group collapse toggle and per-group show-more pagination", async ({ page }) => {
    const many = Array.from({ length: 7 }, (_, i) =>
      stampedSession(`m${i}`, `row ${i}`, "/home/me/paas", i + 1, "p-paas"),
    );
    await stubProjects(page);
    await gotoChat(page);
    await injectSessions(page, many, "m0");

    const paasGroup = page.getByTestId("workspace-group").filter({ hasText: "paas" });
    // Preview cap of 5 + a show-more expander naming the remainder.
    await expect(paasGroup.getByTestId("session-row")).toHaveCount(5);
    const showMore = paasGroup.getByTestId("workspace-show-more");
    await expect(showMore).toHaveText(/2/);
    await showMore.click();
    await expect(paasGroup.getByTestId("session-row")).toHaveCount(7);
    await paasGroup.getByTestId("workspace-show-less").click();
    await expect(paasGroup.getByTestId("session-row")).toHaveCount(5);

    // Collapsing the group hides its rows; expanding restores them.
    await paasGroup.getByTestId("workspace-group-toggle").click();
    await expect(paasGroup.getByTestId("session-row")).toHaveCount(0);
    await paasGroup.getByTestId("workspace-group-toggle").click();
    await expect(paasGroup.getByTestId("session-row")).toHaveCount(5);
  });

  test("search filters session titles across groups and restores on clear", async ({ page }) => {
    await stubProjects(page);
    await gotoChat(page);
    await injectSessions(page, [
      stampedSession("a1", "kubernetes debug", "/home/me/paas", 1, "p-paas"),
      stampedSession("b1", "kubernetes upgrade", "/home/me/other", 2, "p-other"),
      stampedSession("b2", "grocery list", "/home/me/other", 3, "p-other"),
    ], "a1");

    await page.getByTestId("workspace-search-toggle").click();
    await page.getByTestId("workspace-search-input").fill("kubernetes");
    // Matches keep their groups; the group with no match drops out.
    await expect(page.getByTestId("session-row")).toHaveCount(2);
    await expect(page.getByTestId("workspace-group").filter({ hasText: "grocery" })).toHaveCount(0);
    // Clearing (via the close button) restores the full grouped list — both
    // groups return, and the non-current group re-collapses to its default.
    await page.getByTestId("workspace-search-close").click();
    await expect(page.getByTestId("workspace-group")).toHaveCount(2);
    await expect(page.getByTestId("workspace-group").filter({ hasText: "paas" }).getByTestId("session-row")).toHaveCount(1);
    // Expanding the restored group reveals its two rows again.
    const otherGroup = page.getByTestId("workspace-group").filter({ hasText: "other" });
    await otherGroup.getByTestId("workspace-group-toggle").click();
    await expect(otherGroup.getByTestId("session-row")).toHaveCount(2);
  });

  test("new-workspace action rejects a relative path without switching", async ({ page }) => {
    await gotoChat(page);
    await page.getByTestId("workspace-new").click();
    await page.getByTestId("workspace-new-input").fill("relative/path");
    await page.getByTestId("workspace-new-input").press("Enter");
    await expect(page.getByTestId("workspace-new-error")).toBeVisible();
    // The runtime workspace is unchanged: still whatever the server reported
    // (or unset) — assert via the store, never a set_workspace message.
    const ws = await page.evaluate(() => window.__chatStore.getState().currentWorkspace);
    expect(ws).not.toBe("relative/path");
  });

  test("new-workspace action switches the runtime for a valid path", async ({ page }) => {
    await gotoChat(page);
    const original = await page.evaluate(() => window.__chatStore.getState().currentWorkspace);
    await page.getByTestId("workspace-new").click();
    // The popover is name-first (add-projects-automation-flow); raw paths are
    // the advanced mode. A fresh chat has no turns, so the mid-conversation
    // confirm is skipped.
    await page.getByTestId("workspace-new-advanced").click();
    await page.getByTestId("workspace-new-input").fill("/tmp");
    await page.getByTestId("workspace-new-input").press("Enter");
    // The restart-carrying switch: pending blocks the composer, then the
    // confirming workspace_changed broadcast lands. macOS resolves /tmp to
    // /private/tmp, so assert "the workspace changed to a tmp path".
    await expect
      .poll(() => page.evaluate(() => window.__chatStore.getState().pendingConfig), { timeout: 5000 })
      .toBe("workspace");
    await expect
      .poll(() => page.evaluate(() => window.__chatStore.getState().currentWorkspace), { timeout: 60000 })
      .toMatch(/^\/(private\/)?tmp$/);
    // Put the runtime back so later specs see the default workspace.
    await page.getByTestId("workspace-new").click();
    await page.getByTestId("workspace-new-advanced").click();
    await page.getByTestId("workspace-new-input").fill(original);
    await page.getByTestId("workspace-new-input").press("Enter");
    await expect
      .poll(() => page.evaluate(() => window.__chatStore.getState().currentWorkspace), { timeout: 60000 })
      .toBe(original);
  });
});
