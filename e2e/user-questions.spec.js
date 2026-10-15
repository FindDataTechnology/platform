import { test, expect } from "@playwright/test";
import { gotoChat, waitForIdle } from "./helpers.js";

// User questions (spec: web-chat-ui, add-user-questions). The fast tests
// inject the ask through the store seam (no LLM) and cover the card's two
// faces, the composer gate, and the {{seconds}} interpolation regression in
// the activity header. The full loop — bridge → pump → WS → card → answer →
// RPC → tool_end — is the @smoke test with the real runtime.

const QUESTIONS = [
  {
    id: "q1",
    question: "Continue with the red theme?",
    options: [
      { label: "Yes, red" },
      { label: "No, keep blue" },
    ],
  },
];

// Open a turn whose ask tool call parks, exactly the live order.
async function injectPendingAsk(page) {
  await page.evaluate((questions) => {
    const s = window.__chatStore;
    s.getState().apply({ type: "agent_start" });
    s.getState().apply({
      type: "tool_start",
      toolCallId: "ask-e2e-1",
      name: "ask_user_question",
      args: { questions },
    });
    s.getState().apply({
      type: "agent_question",
      askId: "ask-e2e",
      toolCallId: "ask-e2e-1",
      questions,
    });
  }, QUESTIONS);
  // NOTE: NO toggleAllGroups — the group holding the live ask must
  // AUTO-EXPAND (the fd-prod smoke caught the card hiding behind the
  // collapsed header; groupHasPendingAsk now forces it open).
}

test.describe("Question card (store seam)", () => {
  test("a pending ask renders the interactive card and gates the composer", async ({ page }) => {
    await gotoChat(page);
    await waitForIdle(page);

    await injectPendingAsk(page);
    // The ask renders as a card, not a raw tool block: option buttons and the
    // custom-answer field are present.
    const card = page.getByTestId("question-card");
    await expect(card).toHaveAttribute("data-pending", "true");
    await expect(card.getByTestId("question-option", { exact: false }).first()).toBeVisible();
    await expect(card.getByTestId("question-custom")).toBeVisible();

    // The composer's send affordance is unavailable while the ask holds the
    // floor: the turn is streaming (stop button) and a typed draft cannot be
    // sent (the send button never appears).
    await page.getByTestId("composer-input").fill("parallel draft");
    await expect(page.getByTestId("composer-send")).toHaveCount(0);
    await expect(page.getByTestId("composer-stop")).toBeVisible();

    // Submit stays disabled until a question is answered.
    await expect(card.getByTestId("question-submit")).toBeDisabled();
    await card.getByTestId("question-option").filter({ hasText: "Yes, red" }).click();
    await expect(card.getByTestId("question-submit")).toBeEnabled();
  });

  test("resolution collapses the card to a summary; history replay is static", async ({ page }) => {
    await gotoChat(page);
    await waitForIdle(page);

    await injectPendingAsk(page);
    // Answer: select the option, then the ask's own tool_end lands (answer,
    // cancellation, or failure all take this path).
    await page.getByTestId("question-card").getByTestId("question-option").filter({ hasText: "No, keep blue" }).click();
    await page.evaluate(() => {
      const s = window.__chatStore;
      s.getState().apply({
        type: "tool_end",
        toolCallId: "ask-e2e-1",
        name: "ask_user_question",
        result: '{"answers":[{"id":"q1","selected":["No, keep blue"]}]}',
      });
      s.getState().apply({ type: "done" });
    });
    // After resolution the ask group folds back to collapsed-by-default (the
    // answered summary follows the platform's fold-away idiom) — open the
    // group by clicking its header before asserting the summary.
    await page.getByTestId("activity-group").first().click();

    const card = page.getByTestId("question-card");
    await expect(card).toHaveAttribute("data-pending", "false");
    await expect(card).toContainText("No, keep blue");
    // Static summary: no interactive affordances survive.
    await expect(card.getByTestId("question-submit")).toHaveCount(0);
    await expect(card.getByTestId("question-custom")).toHaveCount(0);
    // The composer is back.
    await page.getByTestId("composer-input").fill("hello again");
    await expect(page.getByTestId("composer-send")).toBeVisible();
  });

  test("activity headers interpolate every placeholder ({{seconds}} regression)", async ({ page }) => {
    await gotoChat(page);
    await waitForIdle(page);

    // A finished turn with thinking + executed steps renders the timed
    // summary header; a dropped interpolation parameter used to leak the
    // literal {{seconds}} into it (add-user-questions, bug #2).
    await page.evaluate(() => {
      const s = window.__chatStore;
      s.getState().apply({ type: "agent_start" });
      s.getState().apply({ type: "tool_start", toolCallId: "t-1", name: "bash", args: { cmd: "ls" } });
      s.getState().apply({ type: "tool_end", toolCallId: "t-1", name: "bash", result: "ok" });
      s.getState().apply({ type: "done" });
    });
    await page.evaluate(() => window.__chatStore.getState().toggleAllGroups());

    const header = page.getByTestId("activity-group").first();
    await expect(header).toBeVisible();
    const text = (await header.textContent()) ?? "";
    expect(text, `header leaked a placeholder: ${text}`).not.toContain("{{");
  });
});

test.describe("Question card (live loop)", () => {
  // @smoke - one real LLM turn that parks on ask_user_question, survives a
  // reload (server-side pending rehydration), and resolves through the
  // answer RPC: the card flips to its summary and the turn completes.
  test("@smoke a real ask answers end to end and survives reload", async ({ page }) => {
    await gotoChat(page);
    await waitForIdle(page);

    await page.getByTestId("composer-input").fill(
      "调用 ask_user_question 工具问我一个问题：question 为“继续吗？”，两个选项：继续、停止。不要做别的事。",
    );
    await page.getByTestId("composer-send").click();

    // The turn parks on the ask: the interactive card appears.
    const card = page.getByTestId("question-card");
    await expect(card).toHaveAttribute("data-pending", "true", { timeout: 60_000 });

    // Reload mid-ask: the server's pending state rehydrates the card.
    await page.reload();
    await expect(card).toHaveAttribute("data-pending", "true", { timeout: 30_000 });

    // Answer through the card; the ask's tool_end collapses it to a summary
    // and the turn runs to completion.
    await card.getByTestId("question-option").filter({ hasText: "继续" }).click();
    await card.getByTestId("question-submit").click();
    await expect(card).toHaveAttribute("data-pending", "false", { timeout: 60_000 });
    await waitForIdle(page, 90_000);
  });
});
