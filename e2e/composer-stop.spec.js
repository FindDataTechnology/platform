// E2E for the composer hardening pass (critique P0s). Covers:
//   - Enter during IME composition must not submit (pinyin confirm)
//   - the stop button releases a stuck stream and swallows the orphaned
//     run's late events until its `done` clears the suppression
//   - a simulated socket drop finalizes the open turn, shows the reconnect
//     banner, and reconnect clears it
//
// All three drive the window.__chatStore seam (e2e build only) — no real LLM
// call is required.

import { test, expect } from "@playwright/test";
import { gotoChat, waitForIdle } from "./helpers.js";

test.describe("composer hardening: IME, stop, disconnect", () => {
  // No new-session click here: `new_session` broadcasts a session_loaded that
  // resets streaming state, and that async broadcast can land mid-test and
  // wipe the synthetic run these tests drive through the store seam. Only the
  // IME test needs a guaranteed fresh session — it clicks new-chat itself and
  // waits out the handshake before driving the composer.
  test.beforeEach(async ({ page }) => {
    await gotoChat(page);
  });

  test("Enter during IME composition does not submit", async ({ page }) => {
    await page.getByTestId("new-chat-btn").click();
    await expect(page.getByTestId("chat-welcome")).toBeVisible({ timeout: 5000 });
    // Let the new-session handshake (session_changed/session_loaded/sessions
    // broadcasts) finish before driving the composer.
    await page.waitForFunction(() => {
      const s = window.__chatStore?.getState();
      return s && s.currentSessionId !== null && s.turns.length === 0;
    });
    const input = page.getByTestId("composer-input");
    await input.fill("你好");

    // Enter that confirms a composition (isComposing: true, the keyCode 229
    // case) must be ignored: no submit, no picker action, draft intact.
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="composer-input"]');
      el.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
          cancelable: true,
          isComposing: true,
        }),
      );
    });

    await expect(input).toHaveValue("你好");
    // No user turn was created — the welcome state survives the composition
    // Enter.
    await expect(page.getByTestId("chat-welcome")).toBeVisible();

    // The same key outside composition submits as before.
    await input.press("Enter");
    await expect(page.getByTestId("chat-welcome")).toBeHidden({ timeout: 15000 });
    await expect(input).toHaveValue("");
    await waitForIdle(page, 30000);
  });

  test("stop button releases a streaming run and swallows its late events", async ({ page }) => {
    await page.evaluate(() => {
      const s = window.__chatStore;
      s.getState().apply({ type: "agent_start" });
      s.getState().apply({ type: "text", delta: "partial answer" });
    });
    // Let the delta flush into the turn (50ms batching) before stopping —
    // text that never rendered is legitimately dropped by the stop.
    await page.waitForFunction(() => {
      const s = window.__chatStore.getState();
      const tail = s.turns[s.turns.length - 1];
      return !!tail && tail.blocks.some((b) => b.kind === "text" && b.text === "partial answer");
    });
    await expect(page.getByTestId("composer-stop")).toBeVisible();
    await expect(page.getByTestId("composer-send")).toBeHidden();

    await page.getByTestId("composer-stop").click();

    // The open turn finalized where it stood; the composer is back.
    await expect(page.getByTestId("composer-send")).toBeVisible({ timeout: 5000 });
    const afterStop = await page.evaluate(() => {
      const s = window.__chatStore.getState();
      const tail = s.turns[s.turns.length - 1];
      return {
        isStreaming: s.isStreaming,
        suppressed: s.suppressed,
        turnCount: s.turns.length,
        tailStreaming: tail?.streaming,
      };
    });
    expect(afterStop).toEqual({
      isStreaming: false,
      suppressed: true,
      turnCount: 1,
      tailStreaming: false,
    });
    // A user stop is a choice — the turn is NOT marked interrupted.
    await expect(page.getByTestId("turn-interrupted")).toBeHidden();

    // The orphaned run keeps streaming server-side — those events must not
    // re-open a turn or re-disable the composer (deltas flush at 50ms).
    await page.evaluate(() => {
      window.__chatStore.getState().apply({ type: "text", delta: " LATE" });
    });
    await page.waitForTimeout(200);
    const afterLate = await page.evaluate(() => {
      const s = window.__chatStore.getState();
      const tail = s.turns[s.turns.length - 1];
      const textBlocks = tail.blocks.filter((b) => b.kind === "text");
      return { turnCount: s.turns.length, tailText: textBlocks.map((b) => b.text).join("") };
    });
    expect(afterLate).toEqual({ turnCount: 1, tailText: "partial answer" });

    // The run's `done` ends the suppression — the next run streams normally.
    await page.evaluate(() => {
      const s = window.__chatStore;
      s.getState().apply({ type: "done" });
      s.getState().apply({ type: "agent_start" });
      s.getState().apply({ type: "text", delta: "next run" });
      s.getState().apply({ type: "done" });
    });
    await page.waitForTimeout(200);
    const next = await page.evaluate(() => {
      const s = window.__chatStore.getState();
      return { suppressed: s.suppressed, turnCount: s.turns.length };
    });
    expect(next).toEqual({ suppressed: false, turnCount: 2 });
  });

  test("disconnect finalizes the stream and the banner explains it", async ({ page }) => {
    await page.evaluate(() => {
      const s = window.__chatStore;
      s.getState().apply({ type: "agent_start" });
      s.getState().apply({ type: "text", delta: "mid-stream" });
    });
    // Flush the delta first so the finalized turn keeps visible text.
    await page.waitForFunction(() => {
      const s = window.__chatStore.getState();
      const tail = s.turns[s.turns.length - 1];
      return !!tail && tail.blocks.some((b) => b.kind === "text" && b.text === "mid-stream");
    });
    await page.evaluate(() => {
      // Simulate the WS onclose path (the hook calls setStatus).
      window.__chatStore.getState().setStatus("disconnected");
    });

    await expect(page.getByTestId("connection-banner")).toBeVisible();
    // Manual retry is offered on the banner (the backoff budget is finite).
    await expect(page.getByTestId("connection-retry")).toBeVisible();
    // Typing survives the outage — only send is gated by the connection.
    await page.getByTestId("composer-input").fill("draft while offline");
    // The stranded run finalized: stop is gone even though no `done` arrived.
    await expect(page.getByTestId("composer-stop")).toBeHidden();
    const state = await page.evaluate(() => {
      const s = window.__chatStore.getState();
      const tail = s.turns[s.turns.length - 1];
      return { isStreaming: s.isStreaming, tailStreaming: tail?.streaming };
    });
    expect(state).toEqual({ isStreaming: false, tailStreaming: false });

    // The cut-off answer is marked in the transcript — a truncation used to
    // be indistinguishable from a finished answer.
    await expect(page.getByTestId("turn-interrupted")).toBeVisible();

    // Late events from the orphaned run stay swallowed after reconnect.
    await page.evaluate(() => {
      window.__chatStore.getState().apply({ type: "text", delta: " LATE" });
    });
    await page.waitForTimeout(200);
    const swallowed = await page.evaluate(() => {
      const s = window.__chatStore.getState();
      const tail = s.turns[s.turns.length - 1];
      return s.turns.length === 1 && !tail.blocks.some((b) => b.kind === "text" && b.text.includes("LATE"));
    });
    expect(swallowed).toBe(true);

    // The offline draft survived the reconnect cycle.
    await expect(page.getByTestId("composer-input")).toHaveValue("draft while offline");
    // Reconnect clears the banner (the hook sets "connected" on open).
    await page.evaluate(() => window.__chatStore.getState().setStatus("connected"));
    await expect(page.getByTestId("connection-banner")).toBeHidden();
    await expect(page.getByTestId("status-text")).toHaveText("Connected");
  });

  test("an orphan error broadcast does not fabricate an assistant turn", async ({ page }) => {
    // Cold-boot scenario: the server sends "Agent is still initializing" (or
    // a concurrent-prompt rejection) with no run in flight. It must surface
    // as a toast, not materialize an empty assistant turn with an error
    // block — the welcome state survives.
    await page.evaluate(() => {
      window.__chatStore.getState().apply({ type: "error", message: "Agent is still initializing" });
    });

    await expect(page.getByTestId("chat-welcome")).toBeVisible();
    await expect(page.getByText("Agent is still initializing")).toBeVisible({ timeout: 3000 });
    const turnCount = await page.evaluate(() => window.__chatStore.getState().turns.length);
    expect(turnCount).toBe(0);

    // During a live run the error still attaches to the open turn.
    await page.evaluate(() => {
      const s = window.__chatStore;
      s.getState().apply({ type: "agent_start" });
      s.getState().apply({ type: "text", delta: "streaming" });
    });
    await page.waitForTimeout(150);
    await page.evaluate(() => {
      window.__chatStore.getState().apply({ type: "error", message: "boom" });
    });
    const inTurn = await page.evaluate(() => {
      const s = window.__chatStore.getState();
      const tail = s.turns[s.turns.length - 1];
      return { turnCount: s.turns.length, hasErrorBlock: tail.blocks.some((b) => b.kind === "error") };
    });
    expect(inTurn).toEqual({ turnCount: 1, hasErrorBlock: true });
  });

  test("drag-drop attaches through the same chip lifecycle as the paperclip", async ({ page }) => {
    // Dropping a file on the composer used to upload silently to the
    // documents collection — no chip, no @doc: reference, only a 1.6s toast.
    // Now both gestures share ONE path: the chip mounts as uploading and
    // settles on attached (or failed) — the upload is never invisible.
    await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.items.add(new File(["drag-drop attach e2e content"], "note.txt", { type: "text/plain" }));
      const el = document.querySelector('[data-testid="composer-input"]');
      el.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
    });
    const chip = page.getByTestId("composer-attachment");
    await expect(chip).toHaveCount(1);
    // Small text file: the uploading state may flash by — the invariant is
    // that the chip EXISTS from the moment of drop and ends attached.
    await expect(chip).toHaveAttribute("data-state", "attached", { timeout: 10000 });
    await expect(chip).toContainText("note.txt");
    await expect(page.getByTestId("composer-attach-count")).toBeVisible();
  });

  test("/help opens the persistent help center (not a vanishing toast)", async ({ page }) => {
    const input = page.getByTestId("composer-input");
    await input.fill("/help");
    // First Enter is consumed by the slash picker (inserts the highlighted
    // pick); the second submits the command — real-user key sequence.
    await input.press("Enter");
    await input.press("Enter");

    const dialog = page.getByTestId("help-dialog");
    await expect(dialog).toBeVisible();
    // The three sections render: commands, skills, shortcuts.
    await expect(dialog.getByRole("heading", { name: "Commands" })).toBeVisible();
    await expect(dialog.getByRole("heading", { name: /Skills \(/ })).toBeVisible();
    await expect(dialog.getByRole("heading", { name: "Shortcuts" })).toBeVisible();
    // Esc closes it (the dialog is persistent, not a 1.6s toast).
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  });

  test("message actions: copy, edit-resend prefill, regenerate", async ({ page }) => {
    // Drive a finished exchange through the store seam.
    await page.evaluate(() => {
      const s = window.__chatStore;
      s.getState().apply({ type: "user", text: "帮我总结要点" });
      s.getState().apply({ type: "agent_start" });
      s.getState().apply({ type: "text", delta: "以下是三个要点。" });
      s.getState().apply({ type: "done" });
    });
    await page.waitForTimeout(300);

    // Copy: flips to the copied state (clipboard needs an explicit grant
    // in headless Chromium; the button swallows a rejected write).
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    const copyBtn = page.getByTestId("turn-copy");
    await expect(copyBtn).toBeVisible();
    await copyBtn.click();
    await expect(copyBtn).toHaveAttribute("data-copied", "true");

    // Edit-and-resend on the LAST user turn prefills the composer.
    await page.getByTestId("turn-edit").click();
    await expect(page.getByTestId("composer-input")).toHaveValue("帮我总结要点");

    // Regenerate re-sends the last user prompt (server echoes a new user turn).
    const before = await page.evaluate(() => window.__chatStore.getState().turns.length);
    await page.getByTestId("turn-regenerate").click();
    await page.waitForFunction(
      (n) => window.__chatStore.getState().turns.length > n,
      before,
      { timeout: 15000 },
    );
    await waitForIdle(page, 30000);
  });

  test("session history restores tool blocks (transcript amnesia fix)", async ({ page }) => {
    // Let the connect-time ready sync settle first (its session_loaded would
    // otherwise race and clobber the synthetic one below).
    await page.waitForFunction(() => {
      const s = window.__chatStore?.getState();
      return s && s.currentSessionId !== null;
    }, null, { timeout: 15000 });
    await page.waitForTimeout(300);
    await page.evaluate(() => {
      window.__chatStore.getState().apply({
        type: "session_loaded",
        id: "test-session",
        messages: [
          { role: "user", content: "查一下数据" },
          {
            role: "assistant",
            content: "查完了。",
            blocks: [
              { kind: "tool", id: "t1", name: "mcp__search__web", args: { q: "x" }, result: "ok", state: "done" },
              { kind: "text", text: "查完了。" },
            ],
          },
        ],
      });
    });
    // The replayed machinery folds into a collapsed activity group; expand
    // it, then the tool name survives the reload behind it.
    const groupHeader = page.locator('[data-testid="activity-group"] > button');
    await expect(groupHeader).toBeVisible();
    await groupHeader.click();
    await expect(page.getByTestId("tool-block")).toBeVisible();
    await expect(page.getByTestId("tool-block")).toHaveAttribute("data-tool-state", "done");
    await expect(page.getByTestId("tool-block")).toContainText("mcp__search__web");
    await expect(page.getByTestId("turn-assistant").last()).toContainText("查完了。");
  });

  test("narrow viewport: nav drawer opens from the header toggle", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByTestId("nav-toggle")).toBeVisible();
    // Composer uses the full width (no 240px rail starve): the input is wide.
    const box = await page.getByTestId("composer-input").boundingBox();
    expect(box?.width ?? 0).toBeGreaterThan(200);
    // Toggle opens the drawer; a nav item navigates and closes it.
    await page.getByTestId("nav-toggle").click();
    // The drawer instance (fixed overlay), not the md+ rail also in the DOM.
    const drawer = page.locator("div.fixed.inset-y-0.left-0 [data-testid=sidebar]");
    await expect(drawer).toBeVisible();
    await drawer.getByTestId("nav-trace").click();
    await expect(page).toHaveURL(/\/trace$/);
    await page.goBack();
    await expect(drawer).toBeHidden();
  });

  test("sessions are deep-linkable: /chat/:id loads that session", async ({ page }) => {
    const id = await page.evaluate(() => {
      const s = window.__chatStore.getState();
      return s.sessions.find((x) => x.id !== s.currentSessionId)?.id || s.sessions[0]?.id || null;
    });
    test.skip(!id, "no sessions to deep-link");
    await page.goto(`/chat/${id}`);
    await page.waitForFunction(
      (want) => window.__chatStore?.getState().currentSessionId === want,
      id,
      { timeout: 15000 },
    );
    await expect(page).toHaveURL(new RegExp("/chat/" + id + "$"));
  });
});
