import { test, expect } from "@playwright/test";
import { gotoChat } from "./helpers.js";

// @smoke — resilience-contract UI (add-llm-retry-resilience). This spec needs
// the app's LLM route pointed at the scripted chaos gateway, so it runs via:
//
//   node e2e/chaos-llm.js & \
//   LLM_BASE_URL=http://127.0.0.1:3288/v1 npm run test:e2e:smoke -- e2e/llm-retry.spec.js
//
// (The gateway plays "the model": it re-arms per scenario over its control
// route and answers with the sub2api concurrency rejection — the message that
// defeats message-pattern classification — or two parallel subagent
// delegations, or plain text.)
//
// Asserts:
//   1. Retry chip: a transient gateway rejection shows visible retry progress
//      on the open turn ("retrying (n/N)") and RESOLVES when the retried
//      attempt completes — the turn ends streaming=false with text, no error.
//   2. Subagent failure card: children killed by a fatal (non-retryable)
//      gateway error surface the real reason (code + message) as a Diagnostic
//      line instead of the bare "subagent run failed" headline.

const CHAOS = process.env.CHAOS_LLM_URL || "http://127.0.0.1:3288";
const control = (patch) =>
  fetch(`${CHAOS}/__chaos/control`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  }).then((r) => r.json());

test("@smoke retry chip shows and resolves under gateway chaos", async ({ page }) => {
  await control({ mode: "pass", rejectCount: 2, skip: 0, shape: "sse-error" });

  // Frame-level diagnosis: every server frame mentioning retry is logged, so
  // a missing chip is attributable (events never sent vs never rendered).
  // Registered BEFORE navigation — the app's socket connects at load.
  const retryFrames = [];
  page.on("websocket", (ws) => {
    ws.on("framereceived", (f) => {
      if (String(f.payload).includes("retry")) retryFrames.push(String(f.payload).slice(0, 200));
    });
  });
  await gotoChat(page);

  await page.getByTestId("composer-input").fill("Reply with only the word: ok");
  await page.getByTestId("composer-send").click();

  const turn = page.getByTestId("turn-assistant").last();
  await expect(turn).toBeVisible({ timeout: 30_000 });

  // The retry indication is visible while the request waits in backoff
  // (retry numbers/data are assertions of progress, not decoration).
  const chip = turn.getByTestId("turn-retry");
  await expect(chip).toBeVisible({ timeout: 30_000 }).catch(async (e) => {
    console.log("RETRY FRAMES SEEN:", JSON.stringify(retryFrames, null, 1));
    throw e;
  });
  await expect(chip).toHaveAttribute("data-retry", /\d/);

  // …and resolves: the turn completes with text, no error, no lingering chip.
  await expect(turn).toHaveAttribute("data-streaming", "false", { timeout: 60_000 });
  await expect(turn).toContainText("ok");
  await expect(chip).toHaveCount(0);
  console.log("RETRY FRAMES SEEN:", JSON.stringify(retryFrames, null, 1));
});

test("@smoke subagent failure card carries the child's real end reason", async ({ page }) => {
  // delegate2: the parent's first exchange delegates two parallel subagents.
  // skip=2 spares the auxiliary (title) request and the parent's own call; the
  // two children then die on the fatal invalid-request rejection (rejectKind:
  // "invalid" — INVALID_REQUEST sits outside the retryable set even with the
  // policy on, so no retry saves them; the failure card is the contract under
  // test).
  await control({ mode: "delegate2", rejectCount: 2, skip: 2, shape: "sse-error", rejectKind: "invalid" });
  await gotoChat(page);

  await page.getByTestId("composer-input").fill("Delegate two subagents: one replies one, the other replies two.");
  await page.getByTestId("composer-send").click();

  const turn = page.getByTestId("turn-assistant").last();
  await expect(turn).toBeVisible({ timeout: 30_000 });
  await expect(turn).toHaveAttribute("data-streaming", "false", { timeout: 90_000 });

  // Both failure cards carry the real end reason, not the bare headline.
  await expect(turn.getByText(/subagent run failed/).first()).toBeVisible({ timeout: 10_000 }).catch(async (e) => {
    const served = await (await fetch(`${CHAOS}/__chaos/requests`)).json();
    console.log("CHAOS REQUESTS:", JSON.stringify(served.slice(-8), null, 1));
    console.log("TURN TEXT:", JSON.stringify((await turn.textContent())?.slice(0, 600)));
    throw e;
  });
  await expect(turn.getByText(/Diagnostic: \[INVALID_REQUEST\]/).first()).toBeVisible({ timeout: 10_000 });
  await expect(turn.getByText(/quota frame exceeded/).first()).toBeVisible({ timeout: 10_000 });
});
