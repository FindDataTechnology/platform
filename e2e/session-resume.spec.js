// resume-dsh-session-after-restart (fast project): a dsh child restart — here a
// model switch, the most common restart trigger — must not kill the current
// conversation. Before the fix the next prompt on the same session ended in
// milliseconds with the session-log id-collision error and produced no output.
//
// The fast project runs against the hermetic dead LLM: a turn's terminal error
// is "Connection error." after the runtime's retries (~16s). That error is
// positive proof the turn got as far as the model call — which only happens
// when the session was created or RESUMED successfully, so no assertion here
// can pass on a colliding turn.

import { test, expect } from "@playwright/test";
import { gotoChat, waitForIdle } from "./helpers.js";

test.describe.configure({ timeout: 240_000 });

// Every `error` broadcast the page received, in order. The store renders a
// run-less error as a toast, so the wire is the reliable place to read it.
function collectErrors(page) {
  const errors = [];
  page.on("websocket", (ws) =>
    ws.on("framereceived", (frame) => {
      try {
        const m = JSON.parse(String(frame.payload));
        if (m.type === "error") errors.push(String(m.message));
      } catch {
        /* non-JSON frame */
      }
    }),
  );
  return errors;
}

function userTexts(page) {
  return page.evaluate(() =>
    window.__chatStore
      .getState()
      .turns.filter((t) => t.role === "user")
      .map((t) => t.text),
  );
}

async function send(page, text) {
  const input = page.getByTestId("composer-input");
  await input.fill(text);
  await input.press("Enter");
}

// Run one turn to its terminal error and return that error's message. The turn
// is over the hermetic dead LLM, so the expected terminal error is the model
// connection failure — anything else (an id collision in particular) is the
// behavior under test.
async function turnError(page, errors, text) {
  const before = errors.length;
  await send(page, text);
  await expect.poll(() => errors.length, { timeout: 45_000 }).toBeGreaterThan(before);
  await waitForIdle(page, 30_000);
  const message = errors[errors.length - 1];
  expect(message, `turn "${text}" must reach the model call`).toMatch(/connection error|llm/i);
  expect(message, `turn "${text}" must not be an id collision`).not.toMatch(/id collision/);
  return message;
}

async function switchModel(page) {
  const original = await page.evaluate(() => window.__chatStore.getState().currentModel);
  const target = await page.evaluate(
    (orig) => window.__chatStore.getState().models.find((m) => m.id !== orig)?.id,
    original,
  );
  await page.getByTestId("strip-model").click();
  await page.getByTestId("strip-model-menu").getByRole("menuitemradio").filter({ hasText: target }).click();
  await expect
    .poll(() => page.evaluate(() => window.__chatStore.getState().currentModel), { timeout: 60_000 })
    .toBe(target);
  await waitForIdle(page, 60_000);
  return target;
}

test.describe("session continuity across a dsh child restart", () => {
  test("a prompt after a model-switch restart is not an id collision", async ({ page }) => {
    const errors = collectErrors(page);
    await gotoChat(page);

    // Turn 1 persists this session's log on the dsh side.
    await turnError(page, errors, "first turn");
    expect(await userTexts(page)).toEqual(["first turn"]);

    // The restart: a model switch respawns the dsh child, so the session id
    // now names a persisted log this fresh process has never seen.
    await switchModel(page);

    // The same session must RESUME that log: the prompt is admitted and the
    // turn again reaches the model call.
    await turnError(page, errors, "second turn after the restart");
    expect(await userTexts(page)).toEqual(["first turn", "second turn after the restart"]);

    // And a brand-new conversation after the same restart still creates.
    await page.getByTestId("new-chat-btn").click();
    await turnError(page, errors, "fresh conversation");
    expect(await userTexts(page)).toEqual(["fresh conversation"]);
  });
});
