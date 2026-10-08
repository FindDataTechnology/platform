import { test, expect } from "@playwright/test";
import { gotoChat } from "./helpers.js";

// @smoke - a real chat turn. Makes one LLM call against the configured provider,
// so it lives in the smoke project (excluded from `npm run test:e2e`, included
// in `npm run test:e2e:smoke`).
//
// Asserts:
//   1. The assistant text is rendered exactly once (not triplicated).
//   2. The turn is persisted to chat history (user + assistant messages).

test("@smoke chat turn saves history without duplicating text", async ({ page, request }) => {
  await gotoChat(page);

  // A prompt that needs no tools, so there is a single assistant text turn.
  await page.getByTestId("composer-input").fill("Reply with only the word: hello");
  await page.getByTestId("composer-send").click();

  // Wait for an assistant turn to appear and finish streaming (data-streaming flips false on `done`).
  const turn = page.getByTestId("turn-assistant").last();
  await expect(turn).toBeVisible({ timeout: 30000 });
  await expect(turn).toHaveAttribute("data-streaming", "false", { timeout: 45000 });

  // The rendered turn includes a thinking block (reasoning) when the model
  // emits reasoning_content; that's rendered but NOT persisted (only text
  // blocks are), so strip it before comparing to the persisted answer —
  // otherwise reasoning inflates the bubble ~30x and trips the ceiling.
  const bubbleText = await turn.evaluate((el) => {
    const clone = el.cloneNode(true);
    clone
      .querySelectorAll('[data-testid="thinking-block"]')
      .forEach((n) => {
        n.remove();
      });
    return (clone.textContent || "").trim();
  });

  // The assistant message is persisted fire-and-forget on `done`, so poll.
  const getAssistantText = async () => {
    const list = await (await request.get("/api/chat-history/sessions")).json();
    if (!list.current) return "";
    const session = await (await request.get(`/api/chat-history/sessions/${list.current}`)).json();
    const asst = (session.messages || []).filter((m) => m.role === "assistant");
    return asst.length ? asst[asst.length - 1].content || "" : "";
  };
  await expect.poll(getAssistantText, { timeout: 10000 }).not.toBe("");
  const asstText = await getAssistantText();

  // No duplication: rendered turn must not be a multiple of the persisted text
  // (the bug emitted it ~3x). 1.5x ceiling separates single (~1.0x) from
  // triple (~3.0x) while tolerating markdown wrapper text ("pi", timestamps,
  // whitespace) in the rendered version.
  const ratio = bubbleText.trim().length / Math.max(1, asstText.trim().length);
  expect(
    ratio,
    `bubble=${JSON.stringify(bubbleText)} asst=${JSON.stringify(asstText)}`,
  ).toBeLessThan(3.0);

  // The user turn is persisted too.
  const sessionsList = await (await request.get("/api/chat-history/sessions")).json();
  const session = await (
    await request.get(`/api/chat-history/sessions/${sessionsList.current}`)
  ).json();
  const userMsgs = (session.messages || []).filter((m) => m.role === "user");
  expect(userMsgs.length, "user message persisted").toBeGreaterThan(0);
});

// @smoke - resume: after a real turn in session A, starting session B clears
// the view, and switching back to A reloads A's history into the chat.
test("@smoke switching sessions resumes the conversation history", async ({ page }) => {
  await gotoChat(page);

  // Start fresh so the marker is this session's first user message.
  await page.getByTestId("new-chat-btn").click();
  await expect(page.getByTestId("turn-user")).toHaveCount(0, { timeout: 5000 });

  const marker = "SWITCHMARKER-abc-123";
  await page.getByTestId("composer-input").fill(`Reply with only the word: ok. (${marker})`);
  await page.getByTestId("composer-send").click();
  await expect(page.getByTestId("turn-assistant").last()).toHaveAttribute(
    "data-streaming",
    "false",
    { timeout: 45000 },
  );

  // Start session B; the chat view clears.
  await page.getByTestId("new-chat-btn").click();
  await expect(page.getByTestId("turn-user")).toHaveCount(0, { timeout: 5000 });

  // Switch back to A by clicking its sidebar row (title contains marker).
  const rowA = page.getByTestId("session-row").filter({ hasText: marker });
  await rowA.click();

  // The resumed user message reappears.
  await expect(page.getByTestId("turn-user").last()).toContainText(marker, { timeout: 5000 });
});
