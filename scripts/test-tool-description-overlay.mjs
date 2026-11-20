#!/usr/bin/env node
// ── Tool-description overlay suite (add-tool-description-enrichment) ─────────
//
// Three layers pinned here:
//   1. The pure policy (enrichDescription): append default, replace on empty
//      upstream, idempotent under resync (只增强不改名 is structural — the
//      name never enters the rewrite path).
//   2. The REAL-runtime seam (same sentinel discipline as
//      test-tool-scope-register-seam.mjs): the bridge's own installer chained
//      AFTER the scope register-shadow on the pinned runtime — enriched
//      descriptions survive a passing registration, out-of-allowlist tools
//      still drop, names/schemas stay byte-identical.
//   3. The host writer (writeToolDescriptionOverlay) + the canonical-briefs
//      accessor: doc shape, stale-file removal on disable, and the curated-
//      only guarantee against the real bundled catalog.
//
//   node --test scripts/test-tool-description-overlay.mjs

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { Context } from "@deepseek-ai/cordis";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";

const tmpRoot = mkdtempSync(path.join(tmpdir(), "tool-desc-overlay-"));
process.env.TOOL_DESCRIPTION_PATH = path.join(tmpRoot, "tool-description.json");
process.env.TOOL_FILTER_PATH = path.join(tmpRoot, "tool-filter.json");

const { installMcpToolDescriptionOverlay, enrichDescription, overlayBriefFor } =
  await import("../dsh-profile-template/platform-tool-description.js");
const { installMcpToolRegisterShadow } = await import("../dsh-profile-template/platform-tool-scope.js");
const { writeToolDescriptionOverlay } = await import("../dsh-profile.js");
const { getCanonicalBriefs } = await import("../extension-store.js");

test.after(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

// ── 1. The pure policy ───────────────────────────────────────────────────────

test("policy: non-empty upstream appends (upstream first, blank-line separated)", () => {
  const out = enrichDescription("Upstream text.", "Curated brief.");
  assert.equal(out, "Upstream text.\n\nCurated brief.");
});

test("policy: empty/missing upstream replaces", () => {
  assert.equal(enrichDescription("", "Curated brief."), "Curated brief.");
  assert.equal(enrichDescription(undefined, "Curated brief."), "Curated brief.");
  assert.equal(enrichDescription("   ", "Curated brief."), "Curated brief.");
});

test("policy: idempotent under resync (brief already present)", () => {
  const once = enrichDescription("Upstream.", "Brief.");
  assert.equal(enrichDescription(once, "Brief."), once);
});

// ── 2. The real-runtime seam (chained after the scope shadow) ────────────────

const mkTool = (name, description = `seam probe ${name}`) => ({
  name,
  description,
  parameters: { type: "object", properties: {}, required: [] },
  output: { schema: { type: "object" }, render: async () => ({ content: [{ type: "text", text: "ok" }] }) },
  async exec() {
    return { content: [{ type: "text", text: "ok" }] };
  },
});

async function bootTools() {
  const app = new Context();
  await app.plugin(SystemPrompt);
  await app.plugin((await import("@deepseek-ai/dsh-tools")).default);
  const inst = Reflect.get(app.get("tools"), Symbol.for("cordis.original"));
  assert.ok(inst, "the service view unwraps to a shared raw instance");
  return { app, inst };
}

const writeOverlay = (descriptions) =>
  writeFileSync(
    process.env.TOOL_DESCRIPTION_PATH,
    JSON.stringify({ descriptions, meta: { enriched: 1, source: "annotations", generatedAt: "t" } }),
  );

test("seam: enriched description registers; name and schema untouched; unenriched byte-identical", async () => {
  writeOverlay({ github: { create_issue: { brief: "Creates a real GitHub issue with title/body.", source: "catalog" } } });
  writeFileSync(process.env.TOOL_FILTER_PATH, JSON.stringify({ mcpTools: {} })); // no allowlist narrowing
  const { app, inst } = await bootTools();
  try {
    installMcpToolRegisterShadow(app);
    installMcpToolDescriptionOverlay(app); // chained AFTER the scope shadow

    const view = app.extend({});
    view.tools.register(mkTool("mcp__github__create_issue", "GitHub API: issues."));
    view.tools.register(mkTool("mcp__github__list_issues", "GitHub API: list."));
    view.tools.register(mkTool("bash"));

    const schemas = new Map(inst.schemas().map((s) => [s.name, s]));
    const enriched = schemas.get("mcp__github__create_issue");
    assert.equal(enriched.name, "mcp__github__create_issue"); // 只增强不改名
    assert.match(enriched.description, /^GitHub API: issues\./); // upstream first
    assert.ok(enriched.description.includes("Creates a real GitHub issue with title/body.")); // brief appended
    assert.ok(enriched.description.includes("[catalog]")); // provenance suffix
    assert.deepEqual(enriched.parameters, mkTool("x").parameters); // schema untouched

    assert.equal(schemas.get("mcp__github__list_issues").description, "GitHub API: list."); // no entry → byte-identical
    assert.equal(schemas.get("bash").description, "seam probe bash"); // non-MCP untouched
  } finally {
    await app.destroy?.();
  }
});

test("seam: empty upstream description is replaced by the brief", async () => {
  writeOverlay({ gh: { bare: { brief: "The curated brief." } } });
  const { app, inst } = await bootTools();
  try {
    installMcpToolRegisterShadow(app);
    installMcpToolDescriptionOverlay(app);
    const view = app.extend({});
    view.tools.register(mkTool("mcp__gh__bare", ""));
    const schema = inst.schemas().find((s) => s.name === "mcp__gh__bare");
    assert.equal(schema.description, "The curated brief."); // replace, no source in fixture → no suffix
  } finally {
    await app.destroy?.();
  }
});

test("seam: no overlay file → byte-identical registration (the pre-change path)", async () => {
  rmSync(process.env.TOOL_DESCRIPTION_PATH, { force: true });
  const { app, inst } = await bootTools();
  try {
    installMcpToolRegisterShadow(app);
    installMcpToolDescriptionOverlay(app);
    const view = app.extend({});
    view.tools.register(mkTool("mcp__any__tool", "Raw upstream."));
    assert.equal(inst.schemas().find((s) => s.name === "mcp__any__tool").description, "Raw upstream.");
  } finally {
    await app.destroy?.();
  }
});

test("seam: scope allowlist still drops after enrichment (chain order holds)", async () => {
  writeOverlay({ gh: { secret: { brief: "Brief." } } });
  writeFileSync(process.env.TOOL_FILTER_PATH, JSON.stringify({ mcpTools: { gh: ["open"] } }));
  const { app, inst } = await bootTools();
  try {
    installMcpToolRegisterShadow(app);
    installMcpToolDescriptionOverlay(app);
    const view = app.extend({});
    view.tools.register(mkTool("mcp__gh__open", "Up."));
    view.tools.register(mkTool("mcp__gh__secret", "Up."));
    const names = inst.schemas().map((s) => s.name);
    assert.ok(names.includes("mcp__gh__open"));
    assert.ok(!names.includes("mcp__gh__secret")); // dropped by the scope shadow below
  } finally {
    await app.destroy?.();
  }
});

// 3.3 (add-tool-description-enrichment): a publicFacing face DELETES internal
// servers; its overlay must not revive them. Two layers pinned:
//   a) the host gate writes null for publicFacing → no stale file survives
//      (covered by the writer test's null-removal);
//   b) even a stale file that slipped through (pre-upgrade runtime) cannot
//      revive a deleted server — decoration happens at registration time and
//      a deleted server never registers, so its dangling entry is inert and
//      the kept tools read byte-identical to the enrichment-off baseline
//      (生效面枚举对照).
test("seam: publicFacing deleted-server revival guard — dangling entries inert, enumeration byte-identical", async () => {
  writeOverlay({
    "wire-ops": { mint_token: { brief: "INTERNAL: mints fleet credentials.", source: "annotations" } },
  });
  const { app, inst } = await bootTools();
  try {
    installMcpToolRegisterShadow(app);
    installMcpToolDescriptionOverlay(app);
    const view = app.extend({});
    // The publicFacing face's kept tools only — wire-ops was deleted upstream.
    view.tools.register(mkTool("mcp__github__create_issue", "GitHub API: issues."));
    view.tools.register(mkTool("bash"));
    const names = inst.schemas().map((s) => s.name).sort();
    assert.deepEqual(names, ["bash", "mcp__github__create_issue"]); // wire-ops 不复活
    // Enumeration parity: kept tools byte-identical to no-overlay (the dangling
    // entry touches nothing the face doesn't register).
    assert.equal(
      inst.schemas().find((s) => s.name === "mcp__github__create_issue").description,
      "GitHub API: issues.",
    );
    assert.equal(inst.schemas().find((s) => s.name === "bash").description, "seam probe bash");
  } finally {
    await app.destroy?.();
  }
});

test("brief lookup: provenance suffix from the entry's source; blank brief → null", () => {
  writeOverlay({ gh: { a: { brief: "B.", source: "registry" }, b: { brief: "  " } } });
  assert.equal(overlayBriefFor("gh", "a"), "B. [registry]");
  assert.equal(overlayBriefFor("gh", "b"), null);
  assert.equal(overlayBriefFor("gh", "missing"), null);
});

// ── 3. The host writer + canonical accessor ──────────────────────────────────

test("writer: briefs materialize as the nested doc with meta; empties remove the file", () => {
  const home = mkdtempSync(path.join(tmpdir(), "tool-desc-writer-"));
  try {
    const dirs = { dshHome: home, profileName: "platform" };
    const p = writeToolDescriptionOverlay(
      { tools: { "github__create_issue": { brief: " Creates a real issue. ", source: "catalog", updatedAt: "2026-11-01" } } },
      { dirs },
    );
    assert.ok(p && existsSync(p));
    const doc = JSON.parse(readFileSync(p, "utf8"));
    assert.equal(doc.descriptions.github.create_issue.brief, "Creates a real issue."); // trimmed
    assert.equal(doc.descriptions.github.create_issue.source, "catalog");
    assert.equal(doc.meta.enriched, 1);

    // Disable (null briefs) removes the stale file — no overlay left behind.
    writeToolDescriptionOverlay(null, { dirs });
    assert.equal(existsSync(p), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("canonical accessor: curated tool briefs index under server__leaf, provenance carried", async () => {
  const briefs = await getCanonicalBriefs();
  const hit = briefs.tools["github__create_issue"];
  assert.ok(hit, "the curated github tool brief rides the index");
  assert.ok(hit.brief.length > 0);
  assert.equal(hit.source, "catalog");
});
