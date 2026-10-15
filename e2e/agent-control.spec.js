import { test, expect } from "@playwright/test";
import { pinLocaleEn } from "./helpers.js";

// Agent control in the composer strip.
//
// The hermetic e2e server runs with AGENTS_CONFIG_URL="" so no catalog exists
// and the control never renders on its own. These tests seed the store through
// the e2e seam — the same approach thinking-level.spec.js uses for models — so
// the control's contract is exercised without depending on a catalog.
//
// The contract worth stating: a catalog agent the deployment serves locally (a
// vertical pack is a persona preset) applies through the same restart path as a
// model switch, so the control marks the switch pending and the composer blocks
// until `agent_changed` lands. This file asserts the client contract only —
// `set_agent` is swallowed before it reaches the runtime.

const LOCAL = { id: "local", name: "Local" };
const REMOTE = { id: "remote-a", name: "Remote A" };

test.describe("Agent control — composer strip", () => {
  // The socket only opens once the auth check resolves, so the server's own
  // `agents`/`current_agent` reply can land after this page load and clobber a
  // seed applied too early — and the control renders only for >1 agent, so a
  // clobber makes it vanish mid-test. Re-apply until it sticks (the server
  // sends this payload once, so this converges).
  const seed = (page, agents, currentAgent) =>
    expect
      .poll(async () => {
        await page.evaluate(
          ({ agents, currentAgent }) => {
            window.__chatStore.setState({ agents, currentAgent, pendingConfig: null, isStreaming: false });
          },
          { agents, currentAgent },
        );
        return page.evaluate(() => window.__chatStore.getState().agents.length);
      })
      .toBe(agents.length);

  test.beforeEach(async ({ page }) => {
    await pinLocaleEn(page);
    // Record what the strip emits and swallow set_agent so a click never hits
    // the real runtime; these assert the client contract only.
    await page.addInitScript(() => {
      window.__sent = [];
      const origSend = WebSocket.prototype.send;
      WebSocket.prototype.send = function (data) {
        let parsed;
        try {
          parsed = JSON.parse(data);
        } catch {
          parsed = null;
        }
        if (parsed) window.__sent.push(parsed);
        if (parsed && parsed.type === "set_agent") return;
        return origSend.call(this, data);
      };
    });
    await page.goto("/chat");
    await expect(page.getByTestId("composer-control-strip")).toBeVisible({ timeout: 15000 });
  });

  test("hidden with fewer than two agents, shown with two or more", async ({ page }) => {
    // The agent section lives inside the overflow popover now, so each check
    // opens it first and closes it again with Escape.
    await seed(page, [], null);
    await page.getByTestId("strip-more").click();
    await expect(page.getByTestId("strip-agent")).toHaveCount(0);
    await page.keyboard.press("Escape");

    await seed(page, [LOCAL], "local");
    await page.getByTestId("strip-more").click();
    await expect(page.getByTestId("strip-agent")).toHaveCount(0);
    await page.keyboard.press("Escape");

    await seed(page, [LOCAL, REMOTE], "local");
    await page.getByTestId("strip-more").click();
    await expect(page.getByTestId("strip-agent")).toBeVisible();
  });

  test("orders the two clusters: + and permissions, then model, overflow, send", async ({ page }) => {
    await seed(page, [LOCAL, REMOTE], "local");
    // The permission chip only exists once the roster arrives.
    await expect(page.getByTestId("strip-permission")).toBeVisible();
    const order = await page.evaluate(() => {
      const strip = document.querySelector('[data-testid="composer-control-strip"]');
      return [...strip.querySelectorAll("[data-testid]")]
        .map((el) => el.getAttribute("data-testid"))
        .filter((id) =>
          ["strip-plus", "strip-permission", "strip-model", "strip-more", "composer-send"].includes(id),
        );
    });
    // Left cluster (context) first, then the runtime cluster, with send last.
    expect(order).toEqual(["strip-plus", "strip-permission", "strip-model", "strip-more", "composer-send"]);
  });

  test("displays the active agent's name and marks it in the menu", async ({ page }) => {
    await seed(page, [LOCAL, REMOTE], "remote-a");
    await page.getByTestId("strip-more").click();
    await expect(page.getByTestId("strip-agent")).toContainText("Remote A");

    const options = page.getByTestId("strip-agent-option");
    await expect(options).toHaveCount(2);
    await expect(page.getByRole("menuitemradio", { checked: true })).toContainText("Remote A");
  });

  test("selecting an agent emits set_agent and blocks the composer until agent_changed", async ({ page }) => {
    await seed(page, [LOCAL, REMOTE], "local");

    // Type first: `canSend` also requires non-empty text, so an empty composer
    // would leave send disabled for a reason that has nothing to do with the
    // agent switch and the assertion below would prove nothing.
    await page.getByTestId("composer-input").fill("ready to send");
    await expect(page.getByTestId("composer-send")).toBeEnabled();

    await page.getByTestId("strip-more").click();
    await page.getByTestId("strip-agent-option").filter({ hasText: "Remote A" }).click();

    await expect
      .poll(() => page.evaluate(() => window.__sent.filter((m) => m.type === "set_agent")))
      .toEqual([{ type: "set_agent", id: "remote-a" }]);

    // The switch is a restart-carrying preset change, so the composer blocks
    // until the server's `agent_changed` lands — the same discipline the model
    // and workspace controls follow.
    await expect(page.getByTestId("composer-send")).toBeDisabled();
    await page.evaluate(() => window.__chatStore.getState().apply({ type: "agent_changed", id: "remote-a" }));
    await expect(page.getByTestId("composer-send")).toBeEnabled();
  });

  test("renders store state, not the click — the label follows the broadcast", async ({ page }) => {
    await seed(page, [LOCAL, REMOTE], "local");
    await page.getByTestId("strip-more").click();
    await page.getByTestId("strip-agent-option").filter({ hasText: "Remote A" }).click();

    // set_agent was swallowed, so no agent_changed came back — the control must
    // still show the OLD agent rather than optimistically showing the new one.
    // The switch is pending (it waits for the broadcast), which also disables the
    // overflow trigger, so read the store rather than reopening the popover.
    await expect
      .poll(() => page.evaluate(() => window.__chatStore.getState().currentAgent))
      .toBe("local");

    // Once the store reflects the server's broadcast, the label follows.
    await page.evaluate(() => window.__chatStore.getState().apply({ type: "agent_changed", id: "remote-a" }));
    await page.getByTestId("strip-more").click();
    await expect(page.getByTestId("strip-agent")).toContainText("Remote A");
  });

  test("disabled while a turn is streaming", async ({ page }) => {
    await seed(page, [LOCAL, REMOTE], "local");
    await page.getByTestId("strip-more").click();
    const first = page.getByTestId("strip-agent-option").first();
    await expect(first).toBeEnabled();

    await page.evaluate(() => window.__chatStore.setState({ isStreaming: true }));
    await expect(first).toBeDisabled();

    await page.evaluate(() => window.__chatStore.setState({ isStreaming: false }));
    await expect(first).toBeEnabled();
  });
});
