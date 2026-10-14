import { test, expect } from "@playwright/test";
import { gotoChat } from "./helpers.js";

// The chat log only renders once a turn exists; a fresh session shows the
// welcome screen. Seed one fake turn through the e2e build store seam so the
// layout assertions have a real log to measure against (no LLM involved).

// Regression: the chat page must fit the viewport. The message log is the only
// vertical scroller; the composer stays pinned. See openspec/changes/archive/
// (or openspec/changes/fix-chat-panel-height/) for the layout requirement in
// chat-ui-shell.
//
// The check is purely layout-based (no LLM call), so it lives in the default
// e2e project and runs on every `npm run test:e2e`.

test("chat viewport pins composer regardless of log length", async ({ page }) => {
  await gotoChat(page);

  await page.evaluate(() => {
    const s = window.__chatStore;
    s.getState().apply({ type: "agent_start" });
    s.getState().apply({ type: "text", delta: "layout probe turn" });
    s.getState().apply({ type: "done" });
  });
  await page.waitForTimeout(100);

  const composerSend = page.getByTestId("composer-send");
  const log = page.getByTestId("chat-log");

  // (a) empty state: no page scroll, composer visible.
  await expect(composerSend).toBeInViewport();
  const emptyScroll = await page.evaluate(() => {
    const el = document.scrollingElement || document.documentElement;
    return { sh: el.scrollHeight, ch: el.clientHeight };
  });
  expect(emptyScroll.sh, "no page-level scroll on empty chat").toBe(emptyScroll.ch);

  // (c) long chat: inject tall filler content into the log so its scrollHeight
  // dwarfs the viewport. If min-h-0 is missing on either the <main> or the log,
  // the whole page grows and the composer is pushed off-screen.
  await log.evaluate((el) => {
    const filler = document.createElement("div");
    filler.style.height = "5000px";
    filler.setAttribute("data-testid", "layout-filler");
    el.appendChild(filler);
  });

  const afterFill = await page.evaluate(() => {
    const el = document.scrollingElement || document.documentElement;
    return { sh: el.scrollHeight, ch: el.clientHeight };
  });
  expect(afterFill.sh, "log overflow must not spill into page scroll").toBe(afterFill.ch);

  // Composer is still in-viewport after filling the log.
  await expect(composerSend).toBeInViewport();

  // The log itself did scroll internally (its scrollHeight exceeds its
  // clientHeight — that's the whole point of overflow-y-auto).
  const logMetrics = await log.evaluate((el) => ({
    sh: el.scrollHeight,
    ch: el.clientHeight,
  }));
  expect(logMetrics.sh, "log scrolls internally").toBeGreaterThan(logMetrics.ch);
});

// Short viewport: even at ~500 px tall the composer stays visible.
test("chat viewport survives a short window", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 500 });
  await gotoChat(page);

  await expect(page.getByTestId("composer-send")).toBeInViewport();

  const { sh, ch } = await page.evaluate(() => {
    const el = document.scrollingElement || document.documentElement;
    return { sh: el.scrollHeight, ch: el.clientHeight };
  });
  expect(sh, "short viewport must not gain page scroll").toBe(ch);
});
