// RETIRED 2026-11-08 (add-supply-studio-migration 4.1/4.6): the workspace and
// its /api/blueprints plane moved to the supply domain — this server no longer
// mounts those routes, so the platform-side authoring surface never renders here
// (verified: the whole group fails at seed/render). Coverage moved to the facet
// host; the live walkthrough is the record (tasks.md 5.2/5.3). Kept, skipped.
// agent-studio-kind.spec.js — batch 2 (add-agent-builder-workspace 4.1-4.4,
// 5.1-5.2): the unified object model's second shape. Rides the shared fast-lane
// server (auth off = machine owner), same as agent-studio-workspace.spec.js.
import { test, expect } from "@playwright/test";
import { pinLocaleEn } from "./helpers.js";

const LONG_NAME = "N".repeat(90); // gate: at most 80 chars

function agentGreen(name = "Contract Reader") {
  return {
    kind: "agent",
    name,
    description: "Reads a contract into one page of points.",
    agents: [{ id: "agent-1", name: "Reader", persona: "You turn contracts into one page." }],
    mcpServers: [],
    skills: [],
  };
}

test.describe.skip("agent-kind documents (retired to the supply domain — see header)", () => {
  test.describe.configure({ mode: "serial" });

  test("?new=agent mints one agent document: one click, name focused, no team sections", async ({ page }) => {
    await pinLocaleEn(page);
    let mints = 0;
    page.on("request", (r) => {
      if (r.method() === "POST" && new URL(r.url()).pathname === "/api/blueprints") mints += 1;
    });
    await page.goto("/studio?new=agent");
    await expect(page).toHaveURL(/doc=[a-zA-Z0-9_-]+/, { timeout: 15000 });
    expect(mints).toBe(1);
    // Kind badge + no team lifecycle ribbon (agent docs have no cast lane).
    await expect(page.getByTestId("ws-doc-kind")).toContainText("Agent");
    await expect(page.getByTestId("ws-ribbon")).toHaveCount(0);
    await expect(page.getByTestId("ws-agent-draft-card")).toBeVisible();
    // Team-only sections are absent.
    await expect(page.getByTestId("ws-graph")).toHaveCount(0);
    await expect(page.getByTestId("ws-judge")).toHaveCount(0);
    await expect(page.getByTestId("ws-sources")).toHaveCount(0);
    await expect(page.getByTestId("ws-field-oos")).toHaveCount(0);
    // One-click create: the name field already holds focus.
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.getAttribute("data-testid") ?? null), { timeout: 5000 })
      .toBe("ws-doc-name");
  });

  test("skills bucket is editable and survives autosave (4.3)", async ({ page, request }) => {
    await pinLocaleEn(page);
    const created = await request.post("/api/blueprints", { data: { kind: "agent", content: agentGreen("Skills Doc") } });
    const { blueprint } = await created.json();
    await page.goto(`/studio?doc=${blueprint.id}`);
    await expect(page.getByTestId("ws-bucket-skills")).toBeVisible({ timeout: 15000 });
    await page.getByTestId("ws-bucket-skill-add").click();
    await expect(page.getByTestId("ws-bucket-skills").locator("input").first()).toBeVisible();
    const skillName = `skill-${Date.now().toString(36)}`;
    await page.getByTestId("ws-bucket-skills").locator("input").first().fill(skillName);
    await page.getByTestId("ws-bucket-skills").locator("textarea").first().fill("# Body\nDoes things.");
    await expect(page.getByTestId("ws-save-state")).toContainText(/Saved v\d/, { timeout: 15000 });
    // The document on the SERVER carries the skill (not dropped at save).
    const read = await (await request.get(`/api/blueprints/${blueprint.id}`)).json();
    expect(read.blueprint.content.skills.map((s) => s.name)).toContain(skillName);
  });

  test("agent documents: approve/cast are server-side 409, validate stays available", async ({ request }) => {
    const created = await request.post("/api/blueprints", { data: { kind: "agent", content: agentGreen("Gate Doc") } });
    const { blueprint } = await created.json();
    // The gate is the server's, not the UI's.
    for (const [path, body] of [["/approve", { expectVersion: blueprint.version }], ["/cast", {}], ["/trial", {}]]) {
      const r = await request.post(`/api/blueprints/${blueprint.id}${path}`, { data: body });
      expect(r.status(), `${path} must 409`).toBe(409);
      expect((await r.json()).kind).toBe("agent");
    }
    const v = await request.post(`/api/blueprints/${blueprint.id}/validate`);
    expect(v.status()).toBe(200);
    expect((await v.json()).ok).toBe(true);
  });

  test("kind is fixed at creation; the list projects it; team documents keep their ribbon", async ({ page, request }) => {
    await pinLocaleEn(page);
    const created = await request.post("/api/blueprints", { data: { kind: "agent", content: agentGreen("Fixed Kind") } });
    const { blueprint } = await created.json();
    const flip = await request.put(`/api/blueprints/${blueprint.id}`, {
      data: { expectVersion: blueprint.version, content: { ...blueprint.content, kind: "team" } },
    });
    expect(flip.status()).toBe(400);

    const list = await (await request.get("/api/blueprints")).json();
    const mine = list.blueprints.find((b) => b.id === blueprint.id);
    expect(mine.kind).toBe("agent");

    // The library marks the kind badge for both kinds, one list.
    await page.goto(`/studio?doc=${blueprint.id}`);
    await expect(page.getByTestId(`ws-library-kind-${blueprint.id}`)).toContainText("Agent", { timeout: 15000 });
  });

  test("error findings carry a stable code and a localized summary above the raw text (5.1/5.2)", async ({ page, request }) => {
    await pinLocaleEn(page);
    const created = await request.post("/api/blueprints", { data: { kind: "agent", content: agentGreen(LONG_NAME) } });
    const { blueprint } = await created.json();
    // Server half: the finding carries the code, the raw text is verbatim.
    const verdict = await (await request.post(`/api/blueprints/${blueprint.id}/validate`)).json();
    const nameFinding = verdict.errors.find((e) => /^name must be/.test(e.error));
    expect(nameFinding.code).toBe("name_too_long");
    expect(nameFinding.error).toBe("name must be a non-empty string of at most 80 characters");

    // Client half: summary + jump + raw all visible in one row.
    await page.goto(`/studio?doc=${blueprint.id}`);
    const row = page.getByTestId("ws-validation-error").filter({ hasText: "name must be" });
    await expect(row).toBeVisible({ timeout: 15000 });
    await expect(row).toHaveAttribute("data-code", "name_too_long");
    // The localized one-line summary sits above the verbatim server text.
    await expect(row).toContainText("The name must be non-empty and at most 80 characters");
    await expect(row).toContainText("name must be a non-empty string of at most 80 characters");
    // Jump targets the header name input by CODE (5.2 anchors).
    await row.getByLabel("Jump to field").click();
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.getAttribute("data-testid") ?? null), { timeout: 5000 })
      .toBe("ws-doc-name");
  });

  test("unknown codes are never summarized — raw text only (no guessing)", async ({ page, request }) => {
    await pinLocaleEn(page);
    // A finding whose code is DERIVED (no explicit map entry): an allowTools
    // entry that is not a tool leaf name. The client map does not know the
    // derived code, so the row must show the raw server text only.
    const content = {
      ...agentGreen("Derived Code Doc"),
      mcpServers: [{ registryName: "websearch", allowTools: ["bad tool!"] }],
    };
    const created = await request.post("/api/blueprints", { data: { kind: "agent", content } });
    const { blueprint } = await created.json();
    const verdict = await (await request.post(`/api/blueprints/${blueprint.id}/validate`)).json();
    const finding = verdict.errors.find((e) => /allowTools entries must be tool leaf names/.test(e.error));
    expect(finding, "the finding exists").toBeTruthy();
    expect(finding.code, "every finding carries a code").toBeTruthy();
    // The derived code is NOT in the client summary map.
    const src = JSON.parse(JSON.stringify(finding.code));
    expect(src).not.toBe("allowtools_invalid");

    await page.goto(`/studio?doc=${blueprint.id}`);
    const row = page.getByTestId("ws-validation-error").filter({ hasText: "allowTools entries must be tool leaf names" });
    await expect(row).toBeVisible({ timeout: 15000 });
    await expect(row).toHaveAttribute("data-code", src);
  });
});
