import { test, expect } from "@playwright/test";
import { pinLocaleEn } from "./helpers.js";

// Deep-link preset on NORMAL navigation (openspec: simplify-chat-and-agents-ia,
// web-chat-ui「非 embed 导航的预设深链」— the pack-install guidance contract).
//
// Everything below the URL is the client contract: set_agent is captured and
// swallowed in every frame (same technique as copilot-dock.spec), the roster
// and runtime state are seeded through the e2e store seam, and the cluster
// bind POST is mocked so no hermetic runtime dependency exists.
//
// Coverage:
//   1. ?preset=<installed agent> → one set_agent, focused on agent_changed,
//      and the URL param is consumed (cleared) after resolution.
//   2. ?preset=<not-in-roster> → honest "missing" strip, NO set_agent, param
//      still consumed.
//   3. ?preset=…&cluster=<clusterId> → the roster's declared lead wins the
//      switch, and the dynamic-cluster bind fires bound to the session.

const json = (body, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });

// Capture + swallow set_agent in every frame (copilot-dock.spec technique).
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

// The server announces state once per socket; re-apply until it sticks
// (agent-control.spec's seedAgent pattern). NEVER seed `status`: a forged
// "connected" lets the page's switch effect fire into a socket that is not
// open yet — the send is dropped and the effect's once-per-attempt guard
// then blocks the retry forever. Wait for the REAL connection first.
async function seed(ctx, state) {
  await expect(ctx.getByTestId("status-text")).toHaveText("Connected", { timeout: 15000 });
  return expect
    .poll(async () => {
      await ctx.evaluate((state) => window.__chatStore.setState(state), state);
      return ctx.evaluate(
        (keys) => keys.map((k) => window.__chatStore.getState()[k]),
        Object.keys(state),
      );
    })
    .toEqual(Object.values(state));
}

test.beforeEach(async ({ page }) => {
  await pinLocaleEn(page);
  await captureSends(page);
});

test("preset deep link: one set_agent, focused on agent_changed, param consumed", async ({ page }) => {
  await page.goto("/chat?preset=alpha-helper");
  await seed(page, {
    currentAgent: "local",
    currentPreset: "standard",
    pendingConfig: null,
    agents: [
      { id: "local", name: "Local" },
      { id: "alpha-helper", name: "Alpha" },
    ],
  });

  const strip = page.getByTestId("chat-preset-link");
  await expect(strip).toHaveAttribute("data-state", "pending");
  await expect.poll(() => sentAgents(page)).toEqual([{ type: "set_agent", id: "alpha-helper" }]);

  // agent_changed lands: the strip steps aside and the URL param is consumed.
  await page.evaluate(() => {
    window.__chatStore.setState({ currentAgent: "alpha-helper", pendingConfig: null });
  });
  await expect(strip).toHaveCount(0);
  await expect.poll(() => page.url()).not.toContain("preset=");
});

test("preset deep link: uninstalled target degrades honestly, no switch, param consumed", async ({ page }) => {
  await page.goto("/chat?preset=ghost-agent");
  await seed(page, {
    currentAgent: "local",
    currentPreset: "standard",
    pendingConfig: null,
    agents: [{ id: "local", name: "Local" }],
  });

  const strip = page.getByTestId("chat-preset-link");
  await expect(strip).toHaveAttribute("data-state", "missing");
  expect(await sentAgents(page)).toEqual([]);
  await expect.poll(() => page.url()).not.toContain("preset=");
});

test("cluster deep link: roster lead wins the switch and the bind is session-bound", async ({ page }) => {
  const binds = [];
  await page.route("**/api/clusters/dynamic", async (route) => {
    binds.push(route.request().postDataJSON());
    await route.fulfill(json({ ok: true, clusterId: "c1" }));
  });

  await page.goto("/chat?preset=alpha-helper&cluster=pack-x");
  await seed(page, {
    currentAgent: "local",
    currentPreset: "standard",
    pendingConfig: null,
    currentSessionId: "s1",
    agents: [
      { id: "local", name: "Local" },
      { id: "alpha-helper", name: "Alpha", clusterId: "pack-x", packId: "pack-x", clusterName: "投研三镜头" },
      { id: "beta-lead", name: "Beta", clusterId: "pack-x", packId: "pack-x", clusterName: "投研三镜头", isDefaultAgent: true },
    ],
  });

  // The declared lead — not the URL's agent — is the switch target.
  await expect.poll(() => sentAgents(page)).toEqual([{ type: "set_agent", id: "beta-lead" }]);
  // The dynamic-cluster bind is session-bound with the roster group.
  await expect.poll(() => binds).toEqual([
    {
      name: "投研三镜头",
      agents: [
        { packId: "pack-x", agentId: "alpha-helper" },
        { packId: "pack-x", agentId: "beta-lead" },
      ],
      bindToSession: true,
      sessionId: "s1",
    },
  ]);
  await expect.poll(() => page.url()).not.toContain("cluster=");
});
