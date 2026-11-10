// RETIRED 2026-11-08 (add-supply-studio-migration 4.1/4.6): the workspace and
// its /api/blueprints plane moved to the supply domain — this server no longer
// mounts those routes, so the platform-side authoring surface never renders here
// (verified: the whole group fails at seed/render). Coverage moved to the facet
// host; the live walkthrough is the record (tasks.md 5.2/5.3). Kept, skipped.
// agent-studio-soft-lock.spec.js — 8.3: two tabs on the same document produce
// a NOTICE in both, never a takeover. BroadcastChannel is same-origin and
// available in both pages of one context.
import { test, expect } from "@playwright/test";
import { pinLocaleEn } from "./helpers.js";

const CONTENT = {
  kind: "team",
  boundary: { name: "Soft Lock Doc", oneLine: "two tabs", outOfScope: "" },
  dataSources: [],
  fleet: { name: "Soft Lock Doc", members: [{ ref: "a1", title: "Worker", target: { kind: "existing-persona", id: "a1" } }], orchestration: { pattern: "solo" } },
  agents: [{ id: "a1", name: "Worker", persona: "p" }],
  mcpServers: [],
  monitoring: {},
  acceptance: [],
  board: {},
};

test.skip("8.3 soft lock: the second tab on the same doc raises the notice in both", async ({ page, context, request }) => {
  await pinLocaleEn(page);
  const r = await request.post("/api/blueprints", { data: { content: CONTENT } });
  const { blueprint } = await r.json();

  await page.goto(`/studio?doc=${blueprint.id}`);
  await expect(page.getByTestId("ws-canvas")).toBeVisible({ timeout: 20000 });
  // Nothing yet: the first tab alone has no notice.
  await expect(page.getByTestId("ws-soft-lock-banner")).toHaveCount(0);

  // A second tab announces itself; the first tab (and the second) see the notice.
  const page2 = await context.newPage();
  await page2.goto(`/studio?doc=${blueprint.id}`);
  await expect(page2.getByTestId("ws-soft-lock-banner")).toBeVisible({ timeout: 20000 });
  await expect(page.getByTestId("ws-soft-lock-banner")).toBeVisible({ timeout: 20000 });

  // Dismiss is local to the tab that dismissed — the other tab keeps its notice.
  await page.getByTestId("ws-soft-lock-dismiss").click();
  await expect(page.getByTestId("ws-soft-lock-banner")).toHaveCount(0);
  await expect(page2.getByTestId("ws-soft-lock-banner")).toBeVisible();
  await page2.close();

  // A different document is a different channel — no cross-doc bleed.
  const r2 = await request.post("/api/blueprints", { data: { content: { ...CONTENT, boundary: { name: "Other Doc", oneLine: "x", outOfScope: "" } } } });
  const { blueprint: other } = await r2.json();
  await page.goto(`/studio?doc=${other.id}`);
  await expect(page.getByTestId("ws-canvas")).toBeVisible({ timeout: 20000 });
  await expect(page.getByTestId("ws-soft-lock-banner")).toHaveCount(0);
});
