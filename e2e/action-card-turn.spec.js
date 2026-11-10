import { test, expect } from "@playwright/test";
import { pinLocaleEn } from "./helpers.js";

// Action card inside a REAL assistant turn (copilot-dock-focused-preset
// acceptance follow-up, 2026-10-22). The production model turn exposed two
// defects: the propose_action call rendered as a plain tool block (the card
// matched the bare name `__propose_action`, the wire name is
// `mcp__actions__propose_action`), and even a card would have sat folded under
// the activity header (the collapse exempted a live ask, not a pending
// proposal). This pins the user-visible contract through the store seam:
// while the proposal is pending, the confirmation card with confirm/cancel is
// visible WITHOUT expanding anything; a resolved card folds like other steps.

const turn = (proposalState) => ({
  type: "session_loaded",
  id: "action-card-session",
  messages: [
    { role: "user", content: "把包「谦面助手」改成私有" },
    {
      role: "assistant",
      content: "已提交提案，请确认。",
      blocks: [
        {
          kind: "tool",
          id: "t1",
          name: "mcp__facet-market-mcp__facet_market_pack_read",
          args: { id: "qCEIutJzQd49jnDtV4qeqw" },
          result: JSON.stringify({ id: "qCEIutJzQd49jnDtV4qeqw", visibility: "public" }),
          state: "done",
        },
        {
          kind: "tool",
          id: "t2",
          name: "mcp__actions__propose_action",
          args: { actionId: "facet.pack.visibility", args: { id: "qCEIutJzQd49jnDtV4qeqw", visibility: "private" } },
          // The MCP child's JSON text, exactly as tool_end delivers it.
          result: JSON.stringify({
            proposalId: "p-e2e-1",
            state: proposalState,
            impact: "将包「谦面助手」可见性改为 private",
            risk: "write",
            target: "cloud",
            tier: "inline",
            userFilledArgs: [],
            ...(proposalState === "executed" ? { resultSummary: "visibility=private" } : {}),
          }),
          state: "done",
        },
        { kind: "text", text: "已提交提案，请确认。" },
      ],
    },
  ],
});

test.beforeEach(async ({ page }) => {
  await pinLocaleEn(page);
  await page.goto("/chat");
  await page.waitForFunction(() => {
    const s = window.__chatStore?.getState();
    return s && s.currentSessionId !== null;
  }, null, { timeout: 15000 });
  await page.waitForTimeout(300);
});

test("a pending proposal renders as the confirmation card, visible without expanding the activity group", async ({ page }) => {
  await page.evaluate((t) => window.__chatStore.getState().apply(t), turn("pending"));
  // No click anywhere: the group holding the pending proposal is open.
  await expect(page.getByTestId("action-card-pending")).toBeVisible();
  await expect(page.getByTestId("action-card-pending")).toContainText("谦面助手");
  await expect(page.getByTestId("action-confirm")).toBeVisible();
  await expect(page.getByTestId("action-cancel")).toBeVisible();
  // The proposal is the card, never a generic tool block; the read call beside
  // it stays a plain block.
  await expect(page.locator('[data-testid="tool-block"][data-tool-name="mcp__actions__propose_action"]')).toHaveCount(0);
  await expect(page.locator('[data-testid="tool-block"][data-tool-name="mcp__facet-market-mcp__facet_market_pack_read"]')).toBeVisible();
});

test("a resolved proposal folds with the rest of the activity and replays as the executed face", async ({ page }) => {
  await page.evaluate((t) => window.__chatStore.getState().apply(t), turn("executed"));
  const header = page.locator('[data-testid="activity-group"] > button');
  await expect(header).toBeVisible();
  await expect(page.getByTestId("action-card-executed")).toHaveCount(0);
  await header.click();
  await expect(page.getByTestId("action-card-executed")).toBeVisible();
  await expect(page.getByTestId("action-confirm")).toHaveCount(0);
});

test("a proposal that lands AFTER the card mounted fills it in (in-place block mutation reaches the memoized card)", async ({ page }) => {
  // The live path: tool_start opens a streaming turn with the running call —
  // the group auto-opens and the card mounts with no proposal yet…
  await page.evaluate(() =>
    window.__chatStore.getState().apply({
      type: "tool_start",
      toolCallId: "t2",
      name: "mcp__actions__propose_action",
      args: { actionId: "facet.pack.visibility", args: { id: "qCEIutJzQd49jnDtV4qeqw", visibility: "private" } },
    }),
  );
  await expect(page.getByTestId("action-card-pending")).toBeVisible();
  await expect(page.getByTestId("action-confirm")).toHaveCount(0);
  // …then tool_end mutates that same block object in the store (the turn is
  // cloned, the block is not) and the card must pick the result up.
  await page.evaluate(() =>
    window.__chatStore.getState().apply({
      type: "tool_end",
      toolCallId: "t2",
      name: "mcp__actions__propose_action",
      isError: false,
      result: JSON.stringify({ proposalId: "p-e2e-late", state: "pending", impact: "将包「谦面助手」可见性改为 private", risk: "write", target: "cloud", tier: "inline", userFilledArgs: [] }),
    }),
  );
  await expect(page.getByTestId("action-confirm")).toBeVisible();
  await expect(page.getByTestId("action-cancel")).toBeVisible();
  await expect(page.getByTestId("action-card-pending")).toContainText("谦面助手");
});


// ── Read-only boundary of the market guide (add-facet-copilot 2.2) ──────────
// The embed registers no page-action handler: the ONLY channel for a write is
// the action gate's propose path. A "subscribe this pack" intent inside the
// copilot embed surfaces the pending proposal card — the same turn shape the
// focused preset renders — and never a direct subscription. This pins the
// boundary at the contract level the store seam can see.
test("market guide write intent surfaces the gated proposal card, never a direct action", async ({ page }) => {
  await page.goto("/chat?embed=copilot&board=facet&preset=facet-assistant");
  await page.waitForFunction(() => {
    const s = window.__chatStore?.getState();
    return s && s.currentSessionId !== null;
  }, null, { timeout: 15000 });
  await page.waitForTimeout(300);
  // The assistant "subscribes" by proposing: the pending card with
  // confirm/cancel is the only write affordance in the frame.
  await page.evaluate((t) => window.__chatStore.getState().apply(t), turn("pending"));
  await expect(page.getByTestId("action-card-pending")).toBeVisible();
  await expect(page.getByTestId("action-confirm")).toBeVisible();
  await expect(page.getByTestId("action-cancel")).toBeVisible();
  // And the embed carries no copilot FAB of its own (guest, never host).
  await expect(page.getByTestId("copilot-fab")).toHaveCount(0);
});
