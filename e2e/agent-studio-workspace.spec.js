// agent-studio-workspace.spec.js — the unified authoring workspace (add-agent-
// builder-workspace batch 1). Rides the shared fast-lane server (auth off: the
// machine owner; email null → the ribbon keeps approver-only gates enabled and
// lets the SERVER answer 403 — the same discipline production uses).
//
// RETIRED 2026-11-08 (add-supply-studio-migration 4.1/4.6): the workspace and
// its /api/blueprints plane moved to the supply domain — this server no longer
// mounts those routes, so every seed below answers 404 and the file is dead
// (verified: the first test fails at seed()). The behaviours (three panes /
// autosave conflict / ribbon / AI draft / fork) now ride the facet host; the
// live walkthrough is their record (tasks.md 5.2/5.3), and the cross-domain
// pins that DO belong to this server live in agents-tabs.spec.js. Kept, and
// skipped, so the intent is not lost; delete when a facet-hosted e2e exists.
//
// The content shapes below are NOT guesses: greenContent() is the minimal
// document that passes the real publish-gate chain (probed against
// server/blueprint-validate.js: one agent + one existing-persona member), and
// the red variants ride the validator's exact entry-less texts ("name must
// be…", "description must be…").
import { test, expect } from "@playwright/test";
import { pinLocaleEn } from "./helpers.js";

const LONG_NAME = "N".repeat(90); // gate: at most 80 chars
const LONG_DESC = "d".repeat(2100); // gate: at most 2000 chars

function greenContent(name) {
  return {
    boundary: { name, oneLine: "A one-line boundary.", outOfScope: "Nothing yet." },
    dataSources: [],
    fleet: {
      name,
      members: [{ ref: "agent-1", title: "Worker", target: { kind: "existing-persona", id: "agent-1" } }],
      orchestration: { pattern: "solo" },
    },
    agents: [{ id: "agent-1", name: "Worker", persona: "I get things done." }],
    mcpServers: [],
    monitoring: {},
    acceptance: [],
    board: {},
  };
}

async function seed(request, content) {
  const r = await request.post("/api/blueprints", { data: { content } });
  expect(r.ok()).toBeTruthy();
  const { blueprint } = await r.json();
  return blueprint;
}

test.describe.skip("agent builder workspace (retired to the supply domain — see header)", () => {
  test.describe.configure({ mode: "serial" });

  test("hub build zone lists recent documents; a row deep-links the workspace on THAT document", async ({ page, request }) => {
    await pinLocaleEn(page);
    const doc = await seed(request, greenContent("Board Alpha"));
    await page.goto("/agents");
    await expect(page.getByTestId("build-section")).toBeVisible({ timeout: 15000 });
    const row = page.getByTestId(`build-doc-${doc.id}`);
    await expect(row).toBeVisible();
    await expect(row).toContainText("Board Alpha");
    await expect(row).toContainText("Draft");
    await row.click();
    await expect(page).toHaveURL(new RegExp(`\\?doc=${doc.id}`));
    await expect(page.getByTestId("ws-ribbon")).toBeVisible();
    await expect(page.getByTestId("ws-doc-name")).toHaveValue("Board Alpha");
  });

  test("the inspector follows the canvas: switching documents re-scopes every finding", async ({ page, request }) => {
    await pinLocaleEn(page);
    const a = await seed(request, { ...greenContent(LONG_NAME) });
    const b = await seed(request, { ...greenContent(LONG_NAME), boundary: { name: LONG_NAME, oneLine: LONG_DESC, outOfScope: "" } });
    await page.goto(`/studio?doc=${a.id}`);
    await expect(page.getByTestId("ws-validation-bad")).toBeVisible({ timeout: 15000 });
    // While A is open, B's description finding must not haunt the inspector —
    // the production-screenshot mismatch (edit one doc, validate another).
    await expect(page.getByTestId("ws-validation-error").filter({ hasText: "description must be" })).toHaveCount(0);
    await page.getByTestId(`ws-library-item-${b.id}`).click();
    await expect(page.getByTestId("ws-doc-name")).toHaveValue(LONG_NAME, { timeout: 15000 });
    await expect(page.getByTestId("ws-validation-error").filter({ hasText: "description must be" })).toBeVisible({ timeout: 15000 });
  });

  test("autosave: debounced single PUT; the content survives a round-trip", async ({ page, request }) => {
    await pinLocaleEn(page);
    const doc = await seed(request, greenContent("Autosave Doc"));
    let puts = 0;
    page.on("request", (r) => {
      if (r.method() === "PUT" && new URL(r.url()).pathname === `/api/blueprints/${doc.id}`) puts += 1;
    });
    await page.goto(`/studio?doc=${doc.id}`);
    await expect(page.getByTestId("ws-save-state")).toContainText(/Saved v\d/, { timeout: 15000 });
    await page.getByTestId("ws-field-oneline").fill("A one-line boundary.");
    await page.getByTestId("ws-field-oneline").pressSequentially(" — typed later.", { delay: 30 });
    await expect(page.getByTestId("ws-save-state")).toContainText(/Saved v\d/, { timeout: 15000 });
    expect(puts).toBeLessThanOrEqual(2); // debounce coalesces ~21 keystrokes
    await page.reload();
    await expect(page.getByTestId("ws-field-oneline")).toHaveValue("A one-line boundary. — typed later.", { timeout: 15000 });
  });

  test("?new=1 mints exactly one document and canonicalizes to ?doc= (reload never re-mints)", async ({ page }) => {
    await pinLocaleEn(page);
    let mints = 0;
    page.on("request", (r) => {
      if (r.method() === "POST" && new URL(r.url()).pathname === "/api/blueprints") mints += 1;
    });
    await page.goto("/studio?new=1");
    await expect(page).toHaveURL(/doc=[a-zA-Z0-9_-]+/, { timeout: 15000 });
    await expect(page.getByTestId("ws-canvas-empty")).toHaveCount(0);
    expect(mints).toBe(1);
    const url = page.url();
    await page.reload();
    expect(page.url()).toBe(url);
    expect(mints).toBe(1);
    await expect(page.getByTestId("ws-doc-status")).toBeVisible({ timeout: 15000 });
  });

  test("ribbon projects the server machine: approve waits for green; trial exists only after a cast", async ({ page, request }) => {
    await pinLocaleEn(page);
    const red = await seed(request, greenContent(LONG_NAME));
    await page.goto(`/studio?doc=${red.id}`);
    await expect(page.getByTestId("ws-ribbon-approve")).toBeDisabled({ timeout: 15000 });
    await expect(page.getByTestId("ws-ribbon-trial")).toHaveCount(0);

    const green = await seed(request, greenContent("Ribbon Green"));
    await page.goto(`/studio?doc=${green.id}`);
    await expect(page.getByTestId("ws-ribbon-approve")).toBeEnabled({ timeout: 15000 });
    await page.getByTestId("ws-ribbon-approve").click();
    await expect(page.getByTestId("ws-doc-status")).toContainText("Approved", { timeout: 15000 });
    // The approved branch's single primary action is cast — never trial
    // (trial requires a pack; the retired UI's "validate→trial→approve" lie).
    await expect(page.getByTestId("ws-ribbon-cast")).toBeEnabled({ timeout: 15000 });
    await expect(page.getByTestId("ws-ribbon-trial")).toHaveCount(0);
  });

  test("a validation error jumps to its field: click lands focus on the name input", async ({ page, request }) => {
    await pinLocaleEn(page);
    const doc = await seed(request, greenContent(LONG_NAME));
    await page.goto(`/studio?doc=${doc.id}`);
    const row = page.getByTestId("ws-validation-error").filter({ hasText: "name must be" });
    await expect(row).toBeVisible({ timeout: 15000 });
    await row.getByLabel("Jump to field").click();
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.getAttribute("data-testid") ?? null), { timeout: 5000 })
      .toBe("ws-doc-name");
  });

  test("409 conflict: banner with both options; keep-mine rides a danger confirm and re-anchors on the server version", async ({ page, request }) => {
    await pinLocaleEn(page);
    const doc = await seed(request, greenContent("Conflict Doc"));

    // Someone else lands a rename first.
    const bump = async (name) => {
      const cur = await (await request.get(`/api/blueprints/${doc.id}`)).json();
      const content = { ...cur.blueprint.content, boundary: { ...cur.blueprint.content.boundary, name } };
      const r = await request.put(`/api/blueprints/${doc.id}`, { data: { expectVersion: cur.blueprint.version, content } });
      expect(r.ok()).toBeTruthy();
    };

    await page.goto(`/studio?doc=${doc.id}`);
    await expect(page.getByTestId("ws-doc-name")).toHaveValue("Conflict Doc", { timeout: 15000 });
    await bump("Renamed Elsewhere 1");
    await page.getByTestId("ws-field-oneline").pressSequentially(" local edit", { delay: 20 });
    await expect(page.getByTestId("ws-conflict-banner")).toBeVisible({ timeout: 15000 });
    await page.getByTestId("ws-conflict-reload").click();
    await expect(page.getByTestId("ws-conflict-banner")).toHaveCount(0);
    await expect(page.getByTestId("ws-doc-name")).toHaveValue("Renamed Elsewhere 1");

    // Keep-mine: destructive → confirm dialog first, then overwrite with the
    // server's NEWEST version (the local edit wins, nothing silent).
    await bump("Renamed Elsewhere 2");
    await page.getByTestId("ws-field-oneline").pressSequentially(" more", { delay: 20 });
    await expect(page.getByTestId("ws-conflict-banner")).toBeVisible({ timeout: 15000 });
    await page.getByTestId("ws-conflict-overwrite").click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Keep mine" }).click();
    await expect(page.getByTestId("ws-conflict-banner")).toHaveCount(0, { timeout: 15000 });
    const after = await (await request.get(`/api/blueprints/${doc.id}`)).json();
    expect(after.blueprint.content.boundary.name).toBe("Renamed Elsewhere 1"); // local content won over "…2"
  });

  test("AI draft overlay: per-field adoption writes ONLY the picked fields; discard writes nothing", async ({ page, request }) => {
    await pinLocaleEn(page);
    const doc = await seed(request, greenContent("AI Draft Doc"));
    let mode = { name: "Drafted Name", description: "Drafted one-liner.", persona: "Drafted persona." };
    await page.route("**/api/studio/draft", (r) => r.fulfill({ json: { draft: mode } }));
    await page.goto(`/studio?doc=${doc.id}`);
    await expect(page.getByTestId("ws-doc-name")).toHaveValue("AI Draft Doc", { timeout: 15000 });

    await page.getByTestId("ws-ai-toggle").click();
    await expect(page.getByTestId("ws-ai-draft")).toBeVisible();
    await page.getByTestId("ws-ai-draft-prompt").fill("a dependable worker");
    await page.getByTestId("ws-ai-draft-run").click();
    await expect(page.getByTestId("ws-ai-draft-review")).toBeVisible({ timeout: 15000 });

    // Nothing picked → adopt-picked is inert (the overlay never silently floods).
    await expect(page.getByTestId("ws-ai-draft-adopt-picked")).toBeDisabled();
    // Pick ONLY persona.
    await page.getByTestId("ws-ai-draft-pick-persona").click();
    await page.getByTestId("ws-ai-draft-adopt-picked").click();
    await expect(page.getByTestId("ws-ai-draft")).toHaveCount(0);
    await expect(page.getByTestId("ws-doc-name")).toHaveValue("AI Draft Doc"); // name NOT written
    await expect(page.getByTestId("ws-field-oneline")).toHaveValue("A one-line boundary."); // description NOT written
    await expect(page.getByTestId("ws-bucket-agent-persona")).toHaveValue("Drafted persona."); // only this

    // Adopt-all is the other side of the same gate: it writes every field.
    mode = { name: "Should Never Land", description: "nope", persona: "nope" };
    await page.getByTestId("ws-ai-toggle").click();
    await page.getByTestId("ws-ai-draft-prompt").fill("again");
    await page.getByTestId("ws-ai-draft-run").click();
    await expect(page.getByTestId("ws-ai-draft-review")).toBeVisible({ timeout: 15000 });
    await page.getByTestId("ws-ai-draft-adopt-all").click();
    await expect(page.getByTestId("ws-doc-name")).toHaveValue("Should Never Land");

    // Discard leaves zero trace.
    await page.getByTestId("ws-ai-toggle").click();
    await page.getByTestId("ws-ai-draft-prompt").fill("one more");
    await page.getByTestId("ws-ai-draft-run").click();
    await expect(page.getByTestId("ws-ai-draft-review")).toBeVisible({ timeout: 15000 });
    const nameBefore = await page.getByTestId("ws-doc-name").inputValue();
    await page.getByTestId("ws-ai-draft-discard").click();
    await expect(page.getByTestId("ws-ai-draft")).toHaveCount(0);
    await expect(page.getByTestId("ws-doc-name")).toHaveValue(nameBefore);
  });

  test("?fork= seeds a new document from a pack and never re-mints on reload; an unreadable seed falls back honestly", async ({ page }) => {
    await pinLocaleEn(page);
    const pack = {
      id: "ws-fork-src",
      version: 2,
      name: "Forked Alpha",
      description: "from pack",
      manifest: {
        name: "Forked Alpha",
        description: "from pack",
        agents: [{ id: "agent-1", name: "Alpha", persona: "cloned persona" }],
        mcpServers: [],
        fleet: { name: "Forked Alpha", members: [] },
      },
    };
    let posts = 0;
    await page.route("**/api/packs/ws-fork-src", (r) => r.fulfill({ json: pack }));
    await page.goto("/studio?fork=ws-fork-src");
    await expect(page).toHaveURL(/doc=[a-zA-Z0-9_-]+/, { timeout: 15000 });
    await expect(page.getByTestId("ws-doc-name")).toHaveValue("Forked Alpha");
    const url = page.url();
    page.on("request", (r) => {
      if (r.method() === "POST" && new URL(r.url()).pathname === "/api/blueprints") posts += 1;
    });
    await page.reload();
    await expect(page).toHaveURL(url); // the seeding URL was replaced; reload opens, never mints
    expect(posts).toBe(0);

    // Unreadable seed: honest toast, canvas asks for a document — no blank editor.
    await page.route("**/api/packs/ghost-404", (r) => r.fulfill({ status: 404, json: { error: "pack version not found" } }));
    await page.goto("/studio?fork=ghost-404");
    await expect(page.getByTestId("toast-v2-host")).toContainText("not readable", { timeout: 15000 });
    await expect(page.getByTestId("ws-canvas-empty")).toBeVisible();
  });

  test("nav retirement: no blueprints entry in the sidebar; the old route redirects into the workspace", async ({ page }) => {
    await pinLocaleEn(page);
    await page.goto("/chat");
    await expect(page.getByTestId("sidebar")).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId("nav-blueprints")).toHaveCount(0);
    await expect(page.getByTestId("nav-agents")).toBeVisible();
    await page.goto("/blueprints");
    await expect(page).toHaveURL(/\/studio\?from=blueprint/, { timeout: 15000 });
    await expect(page.getByTestId("ws-library")).toBeVisible();
  });
});
