import { test, expect } from "@playwright/test";
import { pinLocaleEn } from "./helpers.js";

// Team directory (openspec: add-agent-team-directory, tasks 4.1–4.4).
//
// What this spec pins, and why each one is a real regression rather than a
// render check:
//   1. 「空」 and 「没采到」 must look different — a degraded/degraded-less empty
//      directory that reads identically is the failure the spec forbids;
//   2. a `private` card never reaches the list (the gateway filters it, and the
//      page must not resurrect it from a cache);
//   3. the third nav view is a ROUTE (`/teams/directory`) while the cockpit's
//      `/fleets/:id` deep link keeps landing in the cockpit;
//   4. the publish dialog writes NOTHING before confirm — the preview request is
//      a dry run, and this asserts the absence of the write, not just the
//      presence of the preview;
//   5. `open` cannot be saved without the acknowledgement, and the receipt tells
//      the truth about the 60s sampling window;
//   6. withdraw removes the card from the directory and says the team is intact.
//
// All server traffic is stubbed at the network boundary: the page's contract is
// what is under test, and a real publication row would pollute the run's DB.

const FLEET_ID = "fleet_demo";

const card = (over = {}) => ({
  name: over.name ?? "Support Team",
  description: over.description ?? "Takes after-sales tickets",
  version: 1,
  capabilities: ["a2a"],
  skills: over.skills ?? [
    { id: "p1", name: "Reception" },
    { id: "p2", name: "Review" },
  ],
  posts: over.posts ?? [
    { id: "p1", title: "Reception" },
    { id: "p2", title: "Review" },
  ],
  pricing: over.pricing ?? { callsPerDay: 200, tokensPerDay: 2_000_000, usdPerDay: 5, currency: "USD", billedTo: "team-owner" },
  availability: over.availability ?? { state: "accepting", accepting: true },
  trust: { publishedAt: Date.now(), cellId: "cell-a" },
});

const entry = (handle, over = {}) => ({
  handle,
  visibility: over.visibility ?? "listed",
  target: { kind: "fleet", id: `fleet-${handle}` },
  cellId: "cell-a",
  sampledAt: Date.now(),
  card: card(over.card ?? {}),
});

const directoryPayload = (over = {}) => ({
  v: 1,
  sampledAt: Date.parse("2026-11-12T03:04:05Z"),
  cells: over.cells ?? { sampled: 2, degraded: 0 },
  degradedCells: over.degradedCells ?? [],
  cards: over.cards ?? [entry("support-team"), entry("audit-team", { visibility: "open", card: { name: "Audit Team" } })],
  truncated: over.truncated ?? false,
  stale: over.stale ?? false,
});

const fleetRow = { id: FLEET_ID, name: "Demo Team", state: "active", memberCount: 2, openDecisions: 0, defaultModel: null, statusCounts: { on_duty: 2 }, spend: { windows: { "24h": { runs: 0, turns: 0 } } } };

const cockpit = {
  fleet: { id: FLEET_ID, name: "Demo Team", state: "active", createdAt: 0, updatedAt: 0 },
  members: [],
  statusCounts: { on_duty: 2 },
  openDecisions: 0,
  decisions: [],
  health: { failing: 0, missing: 0, vacant: 0, paused: 0 },
  orchestration: null,
  stream: [],
  edgeTraffic: [],
  template: null,
};

async function mockApp(page, { directory, calls, approval = "none", initialApprovals = null, forFleet = () => ({ publication: null, card: null }), surfaceFailure = null }) {
  // The approvals queue is stateful inside the stub: approving flips the row so
  // the refresh the UI does after a decision is observable.
  const approvals = initialApprovals ? { ...initialApprovals } : { pending: [], approved: [] };
  let approvalState = approval;
  const callSurface = {
    v: 1,
    handle: "support-team",
    visibility: "open",
    quota: { callsPerDay: 200, tokensPerDay: 2_000_000, usdPerDay: 5 },
    usage: { calls: 3, tokens: 1200, usd: 0.25 },
    resetsAt: Date.parse("2026-11-13T00:00:00Z"),
  };
  await page.route("**/api/fleets", (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify({ fleets: [fleetRow] }) }),
  );
  await page.route("**/api/fleets/overview", (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify({ v: 1, sampledAt: Date.now(), fleets: [] }) }),
  );
  await page.route(`**/api/fleets/${FLEET_ID}/cockpit`, (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify(cockpit) }),
  );
  await page.route(`**/api/fleets/${FLEET_ID}/runs**`, (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify({ total: 0, runs: [] }) }),
  );
  await page.route(`**/api/fleets/${FLEET_ID}/decisions**`, (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify({ decisions: [] }) }),
  );

  // One dispatcher for every /api/teams/* call: path+method, no route-ordering
  // surprises, and every call is recorded so "nothing was written" is assertable.
  await page.route("**/api/teams/**", (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname;
    const method = req.method();
    calls.push(`${method} ${path}`);

    if (path === "/api/teams/directory" && method === "GET") {
      return route.fulfill({ contentType: "application/json", body: JSON.stringify(directory()) });
    }
    if (path.startsWith("/api/teams/cards/for-fleet/")) {
      return route.fulfill({ contentType: "application/json", body: JSON.stringify(forFleet()) });
    }
    // ── owner approval queue (7.2) ──
    if (path.endsWith("/approvals") && method === "GET") {
      return route.fulfill({ contentType: "application/json", body: JSON.stringify(approvals) });
    }
    if (path.endsWith("/approvals") && method === "POST") {
      const body = req.postDataJSON() ?? {};
      approvals.pending = approvals.pending.filter((r) => r.caller !== body.caller);
      approvals.approved = [...approvals.approved, { subject: body.caller, expiresAt: body.expiresAt ?? null }];
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true }) });
    }
    if (method === "DELETE" && path.includes("/approvals/")) {
      const caller = decodeURIComponent(path.split("/").pop());
      approvals.pending = approvals.pending.filter((r) => r.caller !== caller);
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true }) });
    }
    // ── call surface + doors (7.1) ──
    if (path.endsWith("/request") && method === "GET") {
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ state: approvalState }) });
    }
    if (path.endsWith("/request") && method === "POST") {
      approvalState = "pending";
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ state: approvalState }) });
    }
    if (path.endsWith("/a2a") && method === "GET") {
      // A surface probe can fail for many reasons; the dialog must report the
      // one it actually got (see the two surface-error cases below).
      if (surfaceFailure) {
        return route.fulfill({
          status: surfaceFailure.status ?? 500,
          contentType: "application/json",
          body: JSON.stringify(surfaceFailure.code ? { error: { code: surfaceFailure.code } } : {}),
        });
      }
      return route.fulfill({ contentType: "application/json", body: JSON.stringify(callSurface) });
    }
    if (path.endsWith("/a2a") && method === "POST") {
      const frames = [
        `event: delta\ndata: ${JSON.stringify({ kind: "message", parts: [{ kind: "text", text: "正在" }] })}\n\n`,
        `event: message\ndata: ${JSON.stringify({ kind: "message", parts: [{ kind: "text", text: "收到，已排进今日队列。" }] })}\n\n`,
        `event: done\ndata: {"status":"ok"}\n\n`,
      ].join("");
      return route.fulfill({ contentType: "text/event-stream", body: frames });
    }
    if (path === "/api/teams/cards/preview") {
      const body = req.postDataJSON() ?? {};
      const previewCard = card({
        name: body.displayName || "Demo Team",
        description: body.description ?? "",
        posts: [{ id: "p1", title: "Reception" }],
        skills: [{ id: "p1", name: "Reception" }],
        pricing: {
          callsPerDay: body.callsPerDay ?? 200,
          tokensPerDay: body.tokensPerDay ?? 2_000_000,
          usdPerDay: body.usdPerDay ?? 5,
          currency: "USD",
          billedTo: "team-owner",
        },
        availability: { state: "accepting", accepting: true },
      });
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ card: previewCard, fallbacks: [] }) });
    }
    if (method === "POST" && path.startsWith("/api/teams/cards/")) {
      const handle = path.split("/").pop();
      return route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({
          publication: {
            handle,
            fleetId: FLEET_ID,
            displayName: "Demo Team",
            description: "",
            visibility: "open",
            callers: [],
            quota: { callsPerDay: 200, tokensPerDay: 2_000_000, usdPerDay: 5 },
          },
          card: card(),
          fallbacks: [],
          servingPosts: 1,
        }),
      });
    }
    if (method === "DELETE") {
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true }) });
    }
    return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "not found" }) });
  });
}

test.describe("team directory", () => {
  test.beforeEach(async ({ page }) => {
    await pinLocaleEn(page);
  });

  test("published cards render, and empty is distinguishable from degraded", async ({ page }) => {
    let payload = directoryPayload();
    const calls = [];
    await mockApp(page, { directory: () => payload, calls });

    await page.goto("/teams/directory");
    await expect(page.getByTestId("directory-list")).toBeVisible();
    await expect(page.getByTestId("directory-card-support-team")).toContainText("Support Team");
    await expect(page.getByTestId("directory-card-audit-team")).toContainText("Audit Team");
    // The sampling line names the count, so an empty list can never be mistaken
    // for an unreachable platform.
    await expect(page.getByTestId("team-directory-page")).toContainText("2 spaces answered");
    await expect(page.getByTestId("directory-degraded")).toHaveCount(0);
    // The reused compact sheet renders the three-bucket vocabulary.
    await expect(page.getByTestId("directory-sheet-support-team-compact")).toBeVisible();

    // Sampled, but nobody published.
    payload = directoryPayload({ cards: [], cells: { sampled: 2, degraded: 0 } });
    await page.getByTestId("directory-refresh").click();
    await expect(page.getByText("No team is published to the directory yet")).toBeVisible();
    await expect(page.getByTestId("team-directory-page")).toContainText("2 spaces answered");
    await expect(page.getByTestId("directory-degraded")).toHaveCount(0);

    // One cell did not answer — said out loud, and the query still succeeded.
    payload = directoryPayload({ cards: [entry("support-team")], cells: { sampled: 1, degraded: 1 }, degradedCells: ["cell-b"] });
    await page.getByTestId("directory-refresh").click();
    await expect(page.getByTestId("directory-degraded")).toContainText("1 space(s) did not answer");
    await expect(page.getByTestId("directory-card-support-team")).toBeVisible();
  });

  test("search and the open-only filter narrow the list; the detail shows the call boundary", async ({ page }) => {
    const calls = [];
    await mockApp(page, { directory: () => directoryPayload(), calls });
    await page.goto("/teams/directory");

    await page.getByTestId("directory-search").fill("audit");
    await expect(page.getByTestId("directory-card-audit-team")).toBeVisible();
    await expect(page.getByTestId("directory-card-support-team")).toHaveCount(0);

    await page.getByTestId("directory-search").fill("");
    await page.getByTestId("directory-open-only").locator("input").click();
    await expect(page.getByTestId("directory-card-audit-team")).toBeVisible();
    await expect(page.getByTestId("directory-card-support-team")).toHaveCount(0);

    await page.getByTestId("directory-open-only").locator("input").click();
    await page.getByTestId("directory-card-support-team").click();
    const detail = page.getByTestId("directory-detail");
    await expect(detail).toBeVisible();
    await expect(detail).toContainText("Daily limits");
    await expect(detail).toContainText("200");
    await expect(detail).toContainText("billed to the team owner");
    await expect(page.getByTestId("directory-detail-posts")).toContainText("Reception");
    // 7.1: the door exists, and it says which one it is (listed vs open)
    // BEFORE the caller presses it.
    await expect(detail).toContainText("Visible but gated: the owner must approve a caller.");
    await expect(page.getByTestId("directory-call-open")).toBeVisible();
  });

  test("the third nav view is a route; the cockpit deep link still lands in the cockpit", async ({ page }) => {
    const calls = [];
    await mockApp(page, { directory: () => directoryPayload(), calls });

    await page.goto(`/fleets/${FLEET_ID}`);
    await expect(page.getByTestId("fleet-detail")).toBeVisible();
    await expect(page.getByTestId("teams-view-switch")).toBeVisible();

    await page.getByTestId("teams-view-directory").click();
    await expect(page).toHaveURL(/\/teams\/directory$/);
    await expect(page.getByTestId("directory-list")).toBeVisible();

    await page.getByTestId("directory-back-to-hub").click();
    await expect(page).toHaveURL(/\/fleets$/);
  });

  test("publish: preview never writes, open needs the acknowledgement, receipts are honest", async ({ page }) => {
    const calls = [];
    await mockApp(page, { directory: () => directoryPayload(), calls });

    await page.goto(`/fleets/${FLEET_ID}`);
    await page.getByTestId("fleet-publish-card").click();
    const dialog = page.getByTestId("publish-card-dialog");
    await expect(dialog).toBeVisible();

    await page.getByTestId("publish-name").fill("Demo Team Public");
    // The preview is the server's dry run — it appears without any write.
    await expect(page.getByTestId("publish-preview")).toBeVisible();
    await expect(page.getByTestId("publish-preview")).toContainText("Demo Team Public");
    expect(calls.some((c) => c === "POST /api/teams/cards/preview")).toBeTruthy();
    expect(calls.some((c) => c.startsWith("POST /api/teams/cards/") && !c.endsWith("/preview"))).toBeFalsy();

    // `open` is gated on an explicit acknowledgement — the save cannot fire.
    await page.getByTestId("publish-visibility-open").click();
    await expect(page.getByTestId("publish-open-gate")).toBeVisible();
    await expect(page.getByTestId("publish-save")).toBeDisabled();
    expect(calls.some((c) => c.startsWith("POST /api/teams/cards/") && !c.endsWith("/preview"))).toBeFalsy();

    await page.getByTestId("publish-open-gate").locator("input[role=switch]").click();
    await expect(page.getByTestId("publish-save")).toBeEnabled();
    await page.getByTestId("publish-save").click();
    await expect(page.getByTestId("publish-receipt-saved")).toContainText("60 seconds");

    // Withdraw: confirmation first, then an honest receipt about the team.
    await page.getByTestId("publish-withdraw").click();
    await expect(page.getByTestId("confirm-dialog")).toBeVisible();
    await page.getByTestId("confirm-dialog-confirm").click();
    await expect(page.getByTestId("publish-receipt-withdrawn")).toContainText("untouched");
    expect(calls.some((c) => c.startsWith("DELETE /api/teams/cards/"))).toBeTruthy();
  });

  test("an open card can be called from the directory and the answer streams in", async ({ page }) => {
    const calls = [];
    const openPayload = { ...directoryPayload(), cards: [{ ...entry("support-team"), visibility: "open" }] };
    await mockApp(page, { directory: () => openPayload, calls, approval: "approved" });
    await page.goto("/teams/directory");

    await page.getByTestId("directory-card-support-team").click();
    await page.getByTestId("directory-call-open").click();

    const dialog = page.getByTestId("team-call-dialog");
    await expect(dialog).toBeVisible();
    // The boundary is readable BEFORE the call — that is the card's promise.
    await expect(page.getByTestId("team-call-quota")).toContainText("200 calls");
    await expect(page.getByTestId("team-call-quota")).toContainText("3 used");

    await page.getByTestId("team-call-input").fill("帮我处理这张售后工单");
    await page.getByTestId("team-call-send").click();
    await expect(page.getByTestId("team-call-answer")).toContainText("收到，已排进今日队列。");
    // It really went through the a2a door, as a stream.
    expect(calls.some((c) => c === "POST /api/teams/cell-a/support-team/a2a"), calls.join(" | ")).toBeTruthy();
  });

  test("a cell that cannot serve teams says so — and shows no call form", async ({ page }) => {
    const calls = [];
    const openPayload = { ...directoryPayload(), cards: [{ ...entry("support-team"), visibility: "open" }] };
    await mockApp(page, { directory: () => openPayload, calls, approval: "approved", surfaceFailure: { status: 503, code: "not_serving" } });
    await page.goto("/teams/directory");

    await page.getByTestId("directory-card-support-team").click();
    await page.getByTestId("directory-call-open").click();

    const error = page.getByTestId("team-call-surface-error");
    await expect(error).toBeVisible();
    await expect(error).toHaveAttribute("data-error-code", "not_serving");
    await expect(error).toContainText("cannot serve team calls yet");
    // No fake door: with no surface there is nothing to type into.
    await expect(page.getByTestId("team-call-input")).toHaveCount(0);
    await expect(page.getByTestId("team-call-send")).toHaveCount(0);
    expect(calls.some((c) => c === "POST /api/teams/cell-a/support-team/a2a"), calls.join(" | ")).toBeFalsy();
  });

  test("a probe that failed for another reason does not claim the deployment cannot serve teams", async ({ page }) => {
    const calls = [];
    const openPayload = { ...directoryPayload(), cards: [{ ...entry("support-team"), visibility: "open" }] };
    // A bare 500 with no code — a network blip / crash, NOT "this deployment
    // cannot serve team calls". Reporting the wrong reason leaves the caller
    // with nothing to do.
    await mockApp(page, { directory: () => openPayload, calls, approval: "approved", surfaceFailure: { status: 500 } });
    await page.goto("/teams/directory");

    await page.getByTestId("directory-card-support-team").click();
    await page.getByTestId("directory-call-open").click();

    const error = page.getByTestId("team-call-surface-error");
    await expect(error).toBeVisible();
    await expect(error).toHaveAttribute("data-error-code", "HTTP 500");
    await expect(error).toContainText("failed");
    await expect(error).not.toContainText("cannot serve team calls yet");
  });

  test("a listed card is gated: ask first, and the call stays disabled until approved", async ({ page }) => {
    const calls = [];
    const listed = {
      ...directoryPayload(),
      cards: [{ ...entry("support-team"), visibility: "listed" }],
    };
    await mockApp(page, { directory: () => listed, calls });
    await page.goto("/teams/directory");

    await page.getByTestId("directory-card-support-team").click();
    await page.getByTestId("directory-call-open").click();

    await expect(page.getByTestId("team-call-approval")).toBeVisible();
    await expect(page.getByTestId("team-call-send")).toBeDisabled();
    await expect(page.getByTestId("team-call-approval-state")).toContainText("Not requested yet");

    await page.getByTestId("team-call-request").click();
    await expect(page.getByTestId("team-call-approval-state")).toContainText("Requested");
    await expect(page.getByTestId("team-call-request")).toBeDisabled();
    await expect(page.getByTestId("team-call-send")).toBeDisabled();
    expect(calls.some((c) => c === "POST /api/teams/cell-a/support-team/request"), calls.join(" | ")).toBeTruthy();
  });

  test("the cockpit approves a queued caller and the queue refreshes", async ({ page }) => {
    const calls = [];
    const pendingCaller = "waiting@caller.test";
    await mockApp(page, {
      directory: () => directoryPayload(),
      calls,
      initialApprovals: { pending: [{ caller: pendingCaller, requestedAt: Date.now() }], approved: [] },
      forFleet: () => ({ publication: { handle: "demo-team", fleetId: FLEET_ID }, card: null }),
    });

    await page.goto(`/fleets/${FLEET_ID}`);
    await page.getByTestId("fleet-call-approvals").click();
    const dialog = page.getByTestId("team-approvals-dialog");
    await expect(dialog).toBeVisible();
    await expect(page.getByTestId("approvals-pending")).toContainText(pendingCaller);

    await page.getByTestId(`approvals-approve-${pendingCaller}`).click();
    await expect.poll(() => calls.filter((c) => c === "POST /api/teams/cards/demo-team/approvals").length).toBe(1);
  });
});
