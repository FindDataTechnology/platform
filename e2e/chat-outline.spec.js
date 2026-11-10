import { test, expect } from "@playwright/test";
import { gotoChat } from "./helpers.js";

// Conversation outline (add-chat-outline). The threshold, hover-expand, and
// jump behaviors are UI-level: like plan-progress, these tests drive the
// store through the e2e build's `window.__chatStore` seam — user turns via
// `user`, completed answers via agent_start/text/done, an open streaming turn
// via agent_start with no done. No LLM calls.

const apply = (page, m) => page.evaluate((msg) => window.__chatStore.getState().apply(msg), m);

async function injectAnsweredTurn(page, question) {
  await apply(page, { type: "user", text: question });
  await apply(page, { type: "agent_start" });
  await apply(page, { type: "text", delta: `answer to ${question} `.repeat(60) });
  await apply(page, { type: "done" });
}

const logScroll = (page) =>
  page.getByTestId("chat-log").evaluate((el) => ({
    top: el.scrollTop,
    max: el.scrollHeight - el.clientHeight,
  }));

test.describe("conversation outline", () => {
  test.beforeEach(async ({ page }) => {
    await gotoChat(page);
  });

  test("hidden below 3 user turns, edge control appears at 3 (user turns counted, not all turns)", async ({
    page,
  }) => {
    await injectAnsweredTurn(page, "first question");
    await injectAnsweredTurn(page, "second question");
    await expect(page.getByTestId("chat-outline")).toHaveCount(0);

    // A third user turn crosses the threshold — the rail appears.
    await injectAnsweredTurn(page, "third question");
    await expect(page.getByTestId("chat-outline-edge")).toBeVisible();
  });

  test("hover expands the card with one entry per user turn; leaving collapses", async ({ page }) => {
    await injectAnsweredTurn(page, "alpha question");
    await injectAnsweredTurn(page, "beta question");
    await injectAnsweredTurn(page, "gamma question");

    await page.getByTestId("chat-outline-edge").hover();
    await expect(page.getByTestId("chat-outline-entry")).toHaveCount(3);
    await expect(page.getByTestId("chat-outline-entry").first()).toContainText("alpha question");
    // The "—" collapse affordance is present in the expanded state.
    await expect(page.getByTestId("chat-outline-collapse")).toBeVisible();

    // Leaving the rail (pointer to the far edge of the log) collapses it.
    const log = page.getByTestId("chat-log");
    const box = await log.boundingBox();
    await page.mouse.move(box.x + 8, box.y + box.height - 8);
    await expect(page.getByTestId("chat-outline-edge")).toBeVisible();
    await expect(page.getByTestId("chat-outline-collapse")).toHaveCount(0);
  });

  test("hovering an entry reveals the full prompt (line clamp grows)", async ({ page }) => {
    await injectAnsweredTurn(page, "alpha question");
    await injectAnsweredTurn(page, "beta question");
    await injectAnsweredTurn(page, "gamma question");

    await page.getByTestId("chat-outline-edge").hover();
    const entryText = page.getByTestId("chat-outline-entry").first().locator("span").last();
    const clampOf = () =>
      entryText.evaluate((el) => {
        const cs = getComputedStyle(el);
        return String(cs.webkitLineClamp !== "unset" ? cs.webkitLineClamp : cs.lineClamp);
      });
    await expect.poll(clampOf, { timeout: 3000 }).toContain("1");

    await page.getByTestId("chat-outline-entry").first().hover();
    await expect.poll(clampOf, { timeout: 3000 }).toContain("4");
  });

  test("clicking an entry jumps, flashes, and stops stream auto-scroll until back at bottom", async ({
    page,
  }) => {
    for (const q of ["first question", "second question", "third question", "fourth question"]) {
      await injectAnsweredTurn(page, q);
    }
    // An OPEN streaming turn: agent_start without done.
    await apply(page, { type: "user", text: "fifth question" });
    await apply(page, { type: "agent_start" });
    await apply(page, { type: "text", delta: "streaming ".repeat(30) });
    await page.waitForTimeout(150); // delta flush

    // Sanity: the log is scrollable and sticking to the bottom.
    await expect
      .poll(async () => (await logScroll(page)).max, { timeout: 3000 })
      .toBeGreaterThan(200);

    // Jump to the FIRST question.
    await page.getByTestId("chat-outline-edge").hover();
    const targetId = await page.getByTestId("chat-outline-entry").first().getAttribute("data-turn-id");
    await page.getByTestId("chat-outline-entry").first().click();

    // The anchor exists, flashes, and then the flash clears (~1.2s).
    const anchor = page.locator(`#turn-${targetId}`);
    await expect(anchor).toHaveClass(/outline-jump-flash/);
    await expect(anchor).not.toHaveClass(/outline-jump-flash/, { timeout: 4000 });

    // The view scrolled up to the target (top of the log area).
    await expect
      .poll(async () => (await logScroll(page)).top, { timeout: 3000 })
      .toBeLessThan(60);

    // New deltas must NOT yank the view back to the bottom.
    await apply(page, { type: "text", delta: " more streaming text ".repeat(40) });
    await page.waitForTimeout(300); // flush + auto-scroll effect window
    const afterDelta = await logScroll(page);
    expect(afterDelta.top).toBeLessThan(afterDelta.max - 200);

    // Returning to the bottom re-arms stickiness.
    await page.getByTestId("chat-log").evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await page.waitForTimeout(100); // scroll listener sets stick=true
    await apply(page, { type: "text", delta: " tail ".repeat(40) });
    await page.waitForTimeout(300);
    const tail = await logScroll(page);
    expect(tail.top).toBeGreaterThan(tail.max - 60);
  });
});
