import { test, expect } from "@playwright/test";
import { gotoChat } from "./helpers.js";

// Tests for the activity group master collapse (chat-activity-collapse) and
// its keyboard shortcut (Ctrl+O / Cmd+O, modified by this change from bare
// thinking-block toggling). The React chat exposes its store on
// `window.__chatStore` for testing, so we drive events straight into the
// reducer instead of a real LLM turn.

// Push a thinking + tool run followed by the answer into the store; the
// machinery folds into ONE activity group, collapsed by default.
async function injectTurnWithActivity(page) {
  await page.evaluate(() => {
    const store = window.__chatStore.getState();
    store.apply({ type: "agent_start" });
    store.apply({ type: "thinking", delta: "reasoning" });
    store.apply({ type: "tool_start", toolCallId: "t1", name: "bash", args: {} });
    store.apply({ type: "tool_end", toolCallId: "t1", name: "bash", result: "ok" });
    store.apply({ type: "text", delta: "the answer" });
    store.apply({ type: "done" });
  });
}

test.describe("activity groups", () => {
  test.beforeEach(async ({ page }) => {
    await gotoChat(page);
  });

  test("a completed turn defaults to a collapsed group with the answer visible", async ({
    page,
  }) => {
    await injectTurnWithActivity(page);
    const group = page.getByTestId("activity-group");
    await expect(group).toHaveCount(1);
    await expect(group).toHaveAttribute("data-open", "false");
    // Nothing from inside the group renders while collapsed.
    await expect(page.getByTestId("thinking-block")).toHaveCount(0);
    await expect(page.getByTestId("tool-block")).toHaveCount(0);
    // The answer text is outside the group and visible without interaction.
    await expect(page.getByTestId("turn-assistant")).toContainText("the answer");
  });

  test("thinking does not stream visibly open", async ({ page }) => {
    await page.evaluate(() => {
      const s = window.__chatStore.getState();
      s.apply({ type: "agent_start" });
      s.apply({ type: "thinking", delta: "reasoning the reader cannot see" });
    });
    const group = page.getByTestId("activity-group");
    await expect(group).toHaveCount(1);
    await expect(group).toHaveAttribute("data-open", "false");
    await expect(page.getByTestId("thinking-block")).toHaveCount(0);
  });

  test("expanding the group reveals thinking content without a second toggle", async ({
    page,
  }) => {
    await injectTurnWithActivity(page);
    await page.locator('[data-testid="activity-group"] > button').click();
    const group = page.getByTestId("activity-group");
    await expect(group).toHaveAttribute("data-open", "true");
    await expect(page.getByTestId("thinking-block")).toHaveAttribute("data-open", "true");
    await expect(page.getByTestId("tool-block")).toHaveCount(1);
  });

  test("the final header summarizes duration and step count, not tool names", async ({
    page,
  }) => {
    await injectTurnWithActivity(page);
    const group = page.getByTestId("activity-group");
    await expect(group).toContainText(/step/i);
    await expect(group).toContainText(/thought/i);
    await expect(group).not.toContainText("bash");
  });

  test("a thinking block the reader is reading stays open when the turn completes", async ({
    page,
  }) => {
    await page.evaluate(() => {
      const s = window.__chatStore.getState();
      s.apply({ type: "agent_start" });
      s.apply({ type: "thinking", delta: "reasoning the reader is reading" });
    });
    // Expand the group mid-stream; the inner thinking block is open by default.
    await page.locator('[data-testid="activity-group"] > button').click();
    const block = page.getByTestId("thinking-block");
    await expect(block).toHaveAttribute("data-open", "true");

    // The reader collapses and reopens it mid-stream; completion must not
    // fold inner blocks (it never touches them anymore).
    await page.evaluate(() => {
      const s = window.__chatStore;
      const asst = s.getState().turns.find((t) => t.role === "assistant");
      s.getState().toggleBlock(asst.id, 0);
      s.getState().toggleBlock(asst.id, 0);
      s.getState().apply({ type: "thinking", delta: " …still reading" });
      s.getState().apply({ type: "done" });
    });
    await expect(block).toHaveAttribute("data-open", "true");
    await expect(page.getByTestId("activity-group")).toHaveAttribute("data-open", "true");
  });

  // Regression: the delta batching buffer used to be two per-kind string
  // slots flushed in a fixed text-before-thinking order. The reasoning→text
  // boundary routinely lands inside one 50ms window, so the reasoning tail
  // rendered AFTER the answer's opening — one thinking pass showed as two
  // blocks sandwiching the text. The buffer is now an ordered segment list;
  // these two tests pin arrival order in both the common and interleaved
  // shapes. All applies run inside one evaluate, so every delta shares a
  // single flush window and the fold via `done` is deterministic.
  test("reasoning followed by the answer renders one thinking block before the text", async ({
    page,
  }) => {
    await page.evaluate(() => {
      const s = window.__chatStore.getState();
      s.apply({ type: "agent_start" });
      s.apply({ type: "thinking", delta: "let me greet them and offer" });
      s.apply({ type: "thinking", delta: " to help with their project." });
      s.apply({ type: "text", delta: "你好！我是编码助手。" });
      s.apply({ type: "done" });
    });
    const blocks = await page.evaluate(() => {
      const t = window.__chatStore.getState().turns.find((x) => x.role === "assistant");
      return t.blocks.map((b) => ({ kind: b.kind, text: b.text }));
    });
    expect(blocks).toEqual([
      { kind: "thinking", text: "let me greet them and offer to help with their project." },
      { kind: "text", text: "你好！我是编码助手。" },
    ]);
  });

  test("interleaved text/thinking deltas keep their arrival order", async ({ page }) => {
    await page.evaluate(() => {
      const s = window.__chatStore.getState();
      s.apply({ type: "agent_start" });
      s.apply({ type: "thinking", delta: "let me greet them and offer to help with" });
      s.apply({ type: "text", delta: "你好！" });
      s.apply({ type: "thinking", delta: " their project." });
      s.apply({ type: "text", delta: "我是编码助手。" });
      s.apply({ type: "done" });
    });
    const blocks = await page.evaluate(() => {
      const t = window.__chatStore.getState().turns.find((x) => x.role === "assistant");
      return t.blocks.map((b) => ({ kind: b.kind, text: b.text }));
    });
    expect(blocks).toEqual([
      { kind: "thinking", text: "let me greet them and offer to help with" },
      { kind: "text", text: "你好！" },
      { kind: "thinking", text: " their project." },
      { kind: "text", text: "我是编码助手。" },
    ]);
  });

  test("an errored tool auto-expands its group during the turn", async ({ page }) => {
    await page.evaluate(() => {
      const s = window.__chatStore.getState();
      s.apply({ type: "agent_start" });
      s.apply({ type: "tool_start", toolCallId: "t1", name: "bash", args: {} });
      s.apply({ type: "tool_end", toolCallId: "t1", name: "bash", result: "boom", isError: true });
      s.apply({ type: "text", delta: "it failed" });
      s.apply({ type: "done" });
    });
    // No user interaction: the failure must already be visible.
    const group = page.getByTestId("activity-group");
    await expect(group).toHaveAttribute("data-open", "true");
    const toolBlock = page.getByTestId("tool-block");
    await expect(toolBlock).toHaveAttribute("data-tool-state", "error");
    await expect(page.getByTestId("turn-assistant")).toContainText("it failed");
  });

  test("an errored tool stays expanded when replayed from history", async ({ page }) => {
    await page.evaluate(() => {
      window.__chatStore.getState().apply({
        type: "session_loaded",
        id: "replayed",
        messages: [
          { role: "user", content: "do it" },
          {
            role: "assistant",
            content: "failed",
            blocks: [
              { kind: "tool", id: "t1", name: "bash", args: {}, result: "boom", state: "error" },
              { kind: "text", text: "failed" },
            ],
          },
        ],
      });
    });
    const group = page.getByTestId("activity-group");
    await expect(group).toHaveAttribute("data-open", "true");
    await expect(page.getByTestId("tool-block")).toHaveAttribute("data-tool-state", "error");
  });

  test("Ctrl+O toggles the activity group", async ({ page }) => {
    await injectTurnWithActivity(page);
    const group = page.getByTestId("activity-group");
    // Completed turn: folded.
    await expect(group).toHaveAttribute("data-open", "false");

    // Focus the chat log so the app-level keydown listener fires reliably.
    await page.getByTestId("chat-log").click();

    await page.keyboard.press("Control+O");
    await expect(group).toHaveAttribute("data-open", "true");

    await page.keyboard.press("Control+O");
    await expect(group).toHaveAttribute("data-open", "false");
  });

  test("Ctrl+O toggles multiple groups at once", async ({ page }) => {
    // Three completed turns, each with one (collapsed) activity group; the
    // middle one flipped open.
    await page.evaluate(() => {
      const s = window.__chatStore;
      for (const word of ["one", "two", "three"]) {
        s.getState().apply({ type: "agent_start" });
        s.getState().apply({ type: "thinking", delta: word });
        s.getState().apply({ type: "done" });
      }
      const asstTurns = s.getState().turns.filter((t) => t.role === "assistant");
      if (asstTurns[1]) s.getState().toggleGroup(asstTurns[1].id, 0);
    });

    const groups = page.getByTestId("activity-group");
    await expect(groups).toHaveCount(3);
    await expect(groups.nth(0)).toHaveAttribute("data-open", "false");
    await expect(groups.nth(1)).toHaveAttribute("data-open", "true");
    await expect(groups.nth(2)).toHaveAttribute("data-open", "false");

    await page.getByTestId("chat-log").click();

    // Any-closed → open all. After first Ctrl+O all should be open.
    await page.keyboard.press("Control+O");
    await expect(groups.nth(0)).toHaveAttribute("data-open", "true");
    await expect(groups.nth(1)).toHaveAttribute("data-open", "true");
    await expect(groups.nth(2)).toHaveAttribute("data-open", "true");

    // Second Ctrl+O: none closed → close all.
    await page.keyboard.press("Control+O");
    await expect(groups.nth(0)).toHaveAttribute("data-open", "false");
    await expect(groups.nth(1)).toHaveAttribute("data-open", "false");
    await expect(groups.nth(2)).toHaveAttribute("data-open", "false");
  });

  test("Ctrl+O drives groups only, leaving inner block states alone", async ({ page }) => {
    await injectTurnWithActivity(page);
    // Expand the group and open the inner tool block.
    await page.locator('[data-testid="activity-group"] > button').click();
    await page.evaluate(() => {
      const s = window.__chatStore;
      const asst = s.getState().turns.find((t) => t.role === "assistant");
      const idxTool = asst.blocks.findIndex((b) => b.kind === "tool");
      s.getState().toggleBlock(asst.id, idxTool);
    });
    const toolBlock = page.getByTestId("tool-block");
    await expect(toolBlock).toHaveAttribute("data-open", "true");

    await page.getByTestId("chat-log").click();
    await page.keyboard.press("Control+O");

    // The open group closes…
    await expect(page.getByTestId("activity-group")).toHaveAttribute("data-open", "false");
    await expect(toolBlock).toHaveCount(0); // collapsed bodies unmount

    // …and on re-expansion the inner tool block kept its open state.
    await page.locator('[data-testid="activity-group"] > button').click();
    await expect(page.getByTestId("tool-block")).toHaveAttribute("data-open", "true");
    await expect(page.getByTestId("thinking-block")).toHaveAttribute("data-open", "true");
  });
});
