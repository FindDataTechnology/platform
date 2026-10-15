import { test, expect } from "@playwright/test";
import { gotoChat } from "./helpers.js";

// Plan progress surfaces (add-plan-progress-panel).
//
// The plan is produced by the MODEL calling dsh's `todo_write` tool, which the
// fast suite never does (no LLM calls). So the UI tests drive the store through
// the e2e build's `window.__chatStore` seam with the exact `todos` message the
// server broadcasts — the same shape `server/dsh-events.js` sends. The
// server-side paths that need no model (connect-time push, new-chat clear) are
// exercised against the real server here; the capture/rehydration logic itself
// is unit-tested in scripts/test-plan-progress.mjs.

const TODOS = [
  { content: "Read the existing spec", status: "completed" },
  { content: "Wire the todo/write event", status: "in_progress" },
  { content: "Render the plan panel", status: "pending" },
];

function countsOf(todos) {
  const counts = { pending: 0, inProgress: 0, completed: 0 };
  for (const todo of todos) {
    if (todo.status === "pending") counts.pending += 1;
    else if (todo.status === "in_progress") counts.inProgress += 1;
    else counts.completed += 1;
  }
  return counts;
}

// Push a `todos` event into the live store, exactly as the WS handler would.
async function applyTodos(page, todos) {
  await page.evaluate(
    ({ todos, counts }) => {
      window.__chatStore.getState().apply({ type: "todos", todos, counts });
    },
    { todos, counts: countsOf(todos) },
  );
}

test.describe("Plan progress", () => {
  test("panel renders the plan with counts and per-status treatments", async ({ page }) => {
    await gotoChat(page);
    await applyTodos(page, TODOS);

    const panel = page.getByTestId("plan-panel");
    await expect(panel).toBeVisible();
    await expect(page.getByTestId("plan-count")).toHaveText("1/3");
    await expect(page.getByTestId("plan-item")).toHaveCount(3);

    // Status treatments: completed is struck through, in-progress carries the
    // emphasis border, pending neither.
    await expect(
      page.locator('[data-testid="plan-item"][data-status="completed"] span').last(),
    ).toHaveClass(/line-through/);
    await expect(
      page.locator('[data-testid="plan-item"][data-status="in_progress"]'),
    ).toHaveClass(/border-l-primary/);

    // The panel sits beside the chat column, not over it. Needs the in-session
    // state (the log only exists once there is a turn to log).
    await page.evaluate(() => {
      window.__chatStore.getState().apply({ type: "user", text: "plan geometry check" });
    });
    const panelBox = await panel.boundingBox();
    const logBox = await page.getByTestId("chat-log").boundingBox();
    expect(panelBox.x).toBeGreaterThanOrEqual(logBox.x + logBox.width - 1);
  });

  test("a later write replaces the list wholesale", async ({ page }) => {
    await gotoChat(page);
    await applyTodos(page, TODOS);
    await expect(page.getByTestId("plan-item")).toHaveCount(3);

    await applyTodos(page, [{ content: "Only this one", status: "pending" }]);

    await expect(page.getByTestId("plan-item")).toHaveCount(1);
    await expect(page.getByTestId("plan-count")).toHaveText("0/1");
    await expect(page.getByTestId("plan-list")).toContainText("Only this one");
    await expect(page.getByTestId("plan-list")).not.toContainText("Render the plan panel");
  });

  test("the plan survives the next turn and the turn's end", async ({ page }) => {
    await gotoChat(page);
    await applyTodos(page, TODOS);

    // A new turn's lifecycle: agent_start → done. Neither may clear the plan
    // (option C: the plan outlives the turn that wrote it).
    await page.evaluate(() => {
      const s = window.__chatStore.getState();
      s.apply({ type: "agent_start" });
      s.apply({ type: "done" });
    });

    await expect(page.getByTestId("plan-panel")).toBeVisible();
    await expect(page.getByTestId("plan-item")).toHaveCount(3);
    await expect(page.getByTestId("plan-count")).toHaveText("1/3");
  });

  test("an empty plan hides the surface entirely", async ({ page }) => {
    await gotoChat(page);
    await applyTodos(page, TODOS);
    await expect(page.getByTestId("plan-panel")).toBeVisible();

    await applyTodos(page, []);

    await expect(page.getByTestId("plan-panel")).toHaveCount(0);
    await expect(page.getByTestId("plan-dock")).toHaveCount(0);
  });

  test("the header control collapses and restores the list", async ({ page }) => {
    await gotoChat(page);
    await applyTodos(page, TODOS);

    await page.getByTestId("plan-collapse").click();
    await expect(page.getByTestId("plan-list")).toHaveCount(0);
    await expect(page.getByTestId("plan-count")).toHaveText("1/3");

    await page.getByTestId("plan-collapse").click();
    await expect(page.getByTestId("plan-list")).toBeVisible();
  });

  test("a loaded session clears the plan", async ({ page }) => {
    await gotoChat(page);
    await applyTodos(page, TODOS);

    // Switching sessions re-renders the transcript from scratch; the plan must
    // not survive into the loaded session (the server pushes the target's own
    // snapshot right after this event).
    await page.evaluate(() => {
      window.__chatStore.getState().apply({ type: "session_loaded", id: "other", messages: [] });
    });

    await expect(page.getByTestId("plan-panel")).toHaveCount(0);
  });

  test("narrow viewports show the composer dock instead of the panel", async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 800 });
    await gotoChat(page);
    await applyTodos(page, TODOS);

    // The panel is mounted but CSS-hidden below lg; the dock takes over.
    await expect(page.getByTestId("plan-panel")).toBeHidden();
    const dock = page.getByTestId("plan-dock");
    await expect(dock).toBeVisible();
    await expect(page.getByTestId("plan-dock-count")).toHaveText("1/3");
    // Zero-count segments are omitted from the summary line.
    await expect(dock).toContainText("1 completed");
    await expect(dock).toContainText("1 in progress");
    await expect(dock).toContainText("1 pending");

    // Expanding lists the items in place and keeps the composer pinned. Scope
    // to the dock: the (CSS-hidden) panel renders its own copy of the list.
    await page.getByTestId("plan-dock-toggle").click();
    await expect(dock.getByTestId("plan-list")).toBeVisible();
    await expect(dock.getByTestId("plan-item")).toHaveCount(3);
    await expect(page.getByTestId("composer-input")).toBeVisible();
    const pageScrolls = await page.evaluate(
      () => document.documentElement.scrollHeight > document.documentElement.clientHeight + 1,
    );
    expect(pageScrolls).toBe(false);
  });

  test("todo_write renders as a summary line, other tools unchanged", async ({ page }) => {
    await gotoChat(page);

    await page.evaluate(() => {
      const s = window.__chatStore.getState();
      s.apply({ type: "agent_start" });
      s.apply({
        type: "tool_start",
        toolCallId: "c1",
        name: "todo_write",
        args: {
          todos: [
            { content: "One", status: "completed" },
            { content: "Two", status: "completed" },
            { content: "Three", status: "pending" },
          ],
        },
      });
      s.apply({ type: "tool_end", toolCallId: "c1", name: "todo_write", result: "ok", isError: false });
      s.apply({ type: "tool_start", toolCallId: "c2", name: "bash", args: { command: "ls" } });
    });

    // The tool blocks live inside the activity group; expand it first.
    await page.evaluate(() => window.__chatStore.getState().toggleAllGroups());

    const planBlock = page.locator('[data-testid="tool-block"][data-tool-name="todo_write"]');
    await expect(planBlock).toContainText("Updated the plan (2/3)");
    // The raw arguments are not in the summary line (they stay behind expand).
    await expect(planBlock).not.toContainText('"status"');
    await expect(planBlock).not.toContainText("todo_write");

    // Every other tool keeps the generic block with its name.
    const bashBlock = page.locator('[data-testid="tool-block"][data-tool-name="bash"]');
    await expect(bashBlock).toContainText("bash");
  });

  test("a connecting client receives the plan snapshot from the server", async ({ page }) => {
    await gotoChat(page);

    // The real server pushes the current session's plan on every connect
    // (empty here — no model has written one). Asserting the message exists
    // and is well-formed is what keeps a fresh page load from rendering a
    // stale plan.
    const message = await page.evaluate(
      () =>
        new Promise((resolve) => {
          const ws = new WebSocket(`ws://${location.host}/`);
          const timer = setTimeout(() => {
            ws.close();
            resolve(null);
          }, 8000);
          ws.onmessage = (e) => {
            const m = JSON.parse(e.data);
            if (m.type === "todos") {
              clearTimeout(timer);
              ws.close();
              resolve(m);
            }
          };
        }),
    );

    expect(message).toEqual({
      type: "todos",
      todos: [],
      counts: { pending: 0, inProgress: 0, completed: 0 },
    });
  });

  test("starting a new chat clears the plan through the real server", async ({ page }) => {
    await gotoChat(page);
    await applyTodos(page, TODOS);
    await expect(page.getByTestId("plan-panel")).toBeVisible();

    // A real new_session: the server broadcasts session_loaded and the empty
    // plan for the fresh session.
    await page.getByTestId("new-chat-btn").click();

    await expect(page.getByTestId("chat-welcome")).toBeVisible({ timeout: 5000 });
    await expect(page.getByTestId("plan-panel")).toHaveCount(0);
  });
});
