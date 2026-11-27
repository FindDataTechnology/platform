import { test, expect } from "@playwright/test";
import { pinLocaleEn } from "./helpers.js";

// Agent selection — the unified「与谁对话」picker (simplify-chat-and-agents-ia).
//
// The hermetic e2e server runs with AGENTS_CONFIG_URL="" so no catalog exists
// and the picker never renders on its own. These tests seed the store through
// the e2e seam — the same approach thinking-level.spec.js uses for models — so
// the picker's contract is exercised without depending on a catalog. The
// retired control-strip ⋯ agent section is asserted GONE: persona selection
// has exactly one home.
//
// The contract worth stating: a catalog agent the deployment serves locally (a
// vertical pack is a persona preset) applies through the same restart path as a
// model switch, so the picker marks the switch pending and the composer blocks
// until `agent_changed` lands. This file asserts the client contract only —
// `set_agent` is swallowed before it reaches the runtime.

const LOCAL = { id: "local", name: "Local" };
const REMOTE = { id: "remote-a", name: "Remote A" };

test.describe("Agent selection — unified picker", () => {
  // The socket only opens once the auth check resolves, so the server's own
  // `agents`/`current_agent` reply can land after this page load and clobber a
  // seed applied too early — and the picker renders only for a real choice, so
  // a clobber makes it vanish mid-test. Re-apply until it sticks (the server
  // sends this payload once, so this converges).
  const seed = (page, agents, currentAgent, extra = {}) =>
    expect
      .poll(async () => {
        await page.evaluate(
          ({ agents, currentAgent, extra }) => {
            window.__chatStore.setState({ agents, currentAgent, pendingConfig: null, isStreaming: false, ...extra });
          },
          { agents, currentAgent, extra },
        );
        // Compare IDS, not the length: the server's own `agents` snapshot can
        // land with the same count (it is a two-entry roster here too), and a
        // length-only post-condition accepted that clobber — the persona row
        // then simply did not exist by the time a test asserted it (seen only
        // in a full-suite run, where the socket connects late enough to win the
        // race).
        return page.evaluate(() => window.__chatStore.getState().agents.map((a) => a.id).join(","));
      })
      .toBe(agents.map((a) => a.id).join(","));

  const openPicker = async (page) => {
    await page.getByTestId("agent-preset-picker").click();
    await expect(page.getByTestId("agent-preset-picker-menu")).toBeVisible();
  };

  test.beforeEach(async ({ page }) => {
    await pinLocaleEn(page);
    // Record what the page emits and swallow set_agent so a click never hits
    // the real runtime; these assert the client contract only.
    await page.addInitScript(() => {
      window.__sent = [];
      // Also drop the INBOUND roster frames. Swallowing `set_agent` keeps the
      // runtime out of it, but the server still pushes its own `agents` /
      // `current_agent` snapshots on connect — and that snapshot lands whenever
      // it likes, including after a seed has been verified. Re-seeding cannot
      // win a race that can fire between the poll and the next line; the whole
      // file's contract is CLIENT-side (the picker's shape and its streaming
      // guard), so the roster is noise here and is dropped at the seam.
      const ROSTER_FRAMES = new Set(["agents", "current_agent"]);
      const drop = (data) => {
        try {
          const m = JSON.parse(String(data));
          return Boolean(m && ROSTER_FRAMES.has(m.type));
        } catch {
          return false;
        }
      };
      const desc = Object.getOwnPropertyDescriptor(WebSocket.prototype, "onmessage");
      Object.defineProperty(WebSocket.prototype, "onmessage", {
        configurable: true,
        get() {
          return desc?.get?.call(this) ?? null;
        },
        set(fn) {
          if (typeof fn !== "function") return desc?.set?.call(this, fn);
          const wrapped = function (ev) {
            if (drop(ev?.data)) return;
            return fn.call(this, ev);
          };
          return desc?.set?.call(this, wrapped);
        },
      });
      const origAddEventListener = WebSocket.prototype.addEventListener;
      WebSocket.prototype.addEventListener = function (type, fn, opts) {
        if (type !== "message" || typeof fn !== "function") return origAddEventListener.call(this, type, fn, opts);
        const wrapped = function (ev) {
          if (drop(ev?.data)) return;
          return fn.call(this, ev);
        };
        return origAddEventListener.call(this, type, wrapped, opts);
      };
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

  test("hidden with fewer than two agents, shown with a real choice", async ({ page }) => {
    // The picker renders for the standard composition row alone, so hiding
    // needs an empty preset roster too — and that seed can only stick AFTER
    // the server's own one-shot presets burst lands (a seed applied earlier
    // is clobbered and the picker reappears mid-assert).
    await expect
      .poll(() => page.evaluate(() => window.__chatStore.getState().presets.length))
      .toBeGreaterThan(0);
    await seed(page, [], null, { presets: [], currentPreset: null });
    await expect(page.getByTestId("agent-preset-picker")).toHaveCount(0);

    await seed(page, [LOCAL], "local", { presets: [], currentPreset: null });
    await expect(page.getByTestId("agent-preset-picker")).toHaveCount(0);

    // With personas beyond the default the picker renders even with no
    // composition roster — the personas are the choice.
    await seed(page, [LOCAL, REMOTE], "local", {});
    await expect(page.getByTestId("agent-preset-picker")).toBeVisible();
  });

  test("the strip's overflow no longer carries an agent section", async ({ page }) => {
    await seed(page, [LOCAL, REMOTE], "local");
    await page.getByTestId("strip-more").click();
    await expect(page.getByTestId("strip-agent")).toHaveCount(0);
    await expect(page.getByTestId("strip-agent-option")).toHaveCount(0);
    // The workspace section remains the overflow's content.
    await expect(page.getByTestId("strip-workspace")).toBeVisible();
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
    await expect(page.getByTestId("agent-preset-picker")).toContainText("Remote A");

    await openPicker(page);
    // The platform composition row (standard) may also be present — the
    // contract is that BOTH personas render as agent rows, exactly once each.
    await expect(page.locator('[data-testid="agent-preset-option"][data-preset-id="local"]')).toBeVisible();
    await expect(page.locator('[data-testid="agent-preset-option"][data-preset-id="remote-a"]')).toBeVisible();
    await expect(page.getByRole("menuitemradio", { checked: true })).toContainText("Remote A");
  });

  test("selecting an agent emits set_agent and blocks the composer until agent_changed", async ({ page }) => {
    await seed(page, [LOCAL, REMOTE], "local");

    // Type first: `canSend` also requires non-empty text, so an empty composer
    // would leave send disabled for a reason that has nothing to do with the
    // agent switch and the assertion below would prove nothing.
    await page.getByTestId("composer-input").fill("ready to send");
    await expect(page.getByTestId("composer-send")).toBeEnabled();

    await openPicker(page);
    await page.getByTestId("agent-preset-option").filter({ hasText: "Remote A" }).click();

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
    await openPicker(page);
    await page.getByTestId("agent-preset-option").filter({ hasText: "Remote A" }).click();

    // set_agent was swallowed, so no agent_changed came back — the picker must
    // still show the OLD agent rather than optimistically showing the new one.
    await expect
      .poll(() => page.evaluate(() => window.__chatStore.getState().currentAgent))
      .toBe("local");

    // Once the store reflects the server's broadcast, the label follows.
    await page.evaluate(() => window.__chatStore.getState().apply({ type: "agent_changed", id: "remote-a" }));
    await expect(page.getByTestId("agent-preset-picker")).toContainText("Remote A");
  });

  test("disabled while a turn is streaming", async ({ page }) => {
    await seed(page, [LOCAL, REMOTE], "local");
    await openPicker(page);
    // Re-pin after the menu is open: the snapshot can still land between the
    // seed and the click, and this row's existence is the subject of the test.
    await seed(page, [LOCAL, REMOTE], "local");
    // Persona rows carry the streaming guard (the standard composition row
    // follows the preset contract instead — server-side rejection).
    const personaRow = page.locator('[data-testid="agent-preset-option"][data-preset-id="remote-a"]');
    await expect(personaRow).toBeEnabled();

    await page.evaluate(() => window.__chatStore.setState({ isStreaming: true }));
    await expect(personaRow).toBeDisabled();

    await page.evaluate(() => window.__chatStore.setState({ isStreaming: false }));
    await expect(personaRow).toBeEnabled();
  });
});
