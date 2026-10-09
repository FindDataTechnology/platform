import { test, expect } from "@playwright/test";
import { gotoChat, waitForIdle } from "./helpers.js";

// @smoke - resume-dsh-session-after-restart: the context-preservation proof.
// Lives in the smoke project (excluded from `npm run test:e2e`, included in
// `npm run test:e2e:smoke`) because it makes REAL model calls, and the fast
// suite's dead LLM can only show that the turn was admitted — not that the
// resumed session still KNOWS what was said before the restart.
//
// The check: tell the agent a code word, restart the dsh child with a
// restart-carrying model switch, then ask for the word back. An answer that
// contains it can only come from the resumed session log; a fresh session, a
// lost context, or the pre-fix id collision all fail it.
//
// Smoke runs need a live-capable model in the roster, which is why the run
// exports the repo's provider store (see playwright.config.js):
//   LLM_PROVIDERS_STORE=./llm-providers.json LLM_DEFAULT_STORE=./llm-default.json
// The switch target comes from the CURRENT model's provider, so the test never
// aims at a route this deployment has no credentials for. The free tier is
// flaky (upstream 503s), so each turn gets one retry; a failure names the
// model's own error text instead of reporting "no output".

test.describe("Session resume (live model)", () => {
  test("@smoke a restarted child keeps the conversation's context", async ({ page }) => {
    test.setTimeout(420_000);
    // Error broadcasts, so a failed turn is reported as itself rather than as
    // a missing answer (a run-less error never opens an assistant turn).
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
    await gotoChat(page);

    const assistantCount = () => page.evaluate(() => window.__chatStore.getState().turns.filter((t) => t.role === "assistant").length);
    const lastAssistant = () =>
      page.evaluate(() => {
        const turns = window.__chatStore.getState().turns;
        const tail = turns.filter((t) => t.role === "assistant").at(-1);
        if (!tail) return { text: "", errors: [] };
        return {
          text: tail.blocks.filter((b) => b.kind === "text").map((b) => b.text).join(""),
          errors: tail.blocks.filter((b) => b.kind === "error").map((b) => b.message),
        };
      });

    const input = page.getByTestId("composer-input");
    const sendOnce = async (text) => {
      const before = await assistantCount();
      const errorsBefore = errors.length;
      await input.fill(text);
      await page.getByTestId("composer-send").click();
      // A NEW assistant turn is the proof this prompt was admitted — waiting on
      // ".last()" alone would read the previous turn and pass it off as the
      // answer (a rejected prompt opens no turn at all).
      await expect
        .poll(assistantCount, { timeout: 60_000 })
        .toBeGreaterThan(before);
      await expect(page.getByTestId("turn-assistant").last()).toHaveAttribute("data-streaming", "false", {
        timeout: 180_000,
      });
      await waitForIdle(page, 60_000);
      const out = await lastAssistant();
      return { ...out, wireErrors: errors.slice(errorsBefore) };
    };
    // One retry for the free tier's intermittent upstream 503s; the retry runs
    // on the SAME session, so it exercises the same code path.
    const send = async (text) => {
      let out = await sendOnce(text);
      if (!out.text.trim()) {
        await page.waitForTimeout(3_000);
        out = await sendOnce(text);
      }
      expect(out.wireErrors, `turn "${text}" failed on the wire`).toEqual([]);
      expect(out.errors, `turn "${text}" ended with an error block`).toEqual([]);
      expect(out.text.trim(), `turn "${text}" produced no output`).not.toBe("");
      return out.text;
    };

    // Turn 1: plant the fact.
    const first = await send("Remember this code word for later: PLUM-42. Reply with only the word: noted");
    expect(first).toBeTruthy();

    // Restart the dsh child: a model switch respawns it, so the session id now
    // names a persisted log this fresh process has never seen. Same provider,
    // so the target is a model this deployment can actually reach.
    const { currentModel, models } = await page.evaluate(() => {
      const s = window.__chatStore.getState();
      return { currentModel: s.currentModel, models: s.models };
    });
    const current = models.find((m) => m.id === currentModel);
    const target =
      models.find((m) => m.id !== currentModel && m.provider === current?.provider)?.id ??
      models.find((m) => m.id !== currentModel)?.id;
    expect(target, "the roster needs a second model to switch to").toBeTruthy();
    await page.getByTestId("strip-model").click();
    await page.getByTestId("strip-model-menu").getByRole("menuitemradio").filter({ hasText: target }).click();
    await expect
      .poll(() => page.evaluate(() => window.__chatStore.getState().currentModel), { timeout: 90_000 })
      .toBe(target);

    // Turn 2 on the SAME session: the answer must carry the planted fact.
    const second = await send("What was the code word I asked you to remember? Reply with only the word.");
    expect(second, "the resumed session lost the pre-restart context").toMatch(/PLUM-42/i);
  });
});
