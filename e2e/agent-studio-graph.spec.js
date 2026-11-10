// RETIRED 2026-11-08 (add-supply-studio-migration 4.1/4.6): the workspace and
// its /api/blueprints plane moved to the supply domain — this server no longer
// mounts those routes, so the platform-side authoring surface never renders here
// (verified: the whole group fails at seed/render). Coverage moved to the facet
// host; the live walkthrough is the record (tasks.md 5.2/5.3). Kept, skipped.
// agent-studio-graph.spec.js — batch 3 (add-agent-builder-workspace 6.x/7.x):
// the writable team graph + the deploy/back-link loop, on the shared fast-lane
// server. The team doc's fleet section is the SAME template vocabulary the
// provisioner consumes, so every leg here rides real validation.
import { test, expect } from "@playwright/test";
import { pinLocaleEn } from "./helpers.js";

const GREEN = (name) => ({
  kind: "team",
  boundary: { name, oneLine: "graph leg", outOfScope: "" },
  dataSources: [],
  fleet: {
    name,
    members: [
      { ref: "watch", title: "Watch", target: { kind: "tool", id: "websearch::web_search" } },
      { ref: "brief", title: "Brief", target: { kind: "existing-persona", id: "agent-1" } },
      { ref: "hub", title: "Hub", target: { kind: "existing-persona", id: "agent-2" } },
    ],
    orchestration: { pattern: "pipeline", edges: [{ kind: "handoff", from: "watch", to: "brief" }] },
  },
  agents: [
    { id: "agent-1", name: "Brief", persona: "p" },
    { id: "agent-2", name: "Hub", persona: "q" },
  ],
  mcpServers: [],
  monitoring: {},
  acceptance: [],
  board: {},
});

async function seed(request, content) {
  const r = await request.post("/api/blueprints", { data: { content } });
  expect(r.ok()).toBeTruthy();
  const { blueprint } = await r.json();
  return blueprint;
}

test.describe.skip("writable team graph (retired to the supply domain — see header)", () => {
  test.describe.configure({ mode: "serial" });

  test("6.1 read mode: the doc's fleet renders through the SHARED canvas, unborn posts", async ({ page, request }) => {
    await pinLocaleEn(page);
    const doc = await seed(request, GREEN("Graph Doc"));
    await page.goto(`/studio?doc=${doc.id}`);
    await expect(page.getByTestId("ws-graph-canvas")).toBeVisible({ timeout: 20000 });
    // Posts render (unborn: paused chip), declared edges exist in the flow.
    // (Node count = 3 members + the canvas's pipeline source node if drawn.)
    await expect(page.locator('[data-testid="ws-graph-canvas"] .react-flow__node')).toHaveCount(3, { timeout: 15000 });
    await expect(page.locator('[data-testid="ws-graph-canvas"] .react-flow__edge')).toHaveCount(1);
    // Design toggle present; no draft affordances yet.
    await expect(page.getByTestId("ws-graph-design")).toBeVisible();
    // Positions live under doc:<id> (6.3) — set one, reload, keep.
    await page.evaluate(() => {
      localStorage.setItem("platform.fleetCanvas.doc:positions-probe", JSON.stringify({ v: 1, p: { watch: { x: 5, y: 6 } } }));
    });
  });

  test("6.2 design mode: draft edge merges on confirm; discard leaves the declaration intact", async ({ page, request }) => {
    await pinLocaleEn(page);
    const doc = await seed(request, GREEN("Design Doc"));
    await page.goto(`/studio?doc=${doc.id}`);
    await expect(page.locator('[data-testid="ws-graph-canvas"] .react-flow__edge')).toHaveCount(1, { timeout: 20000 });
    await page.getByTestId("ws-graph-design").click();

    // Draft a legal straight-line edge brief→hub (the reverse would cycle and
    // is the next test's job).
    const briefHandle = page.locator('[data-id="brief"] .react-flow__handle.source');
    const hubHandle = page.locator('[data-id="hub"] .react-flow__handle.target');
    await expect(briefHandle).toBeVisible();
    await briefHandle.dragTo(hubHandle);
    // The dashed draft edge appears (declared 1 + draft 1).
    await expect(page.locator('[data-testid="ws-graph-canvas"] .react-flow__edge')).toHaveCount(2);

    // Confirm merges into the document: autosave PUT carries orchestration.edges×2.
    const putPromise = page.waitForRequest(
      (r) => r.method() === "PUT" && r.url().includes(`/api/blueprints/${doc.id}`),
      { timeout: 15000 },
    );
    await page.getByTestId("ws-graph-confirm").click();
    await putPromise;
    // waitForRequest only sees the request leave — poll the SERVER's terminal
    // state (the queued-save chain may take one more round-trip).
    const edgesOf = async () => {
      const r = await request.get(`/api/blueprints/${doc.id}`);
      return (await r.json()).blueprint.content.fleet.orchestration.edges.length;
    };
    await expect.poll(edgesOf, { timeout: 15000 }).toBe(2);
    await expect(page.getByTestId("ws-graph-confirm")).toHaveCount(0, { timeout: 15000 }); // design exits

    // Exit-discard equivalence was exercised by NOT confirming another draft.
    await page.getByTestId("ws-graph-design").click();
    await page.getByTestId("ws-graph-discard").click();
    await expect.poll(edgesOf, { timeout: 15000 }).toBe(2);
  });

  test("6.2 rejection: a cycle is refused by the real chain, anchored on the graph card, rollback clean", async ({ page, request }) => {
    await pinLocaleEn(page);
    // watch→brief declared; draft watch→watch… self-loop is refused at connect
    // time by the canvas; instead draft the REVERSE edge brief→watch — a
    // handoff cycle in a pipeline — which the validator refuses.
    const doc = await seed(request, GREEN("Cycle Doc"));
    await page.goto(`/studio?doc=${doc.id}`);
    await expect(page.locator('[data-testid="ws-graph-canvas"] .react-flow__edge')).toHaveCount(1, { timeout: 20000 });
    await page.getByTestId("ws-graph-design").click();
    await page.locator('[data-id="brief"] .react-flow__handle.source').dragTo(page.locator('[data-id="watch"] .react-flow__handle.target'));
    // The cycle passes the PUT (storage闸 doesn't judge orchestration) and is
    // refused by the validation chain that rides the confirm's re-validate —
    // the terminal state is the ROLLED BACK declaration (1 edge) with the
    // rejection anchored on the graph card. The intermediate rejected version
    // (v+1, edges=2) exists for one round-trip — poll past it.
    await page.getByTestId("ws-graph-confirm").click();
    const edgesOf = async () => {
      const r = await request.get(`/api/blueprints/${doc.id}`);
      return (await r.json()).blueprint.content.fleet.orchestration.edges.length;
    };
    await expect.poll(edgesOf, { timeout: 15000 }).toBe(1);
    // The design error is anchored on the graph card (not a toast-only miss).
    await expect(page.getByTestId("ws-graph-design-error")).toBeVisible({ timeout: 10000 });
  });

  test("7.2 cast state surfaces the deploy action; deploying an uninstalled pack fails honestly", async ({ page, request }) => {
    await pinLocaleEn(page);
    const doc = await seed(request, GREEN("Deploy Doc"));
    // The fast lane's facet stub does not implement the publish channel — the
    // cast POST is route-mocked (UI semantics stay real: approve rides the
    // true validation chain); the REAL cast→deploy→back-link leg is the
    // production walkthrough's (task 7.4).
    await page.route(`**/api/blueprints/${doc.id}/cast`, (r) =>
      r.fulfill({ json: {
        blueprint: { ...doc, status: "cast", castPackId: "pk_dbg_deploy", castPackVersion: 1 },
        cast: { packId: "pk_dbg_deploy", version: 1, selfPending: false },
      } }));
    await page.goto(`/studio?doc=${doc.id}`);
    await expect(page.getByTestId("ws-ribbon-approve")).toBeEnabled({ timeout: 20000 });
    await page.getByTestId("ws-ribbon-approve").click();
    await expect(page.getByTestId("ws-doc-status")).toContainText("Approved", { timeout: 15000 });
    await page.getByTestId("ws-ribbon-cast").click();
    await expect(page.getByTestId("ws-doc-status")).toContainText("Cast", { timeout: 20000 });
    // 7.1: the deploy action rides the cast stage.
    await expect(page.getByTestId("ws-deploy-team")).toBeVisible({ timeout: 15000 });
    // The pack is not installed here — the server answers honestly (400) and
    // the failure is a toast, never a silent dead end.
    await page.getByTestId("ws-deploy-team").click();
    await expect(page.getByTestId("toast-v2-host")).toContainText(/not installed|failed/i, { timeout: 20000 });
  });
});
