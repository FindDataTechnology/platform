import { test, expect } from "@playwright/test";
import { gotoChat } from "./helpers.js";

// MCP tool blocks lead with the localized human label when the supply-annotation
// index has one, and the raw callable stays visible beside it.
//
// The block's `name` arrives WITHOUT the `mcp__` prefix (`websearch__web_search`)
// while the index is keyed the same way — a parser that required the prefix made
// every lookup miss, so no label ever rendered (found live 2026-11-24). This
// pins both shapes: prefixed and bare must resolve to the same entry.
//
// The store is injected instead of spending a real LLM turn (same posture as
// chat-chart-rendering.spec.js).

async function pushToolBlock(page, name) {
  await page.evaluate((n) => {
    const s = window.__chatStore.getState();
    s.apply({ type: "agent_start" });
    s.apply({ type: "tool_start", toolCallId: "t-" + n, name: n, args: {} });
    s.apply({ type: "tool_end", toolCallId: "t-" + n, result: "ok" });
    s.apply({ type: "done" });
  }, name);
  // A lone tool block forms a "machinery run" and the master collapse folds it
  // CLOSED by default (chat-activity-collapse: a group is open only on an
  // explicit override or when it holds an errored tool). So the block — and its
  // annotation label — is not in the DOM until the group header is expanded.
  // That collapse is the designed behaviour, not the thing under test; open it
  // the way a reader would, then assert the label.
  const group = page.getByTestId("activity-group").first();
  if ((await group.count()) > 0) {
    const open = await group.getAttribute("data-open");
    if (open !== "true") await group.getByRole("button").first().click();
  }
}

test.describe("tool annotation label", () => {
  test.beforeEach(async ({ page }) => {
    await gotoChat(page);
  });

  test("bare (prefix-stripped) MCP name resolves to its human label", async ({ page }) => {
    await pushToolBlock(page, "websearch__web_search");
    const label = page.locator('[data-testid="tool-annotation-label"]').first();
    await expect(label).toBeVisible();
    // The raw callable is never replaced — it stays beside the label.
    await expect(label).toContainText("websearch__web_search");
  });

  test("prefixed MCP name resolves to the same label", async ({ page }) => {
    await pushToolBlock(page, "mcp__websearch__web_search");
    const label = page.locator('[data-testid="tool-annotation-label"]').first();
    await expect(label).toBeVisible();
    await expect(label).toContainText("mcp__websearch__web_search");
  });

  test("a non-MCP tool keeps rendering its bare name", async ({ page }) => {
    await pushToolBlock(page, "bash");
    await expect(page.locator('[data-testid="tool-annotation-label"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="tool-block"]').first()).toContainText("bash");
  });
});
