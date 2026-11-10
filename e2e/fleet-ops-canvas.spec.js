import { test, expect } from "@playwright/test";
import { pinLocaleEn } from "./helpers.js";

// Fleet ops canvas (openspec: add-fleet-ops-canvas):
//   - particle overlay: live turns paint particles along their igniting edge
//     (density ∝ concurrency), ended fades within the decay window, failed red
//   - mini span: hover/selected on a post embeds the turn's tool waterfall
//     (no-tool turns render nothing)
//   - config bar: model pills / effort histogram / budget buckets / traffic
//     heatmap all derive from the cockpit aggregate
//   - bot first-class: bot-kind posts carry the native icon; the inspector
//     shows the bot summary block
// Everything rides stubbed REST + an injected WS lane — same harness as
// e2e/fleets.spec.js, in its own file to keep the suites independent.

const FLEET_ID = "fleet_ops";

function memberFixture(id, over = {}) {
  return {
    id,
    fleetId: FLEET_ID,
    title: over.title ?? id,
    parentId: over.parentId ?? null,
    target: over.target ?? { kind: "persona", id: "p1", label: "甲" },
    kpiSlots: over.kpiSlots ?? [],
    cadence: over.cadence ?? null,
    sortKey: over.sortKey ?? 0,
    createdAt: 0,
    updatedAt: 0,
    taskId: over.taskId ?? null,
    status: over.status ?? "on_duty",
    statusReason: over.statusReason ?? "",
    evidence: over.evidence ?? { lastRunAt: null, nextRunAt: null, staleWindowMs: null, latestReportAt: null, hitWindow: null },
    latestReport: over.latestReport ?? null,
    reportTimeline: over.reportTimeline ?? [],
    lastTurn: over.lastTurn ?? null,
    consecutiveFailures: over.consecutiveFailures ?? 0,
    skippedRounds: over.skippedRounds ?? 0,
    effectiveModel: over.effectiveModel ?? "deepseek-v4.1-flash",
    effort: over.effort ?? null,
    contextBudget: over.contextBudget ?? null,
    latestTurnUsage: over.latestTurnUsage ?? null,
    bot: over.bot ?? null,
  };
}

const OPS_FLEET = {
  fleet: {
    id: FLEET_ID,
    name: "Ops Fleet",
    state: "active",
    orchestration: { mode: "pipeline", edges: [
      { kind: "trigger", to: "ceo", cron: "0 9 * * *" },
      { kind: "handoff", from: "ceo", to: "inv" },
      { kind: "dispatch", from: "ceo", to: "ops" },
    ] },
  },
  members: [
    memberFixture("ceo", { title: "CEO", effort: "high", contextBudget: 50_000, latestTurnUsage: { input: 55_000, output: 5_000 } }),
    memberFixture("inv", { title: "Invest", parentId: "ceo", effectiveModel: "qwen3.8-flash", effort: "low", contextBudget: null }),
    memberFixture("ops", { title: "Ops", parentId: "ceo", effectiveModel: null, effort: null, latestTurnUsage: null }),
    memberFixture("bot1", {
      title: "客服号",
      effectiveModel: null,
      target: { kind: "bot", id: "bot-cockpit", label: "客服号" },
      bot: { type: "feishu", enabled: true, lastInboundAt: "2026-10-27T03:00:00.000Z", lastOutboundAt: null, lastError: null },
    }),
  ],
  statusCounts: { on_duty: 4 },
  orchestration: {
    mode: "pipeline",
    constraints: { maxChainDepth: 4, budgetPerEdgeMin: 10 },
    edges: [
      { kind: "trigger", to: "ceo", cron: "0 9 * * *" },
      { kind: "handoff", from: "ceo", to: "inv" },
      { kind: "dispatch", from: "ceo", to: "ops" },
    ],
  },
  edgeTraffic: [
    { from: "ceo", to: "inv", kind: "handoff", turns: 4, ok: 4, failed: 0 },
    { from: "ceo", to: "ops", kind: "dispatch", turns: 3, ok: 1, failed: 2 },
  ],
};

const TURNS_INV = {
  turns: [
    { id: 7, traceTurnId: "tr_inv_live", status: "failed", source: "delegation", endedAt: Date.now() - 1000, errorKind: "tool_permission" },
  ],
  nextBefore: null,
};

// Production shape: /api/trace/turns parses payloads already — the events
// arrive with OBJECT payloads (a raw JSON string here once masked exactly this
// bug: 2026-10-27 production walkthrough). The first row keeps the raw-string
// form on purpose so MiniSpan's tolerance for both stays pinned.
const TRACE_INV_LIVE = {
  turnId: "tr_inv_live",
  events: [
    { seq: 1, event_type: "tool/call", payload: JSON.stringify({ event: { type: "tool/call", seq: 1, time: Date.now() - 2000, data: { callId: "c1", name: "web_search", arguments: "{}" } } }) },
    { seq: 2, event_type: "tool/result", payload: { event: { type: "tool/result", seq: 2, time: Date.now() - 500, data: { callId: "c1", message: { isError: true, toolCallId: "c1", content: [{ type: "text", text: "denied" }] } } } } },
  ],
};

async function stubCockpit(page, body = OPS_FLEET) {
  await page.route("**/api/fleets", (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify({ fleets: [{ id: FLEET_ID, name: "Ops Fleet", state: "active", memberCount: body.members.length }] }) }),
  );
  await page.route(`**/api/fleets/${FLEET_ID}/cockpit`, (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify(body) }),
  );
  await page.route(`**/api/fleets/${FLEET_ID}/runs**`, (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify({ total: 0, runs: [] }) }),
  );
}

test.describe("fleet ops canvas — particles", () => {
  test("live turns paint particles; failed outcome fades red, ok fades kind-color", async ({ page }) => {
    await pinLocaleEn(page);
    let client = null;
    await page.routeWebSocket(/.*/, (ws) => {
      client = ws;
      const server = ws.connectToServer();
      ws.onMessage((data) => server.send(data));
      server.onMessage((data) => ws.send(data));
    });
    await stubCockpit(page);
    await page.goto(`/fleets/${FLEET_ID}`);
    const canvas = page.getByTestId("fleet-canvas");
    await expect(canvas.getByTestId("canvas-node-ceo")).toBeVisible({ timeout: 15000 });

    // No live turn → no particle layer on the edge.
    await expect(canvas.locator('[data-testid^="edge-particles-ceo→inv:handoff"]')).toHaveCount(0);

    const push = (msg) => client?.send(JSON.stringify(msg));
    const started = (turnId, memberId) => ({
      type: "fleet_turn_started",
      fleetId: FLEET_ID,
      memberId,
      runId: "run_ops",
      turnId,
      parentTurnId: "turn_ceo",
      parentMemberId: "ceo",
      edgeKind: "handoff",
      source: "delegation",
      sessionId: `cron-${memberId}`,
      startedAt: Date.now(),
    });

    // Two concurrent turns on the same edge → two live particles (density).
    push(started("turn_a", "inv"));
    push(started("turn_b", "inv"));
    const particles = canvas.locator('[data-testid="edge-particles-ceo→inv:handoff"]');
    await expect(particles).toBeVisible({ timeout: 5000 });
    await expect(particles.locator("circle.fleet-particle-live")).toHaveCount(2);

    // End one ok (decays in kind color), one failed (decays red).
    const ended = (turnId, status) => ({
      type: "fleet_turn_ended",
      fleetId: FLEET_ID,
      memberId: "inv",
      runId: "run_ops",
      turnId,
      parentTurnId: "turn_ceo",
      parentMemberId: "ceo",
      edgeKind: "handoff",
      source: "delegation",
      sessionId: "cron-inv",
      startedAt: Date.now() - 1500,
      endedAt: Date.now(),
      status,
      errorKind: status === "failed" ? "timeout" : null,
      model: null,
      usage: { input: 10, output: 2 },
    });
    push(ended("turn_a", "ok"));
    push(ended("turn_b", "failed"));
    await expect(particles).toHaveClass(/failing/, { timeout: 5000 });

    // …and the decay window closes the layer even without fresh events.
    await expect(particles).toHaveCount(0, { timeout: 8000 });
  });
});

test.describe("fleet ops canvas — mini span", () => {
  test("hover on a failed post embeds the tool waterfall; a tool-less post shows nothing", async ({ page }) => {
    await pinLocaleEn(page);
    const fp = JSON.parse(JSON.stringify(OPS_FLEET));
    fp.members[1] = memberFixture("inv", { title: "Invest", parentId: "ceo", effectiveModel: "qwen3.8-flash", effort: "low" });
    fp.members[1].lastTurn = { status: "failed", errorKind: "tool_permission", error: "denied", endedAt: Date.now() - 1000, sessionId: "s1" };
    await stubCockpit(page, fp);
    await page.route(`**/api/fleets/${FLEET_ID}/members/inv/turns**`, (route) =>
      route.fulfill({ contentType: "application/json", body: JSON.stringify(TURNS_INV) }),
    );
    await page.route(`**/api/trace/turns/tr_inv_live`, (route) =>
      route.fulfill({ contentType: "application/json", body: JSON.stringify(TRACE_INV_LIVE) }),
    );
    await page.goto(`/fleets/${FLEET_ID}`);
    const canvas = page.getByTestId("fleet-canvas");
    await expect(canvas.getByTestId("canvas-node-inv")).toBeVisible({ timeout: 15000 });

    // Physical hover is unreliable over the minimap overlay — dispatch the
    // synthetic enter the node's handler listens to (IAB 手势命中坑的对策).
    const hover = (id) => canvas.getByTestId(`canvas-node-${id}`).dispatchEvent("mouseover");
    const unhover = (id) => canvas.getByTestId(`canvas-node-${id}`).dispatchEvent("mouseout");

    await hover("inv");
    const span = canvas.getByTestId("canvas-node-inv").locator('[data-testid="mini-span"]');
    await expect(span).toBeVisible({ timeout: 8000 });
    await expect(span.getByTestId("mini-span-tool")).toHaveCount(1);
    await expect(span.locator("text=web_search")).toBeVisible();
    await expect(span.getByTestId("mini-span-source")).toBeVisible();
    // The row-sourced error line renders INTERPOLATED (single-brace "{kind}"
    // shipped once and showed the literal placeholder — production catch).
    await expect(span.getByTestId("mini-span-error")).toContainText("failed: tool_permission");
    await unhover("inv");

    // A tool-less healthy post embeds nothing on hover.
    await hover("ops");
    await expect(canvas.getByTestId("canvas-node-ops").locator('[data-testid="mini-span"]')).toHaveCount(0);
  });
});

test.describe("fleet ops canvas — config bar", () => {
  test("model pills, effort histogram, budget buckets, traffic heatmap all derive from the aggregate", async ({ page }) => {
    await pinLocaleEn(page);
    await stubCockpit(page);
    await page.goto(`/fleets/${FLEET_ID}`);
    const bar = page.getByTestId("fleet-config-bar");
    await expect(bar).toBeVisible({ timeout: 15000 });

    // Models: deepseek ×3 (ceo/ops/bot1 defaults) + qwen ×1 → two pills.
    const pills = bar.getByTestId("config-bar-models").locator("span.rounded-full");
    await expect(pills).toHaveCount(2);
    await expect(pills.filter({ hasText: "deepseek-v4.1-flash" }).first()).toContainText("×3");
    await expect(pills.filter({ hasText: "qwen3.8-flash" }).first()).toContainText("×1");

    // Effort: low ×1, high ×1, unset ×1 (bot1 has no persona effort).
    await expect(bar.getByTestId("config-bar-effort")).toContainText("high ×1");
    await expect(bar.getByTestId("config-bar-effort")).toContainText("low ×1");

    // Budget: 60k/50k = 120% → over bucket ×1; ops has budget but no usage → noData ×1.
    await expect(bar.getByTestId("config-bar-budget-over")).toContainText("×1");

    // Traffic heatmap: chips for the two declared post→post edges only
    // (the cron trigger is not a hop); 4/4 ok reads green, 1/3 reads red.
    const traffic = bar.getByTestId("config-bar-traffic");
    const chips = traffic.locator("span.inline-flex");
    await expect(chips).toHaveCount(2);
  });
});

test.describe("fleet ops canvas — bot first class", () => {
  test("bot node carries the native icon and the inspector shows the bot summary", async ({ page }) => {
    await pinLocaleEn(page);
    await stubCockpit(page);
    await page.goto(`/fleets/${FLEET_ID}`);
    const canvas = page.getByTestId("fleet-canvas");
    await expect(canvas.getByTestId("canvas-node-bot1")).toBeVisible({ timeout: 15000 });
    await expect(canvas.getByTestId("canvas-bot-icon-bot1")).toBeVisible();

    // Inspector: bot summary block + link to /bots.
    await canvas.getByTestId("canvas-node-bot1").click();
    const drawer = page.getByTestId("inspector-bot1");
    await expect(drawer).toBeVisible({ timeout: 8000 });
    await expect(drawer.getByTestId("inspector-bot-summary")).toBeVisible();
    await expect(drawer.getByTestId("inspector-bot-link")).toHaveAttribute("href", "/bots");
  });
});
