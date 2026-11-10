import { test, expect } from "@playwright/test";
import { pinLocaleEn } from "./helpers.js";

// Copilot dock focused preset (openspec: copilot-dock-focused-preset, task 3.3).
//
// The dock asks GET /api/boards/:line/copilot which installed pack is the
// line's focused assistant and puts its agent id on the iframe URL; the embed
// sends ONE `set_agent` once the socket is up and the current agent is known;
// the host restores the main chat's agent when the dock closes. Everything
// below the URL is the client contract: /api/config is patched to open the
// boards switch, the two board routes are mocked, and `set_agent` is captured
// and swallowed in every frame so nothing reaches the hermetic runtime.
// Runtime replies (agent_changed / the rejection's pendingConfig clear) are
// simulated through the e2e store seam, in the frame that would receive them.

const FACET_BOARD = {
  line: "facet",
  title: "谦面",
  originUrl: "https://facet.finddatatech.cloud",
  blocks: [{ id: "overview_metrics", type: "metrics", title: "概览", data: { weeklyActivePacks: 0, totalInstalls: 0 } }],
};
const ASSISTANT = { line: "facet", copilot: { agentId: "facet-assistant", agentName: "谦面助手", packId: "qCEI", packName: "谦面助手" } };
const NO_ASSISTANT = { line: "facet", copilot: null };

const json = (body, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });

async function enableBoards(page) {
  await page.route("**/api/config", async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    body.lineBoardsEnabled = true;
    body.copilotEnabled = true;
    await route.fulfill({ response: res, json: body });
  });
}

// Capture + swallow set_agent in every frame (addInitScript runs per frame).
async function captureSends(page) {
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
}

const sentAgents = (ctx) => ctx.evaluate(() => (window.__sent || []).filter((m) => m.type === "set_agent"));

// The server announces `current_agent` once per socket; a seed applied before
// that lands gets clobbered, so re-apply until it sticks (agent-control.spec).
const seedAgent = (ctx, currentAgent, extra = {}) =>
  expect
    .poll(async () => {
      await ctx.evaluate(
        ({ currentAgent, extra }) => {
          window.__chatStore.setState({ currentAgent, ...extra });
        },
        { currentAgent, extra },
      );
      return ctx.evaluate(() => window.__chatStore.getState().currentAgent);
    })
    .toBe(currentAgent);

const copilotFrame = (page) => page.frames().find((f) => f.url().includes("embed=copilot"));

async function openDockOn(page, copilotBody) {
  await page.route("**/api/boards/facet", (route) => route.fulfill(json(FACET_BOARD)));
  await page.route("**/api/boards/facet/copilot", (route) => route.fulfill(json(copilotBody)));
  await page.goto("/boards/facet");
  await expect(page.getByTestId("board-facet")).toBeVisible({ timeout: 15000 });
  // The host's agent before the dock opens — what a close must restore.
  await seedAgent(page, "local", { pendingConfig: null });
  await page.getByTestId("copilot-fab").click();
  await expect(page.getByTestId("copilot-frame")).toBeVisible({ timeout: 15000 });
  // 15s, like the visibility waits around it: the embed is a same-origin iframe
  // whose document load competes with the harness's mocked API traffic, and a
  // 5s default here reports "no board context" for a frame that is merely slow
  // to commit (the src attribute is already correct — see the market test).
  await expect
    .poll(() => copilotFrame(page)?.url() ?? "", { timeout: 15_000 })
    .toContain("board=facet");
  return copilotFrame(page);
}

test.beforeEach(async ({ page }) => {
  await pinLocaleEn(page);
  await enableBoards(page);
  await captureSends(page);
});

test("focused assistant: URL carries preset, the embed sends set_agent once and reports focused on agent_changed", async ({ page }) => {
  const frame = await openDockOn(page, ASSISTANT);
  expect(frame.url()).toContain("preset=facet-assistant");

  // Connected + current agent known (local) + differs → exactly one set_agent.
  const bar = frame.getByTestId("copilot-context-bar");
  await expect(bar).toBeVisible({ timeout: 15000 });
  await expect(frame.getByTestId("copilot-focus")).toHaveAttribute("data-state", "pending", { timeout: 15000 });
  await expect.poll(() => sentAgents(frame)).toEqual([{ type: "set_agent", id: "facet-assistant" }]);

  // The runtime's agent_changed (simulated): the bar names the preset.
  //
  // Written through `seedAgent`, not a bare setState: with the dock carrying
  // `board=facet` (fix-supply-machine-faces — the market surface used to open
  // context-free), the frame's /api/config reply lands *after* this point and
  // replaces `agents` wholesale, so a one-shot write left the bar naming the
  // preset id (`facet-assistant`) instead of its display name. seedAgent
  // re-applies until the value sticks — the same defence the file's own header
  // documents for `current_agent`.
  await seedAgent(frame, "facet-assistant", {
    agents: [{ id: "local", name: "Local" }, { id: "facet-assistant", name: "谦面助手" }],
    pendingConfig: null,
  });
  await expect(frame.getByTestId("copilot-focus")).toHaveAttribute("data-state", "focused");
  await expect(frame.getByTestId("copilot-focus")).toContainText("谦面助手");
  // Still exactly one switch: a focused embed never re-sends.
  expect(await sentAgents(frame)).toHaveLength(1);
  // Board context sits beside the focus segment and stays clearable.
  await expect(frame.getByTestId("copilot-context-board")).toContainText("facet");
});

test("closing the dock restores the agent the main chat was on", async ({ page }) => {
  await openDockOn(page, ASSISTANT);
  // The broadcast the host would receive after the embed's switch.
  await seedAgent(page, "facet-assistant", { pendingConfig: null });
  await page.getByTestId("copilot-close").click();
  await expect(page.getByTestId("copilot-dock")).toHaveCount(0);
  await expect.poll(() => sentAgents(page)).toEqual([{ type: "set_agent", id: "local" }]);
});

test("a manual switch while the dock is open is kept: close restores nothing", async ({ page }) => {
  await openDockOn(page, ASSISTANT);
  await seedAgent(page, "facet-assistant", { pendingConfig: null });
  // The user picks another agent in the main chat meanwhile.
  await seedAgent(page, "lex-assistant", { pendingConfig: null });
  await page.getByTestId("copilot-close").click();
  await expect(page.getByTestId("copilot-dock")).toHaveCount(0);
  await page.waitForTimeout(300);
  expect(await sentAgents(page)).toEqual([]);
});

test("rejected switch: the bar offers a retry and a retry sends once more", async ({ page }) => {
  const frame = await openDockOn(page, ASSISTANT);
  await expect(frame.getByTestId("copilot-focus")).toHaveAttribute("data-state", "pending", { timeout: 15000 });
  await expect.poll(() => sentAgents(frame)).toHaveLength(1);
  // The runtime's refusal ("Cannot switch agent while the agent is
  // responding"): the store's error branch bumps configErrorSeq and clears
  // pendingConfig, and no agent_changed follows.
  await frame.evaluate(() =>
    window.__chatStore.setState((s) => ({ pendingConfig: null, configErrorSeq: s.configErrorSeq + 1 })),
  );
  await expect(frame.getByTestId("copilot-focus")).toHaveAttribute("data-state", "rejected");
  await frame.getByTestId("copilot-focus-retry").click();
  await expect(frame.getByTestId("copilot-focus")).toHaveAttribute("data-state", "pending");
  await expect.poll(() => sentAgents(frame)).toHaveLength(2);
});

test("no assistant installed: URL has no preset, the embed sends nothing and says unfocused", async ({ page }) => {
  const frame = await openDockOn(page, NO_ASSISTANT);
  expect(frame.url()).not.toContain("preset=");
  await expect(frame.getByTestId("copilot-focus")).toHaveAttribute("data-state", "unfocused", { timeout: 15000 });
  await page.waitForTimeout(300);
  expect(await sentAgents(frame)).toEqual([]);
  // Closing a dock that injected nothing restores nothing.
  await page.getByTestId("copilot-close").click();
  await page.waitForTimeout(300);
  expect(await sentAgents(page)).toEqual([]);
});

// ── Market tab carries the facet line (add-facet-copilot) ────────────────────
// The pack market surface (/packs — the route the dissolved agents hub's Market
// tab became) opens the dock with the facet line: the focused 谦面助手 preset
// rides the URL exactly like the board path, and the inspected pack reaches the
// embed's context bar via the dock's postMessage.

const MARKET_PACK = {
  id: "pack-market-1",
  authorEmail: "creator@e2e.test",
  createdAt: Date.now(),
  publishedAt: Date.now(),
  version: 3,
  name: "市场走查包",
  description: "d",
  tags: [],
  visibility: "public",
  unlisted: false,
};

test("market tab: the dock carries the facet line and the pack context flows into the embed", async ({ page }) => {
  // The gateway plane (browse) + the focused-preset endpoint.
  await page.route("**/api/packs**", (route) =>
    route.fulfill(json({ total: 1, page: 1, pageSize: 50, packs: [MARKET_PACK] })),
  );
  await page.route("**/api/boards/facet/copilot", (route) => route.fulfill(json(ASSISTANT)));
  await page.goto("/packs");
  await expect(page.getByTestId("agent-market-page")).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId("pack-market-guide-hint")).toHaveCount(0); // assistant resolves → no hint

  await seedAgent(page, "local", { pendingConfig: null });
  await page.getByTestId("copilot-fab").click();
  await expect(page.getByTestId("copilot-frame")).toBeVisible({ timeout: 15000 });
  const frame = copilotFrame(page);
  // 30s, not 15: the embed is a same-origin iframe whose document load competes
  // with the harness's own API traffic. Alone the frame commits in ~1s, but in
  // the full 685-test run the server is saturated by other workers and 15s has
  // been observed to elapse before the navigation commits — the src attribute is
  // already correct by then, so a tighter budget reports "no board context" for
  // a frame that is merely queued behind the run's other work.
  await expect.poll(() => frame?.url() ?? "", { timeout: 30_000 }).toContain("board=facet");
  expect(frame.url()).toContain("preset=facet-assistant");
  // The embed applies the focused preset: wait for the app to mount (the bar
  // implies the store is wired), then simulate the runtime's agent_changed.
  const bar = frame.getByTestId("copilot-context-bar");
  await expect(bar).toBeVisible({ timeout: 15000 });
  await seedAgent(frame, "facet-assistant", {
    agents: [{ id: "local", name: "Local" }, { id: "facet-assistant", name: "谦面助手" }],
    pendingConfig: null,
  });
  await expect(frame.getByTestId("copilot-focus")).toHaveAttribute("data-state", "focused", { timeout: 15000 });

  // Open the pack's detail → the inspected pack reaches the context bar.
  await page.getByTestId("pack-card-pack-market-1").click();
  await expect(page.getByTestId("pack-detail")).toBeVisible();
  await expect(frame.getByTestId("copilot-context-pack")).toContainText("市场走查包 v3", { timeout: 15000 });

  // Closing the detail clears the pack context again.
  await page.keyboard.press("Escape");
  await expect(frame.getByTestId("copilot-context-pack")).toHaveCount(0, { timeout: 15000 });
});

test("market tab without the assistant pack: honest hint, no preset", async ({ page }) => {
  await page.route("**/api/packs**", (route) =>
    route.fulfill(json({ total: 0, page: 1, pageSize: 50, packs: [] })),
  );
  await page.route("**/api/boards/facet/copilot", (route) => route.fulfill(json(NO_ASSISTANT)));
  await page.goto("/packs");
  await expect(page.getByTestId("agent-market-page")).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId("pack-market-guide-hint")).toBeVisible({ timeout: 15000 });

  await page.getByTestId("copilot-fab").click();
  await expect(page.getByTestId("copilot-frame")).toBeVisible({ timeout: 15000 });
  const frame = copilotFrame(page);
  // 30s, not 15: the embed is a same-origin iframe whose document load competes
  // with the harness's own API traffic. Alone the frame commits in ~1s, but in
  // the full 685-test run the server is saturated by other workers and 15s has
  // been observed to elapse before the navigation commits — the src attribute is
  // already correct by then, so a tighter budget reports "no board context" for
  // a frame that is merely queued behind the run's other work.
  await expect.poll(() => frame?.url() ?? "", { timeout: 30_000 }).toContain("board=facet");
  expect(frame.url()).not.toContain("preset=");
  await expect(frame.getByTestId("copilot-focus")).toHaveAttribute("data-state", "unfocused", { timeout: 15000 });
});
