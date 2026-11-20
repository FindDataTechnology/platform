// connect-guidance.spec.js — the in-chat connect pointer (chat-connect-
// guidance) rendered from the WS contract the server emits on credential-
// shaped failures. Driven through the e2e store seam: the classification
// itself is unit-tested (scripts/test-connect-guidance.mjs); this spec proves
// the client side — the CTA renders exactly when a pointer is present and
// deep-links the named connections panel.

import { test, expect } from "@playwright/test";
import { gotoChat } from "./helpers.js";

test("a turn error carrying connect renders 去连接 that deep-links the panel", async ({ page }) => {
  await gotoChat(page);
  await page.evaluate(() => {
    const s = window.__chatStore.getState();
    s.apply({ type: "agent_start" });
    s.apply({ type: "error", message: "401 Unauthorized", connect: { panel: "ciyuan-account" } });
    s.apply({ type: "done" });
  });
  const block = page.getByTestId("turn-error-block").last();
  await expect(block).toContainText("401 Unauthorized");
  const cta = block.getByTestId("turn-connect-cta");
  await expect(cta).toBeVisible();
  await cta.click();
  await expect(page).toHaveURL(/\/settings\/connections\?panel=ciyuan-account/);
  await expect(page.locator("[data-panel='ciyuan-account']")).toHaveAttribute("data-panel-active", "true");
});

test("a turn error without connect renders no CTA", async ({ page }) => {
  await gotoChat(page);
  await page.evaluate(() => {
    const s = window.__chatStore.getState();
    s.apply({ type: "agent_start" });
    s.apply({ type: "error", message: "fetch failed: ECONNRESET" });
    s.apply({ type: "done" });
  });
  const block = page.getByTestId("turn-error-block").last();
  await expect(block).toContainText("ECONNRESET");
  await expect(block.getByTestId("turn-connect-cta")).toHaveCount(0);
});

test("a failed tool call carrying connect renders the CTA inside the open tool block", async ({ page }) => {
  await gotoChat(page);
  await page.evaluate(() => {
    const s = window.__chatStore.getState();
    s.apply({ type: "agent_start" });
    s.apply({ type: "tool_start", toolCallId: "c1", name: "mcp__market__search", args: { q: "x" } });
    s.apply({ type: "tool_end", toolCallId: "c1", name: "mcp__market__search", result: "Error: 401 Unauthorized", isError: true, connect: { panel: "registry" } });
    s.apply({ type: "done" });
  });
  // Failed tools auto-open, so the CTA inside the body is visible without a click.
  const cta = page.getByTestId("turn-connect-cta").last();
  await expect(cta).toBeVisible();
  await cta.click();
  await expect(page).toHaveURL(/\/settings\/connections\?panel=registry/);
});
