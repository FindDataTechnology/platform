#!/usr/bin/env node
// ── Agent workspace source-contract tests (add-agent-studio, re-pinned by
//    add-agent-builder-workspace batch 1) ────────────────────────────────────
//
// Pins the workspace's structural contract by source assertion (repo
// convention: node --test + source reads; behavior rides e2e/walkthrough):
//   1. validation rides the blueprint lifecycle's EXISTING publish-gate chain
//      (POST /api/blueprints/:id/validate server-side) — no client validator
//   2. autosave = debounced optimistic PUT; a 409 never overwrites silently
//   3. the inspector follows the canvas: validation/spec sheet render ONLY for
//      the open document (the production-screenshot mismatch is structurally
//      impossible)
//   4. the ribbon is a pure projection (teamRibbon) — the page never gates a
//      lifecycle action on its own reading of status
//   5. MCP references come from the catalog picker only (shared editor)
//   6. the working document is PERSISTED (blueprint record); the ephemeral
//      StudioDoc and the second editor host (BlueprintTeamMode) are retired
//   7. routes wired: /studio + /blueprints redirect + hub entry/board
//   8. i18n: studio.* chrome + the whole studio.workspace subtree in all five
//
//   node --test scripts/test-agent-studio.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");

const page = read("web/src/pages/AgentStudioPage.tsx");
const app = read("web/src/App.tsx");
// W2 teardown (0eb48a0d0) retired the /agents four-zone hub: AgentsPage is an
// orphaned module (zero importers — kept for the migration window only) and
// the market facade is AgentMarketPage. Assertions that read the hub now read
// the market page.
const agentsPage = read("web/src/pages/AgentMarketPage.tsx");
const bucketsEditor = read("web/src/components/studio/AgentBucketsEditor.tsx");
const ribbon = read("web/src/components/studio/LifecycleRibbon.tsx");
const lifecycleLib = read("web/src/lib/workspace-lifecycle.ts");

test("validation is the existing publish-gate chain via the blueprint validate endpoint, never a client validator", () => {
  assert.match(page, /validateBlueprint/, "the workspace calls POST /api/blueprints/:id/validate");
  assert.ok(!page.includes("lib/pack-manifest"), "no validator lib import in web code");
  assert.ok(!/validatePackManifest/.test(page), "no validator re-implementation");
  assert.ok(!/\/api\/packs\/validate/.test(page), "no second validate face from the page");
});

test("autosave: debounced optimistic PUT; 409 shows the conflict banner, nothing silent", () => {
  assert.match(page, /updateBlueprint\(/, "edits land through the blueprint PUT");
  assert.match(page, /setTimeout\(\(\) => void saveNow\(\), 1500\)/, "debounce of 1.5s");
  assert.match(page, /in-flight merge|queuedRef/, "concurrent saves merge (single in flight)");
  assert.match(page, /status === 409/, "409 handled explicitly");
  const conflictUi = page.slice(page.indexOf("Conflict banner"), page.indexOf("<ConfirmDialog"));
  assert.match(conflictUi, /ws-conflict-reload/, "reload option present");
  assert.match(conflictUi, /ws-conflict-overwrite/, "keep-mine option present");
  // Keep-mine is destructive: it re-reads the server version and rides a
  // ConfirmDialog — never a plain button write.
  assert.match(page, /variant="danger"/, "overwrite confirm dialog is danger-variant");
  assert.match(page, /getBlueprint\(doc\.id\)[\s\S]{0,120}updateBlueprint\(doc\.id, blueprint\.version/, "overwrite re-anchors on the server's newest version");
});

test("the inspector follows the canvas: it renders only for the open document", () => {
  // ValidationPanel + AgentSpecSheet sit inside the `{doc && …}` inspector
  // block — there is no code path that shows an inspector for a doc the
  // canvas is not editing.
  const inspector = page.slice(page.indexOf('data-testid="ws-inspector"'));
  assert.ok(inspector.indexOf("<LifecycleRibbon") > inspector.indexOf("{doc && ribbonView"), "ribbon gated on doc");
  assert.ok(inspector.indexOf("<ValidationPanel") > inspector.indexOf("{doc && ("), "validation gated on doc");
  assert.ok(inspector.indexOf("<AgentSpecSheet") > inspector.indexOf("{doc && ("), "spec sheet gated on doc");
});

test("the ribbon is a pure projection: gates come from teamRibbon, the server re-checks", () => {
  assert.match(page, /teamRibbon\(/, "the page projects through teamRibbon");
  assert.match(lifecycleLib, /verdictOk && !saving/, "approve needs green validation (server truth)");
  assert.match(lifecycleLib, /isApprover/, "cast/reseal keep the approver gate");
  // trial only ever surfaces in the cast branch — the retired "trial before
  // approval" UI lie is structurally impossible now.
  assert.match(lifecycleLib, /status === "cast"/, "trial stage rides the cast branch");
  assert.match(ribbon, /onAction\(a\.action\)/, "the ribbon only forwards actions; no gate logic here");
  assert.ok(!/fetch\(|api\.|bp\./.test(ribbon), "the ribbon component never calls the server itself");
});

test("MCP references are picker-only (no free-form registryName entry)", () => {
  assert.match(bucketsEditor, /mcp-add/, "the picker select exists in the shared editor");
  assert.ok(!/registryName[:=]\s*[a-z]*\.target\.value/.test(page), "no page input binds registryName from typed text");
});

test("the working document is persisted: ephemeral StudioDoc retired, blueprint records are the spine", () => {
  assert.ok(!/useState<StudioDoc>|emptyDoc/.test(page), "no ephemeral document state left");
  assert.match(page, /createBlueprint\(/, "new document POSTs a blueprint draft record");
  assert.match(page, /Blueprint\b/, "the open document is a persisted Blueprint");
});

test("second host retired: no BlueprintTeamMode, routes redirect, market facade carries the studio entry (W2 teardown shape)", () => {
  assert.ok(!fs.existsSync(path.join(root, "web/src/components/studio/BlueprintTeamMode.tsx")), "team-mode host removed");
  assert.ok(!fs.existsSync(path.join(root, "web/src/pages/BlueprintStudioPage.tsx")), "old blueprint page removed");
  assert.ok(!page.includes("BlueprintTeamMode") && !app.includes("BlueprintTeamMode"), "no imports of the retired host");
  // W2 (add-supply-studio-migration 4.1/4.2): /studio is a redirect to the
  // supply domain (StudioRouteRedirect → STUDIO_ORIGIN/#/studio); the old
  // in-domain BlueprintRouteRedirect is gone. /blueprints rides the same
  // redirect with from=blueprint.
  assert.match(app, /path="\/studio" element=\{<StudioRouteRedirect \/>\}/, "App.tsx mounts /studio as the supply-domain redirect");
  assert.match(app, /path="\/blueprints" element=\{<StudioRouteRedirect params=\{\{ from: "blueprint" \}\} \/>\}/, "the /blueprints route redirects via the same StudioRouteRedirect");
  assert.ok(!app.includes("to=\"/studio?from=blueprint\""), "no in-domain redirect target (W2 retargeted it)");
  // W2 4.2: the market facade carries the studio deep link (was AgentsPage
  // agents-studio-link); the hub build-zone board is retired with the hub.
  assert.match(agentsPage, /agent-market-studio/, "AgentMarketPage carries the studio entry link");
});

test("deep links: doc / fork / new all seeded from search params; skills ride the persisted document", () => {
  assert.match(page, /searchParams\.get\("doc"\)/, "?doc= opens a document");
  assert.match(page, /searchParams\.get\("fork"\)/, "?fork= seeds from a pack");
  assert.match(page, /searchParams\.get\("new"\)/, "?new= mints one document");
  // A reload of a seeded URL must not mint a second record. The call goes
  // through the page's `go()` wrapper now (it lets an embedding host intercept
  // navigation before falling through to `navigate`), so pin the invariant —
  // a replace-navigation to the canonical ?doc= URL — not the helper's name.
  assert.match(page, /(?:navigate|go)\(`\/studio\?doc=.*replace: true/, "seeded URLs canonicalize to ?doc= (no double mint)");
  // 4.3: skills live in the persisted content now — the bucket is editable and
  // the emit ports read the document (assembleManifest carries skills).
  assert.match(page, /\bshowSkills\b(?!=\{false\})/, "the skills bucket is enabled");
  assert.match(page, /content\.skills/, "skills ride the persisted document");
  assert.match(page, /skills: \(\(c\?\.skills \?\? \[\]\) as PackManifestSkill\[\]\)/, "emitDraft reads the document's skills");
  assert.match(page, /skillNames/, "emitPreset forwards declared skill names");
});

test("kind (batch 2): dual create entries, agent documents carry no team ribbon, one-click agent mint", () => {
  assert.match(page, /createDoc = useCallback\(async \(kind: "agent" \| "team" = "team"\)/, "createDoc takes the kind");
  assert.match(page, /agentSkeletonContent/, "agent documents mint from the light skeleton");
  assert.match(page, /newParam === "agent" \? "agent" : "team"/, "?new=agent opens the agent lane");
  assert.match(page, /const docKind: "agent" \| "team" = content\?\.kind === "agent"/, "kind read from the persisted content (default team)");
  // The ribbon only renders for team documents; agent documents get the honest
  // draft card instead (server 409s approve/cast for agent kind).
  assert.match(page, /docKind === "team" && ribbonView && <LifecycleRibbon/, "ribbon gated on team kind");
  assert.match(page, /ws-agent-draft-card/, "agent documents get the draft card");
  // The name/description binding follows the kind (no boundary on agent docs).
  assert.match(page, /docKind === "agent"\s*\?\s*patchContent\(\{ name: e\.target\.value \}\)/, "agent name edits content.name");
  assert.match(page, /docKind === "agent"\s*\?\s*patchContent\(\{ description: e\.target\.value \}\)/, "agent description edits content.description");
  // Dual entries: library footer + header.
  assert.match(page, /onNew=\{\(kind\) => void createDoc\(kind\)\}/, "library forwards the kind");
  const lib = read("web/src/components/studio/DocumentLibrary.tsx");
  assert.match(lib, /ws-new-agent/, "library carries the new-agent entry");
  assert.match(lib, /ws-new-team/, "library carries the new-team entry");
  assert.match(lib, /ws-library-kind-/, "the library marks the kind badge");
});

test("single-sourced page module: the 壹座 host lazily imports it no more (facet is the only host, via the @ alias)", () => {
  // W2 4.1/4.6: the 壹座 host retired its lazy AgentStudioPage import (the
  // /studio route is the redirect); the page module stays single-sourced for
  // the facet host (facet/web alias `@` → web/src).
  assert.ok(!app.includes("AgentStudioPage = lazy"), "壹座 App.tsx no longer lazy-imports the studio page");
  assert.ok(fs.existsSync(path.join(root, "facet/web/src/StudioView.tsx")), "facet StudioView (the sole host) exists");
});

test("i18n: studio chrome + the full workspace subtree exist in all five locales", () => {
  const W = [
    "title", "back", "dirty", "saving", "saved", "saveFailed", "overwriteDone",
    "conflict", "conflictShort", "conflictReload", "conflictOverwrite", "conflictOverwriteConfirm",
    "actionFailed", "createFailed", "openFailed", "forkMiss",
    "approved", "castOk", "signed", "trialGreen", "trialRed",
    "toggleLibrary", "toggleInspector",
    "ribbonNeedGreen", "ribbonOnlyApprover",
    "ribbonRecastNote", "ribbonCastRef", "ribbonSignStale", "ribbonResealHint",
  ];
  for (const loc of ["zh-CN", "en", "ja", "fr", "es"]) {
    const d = JSON.parse(read(`web/src/locales/${loc}/common.json`));
    const s = d.studio;
    assert.ok(s, `${loc}: studio block present`);
    for (const k of ["title", "roster", "canvas", "agent", "doc", "skill", "mcp", "team", "validate", "emit", "remove"]) {
      assert.ok(s[k] !== undefined, `${loc}: studio.${k} present`);
    }
    const w = s.workspace;
    assert.ok(w, `${loc}: studio.workspace present`);
    for (const k of W) assert.ok(typeof w[k] === "string" && w[k].length > 0, `${loc}: studio.workspace.${k}`);
    for (const k of ["envelope"]) assert.ok(w.section?.[k], `${loc}: studio.workspace.section.${k}`);
    for (const k of ["empty"]) assert.ok(w.canvas?.[k], `${loc}: studio.workspace.canvas.${k}`);
    for (const k of ["section", "needGreen"]) assert.ok(w.emit?.[k], `${loc}: studio.workspace.emit.${k}`);
    for (const k of ["adopt", "adoptAll", "adoptPicked", "skip", "close", "inert"]) assert.ok(w.draft?.[k], `${loc}: studio.workspace.draft.${k}`);
    for (const k of ["search", "empty", "guideBlank", "guideAi", "guideMarket"]) assert.ok(w.library?.[k], `${loc}: studio.workspace.library.${k}`);
    for (const k of ["draft", "approve", "cast", "trial", "sign", "reseal"]) assert.ok(w.ribbon?.stage?.[k], `${loc}: studio.workspace.ribbon.stage.${k}`);
    for (const k of ["reseal", "sign", "trialRunning"]) assert.ok(w.ribbon?.[k], `${loc}: studio.workspace.ribbon.${k}`);
    for (const k of ["jump", "jumpMiss", "copy", "copied"]) assert.ok(w.validation?.[k], `${loc}: studio.workspace.validation.${k}`);
    // hub board copy
    assert.ok(d.hub?.build?.new && d.hub?.build?.workspace && d.hub?.build?.recent, `${loc}: hub.build board keys`);
  }
});

test("the lifecycle copy tells the server's truth (validate→approve→cast→trial→sign→reseal)", () => {
  // 2.2: no locale may list trial BEFORE approve in the lifecycle sentence —
  // the retired host's lie was "validate → trial → approve → cast". Terms are
  // per-locale inflections of the two words.
  const TERMS = {
    "zh-CN": ["批准", "试跑"],
    "ja": ["承認", "試走"],
    "en": ["approve", "trial"],
    "es": ["aprobar", "prueba"],
    "fr": ["approuver", "essai"],
  };
  for (const [loc, [ap, tr]] of Object.entries(TERMS)) {
    const d = JSON.parse(read(`web/src/locales/${loc}/common.json`));
    const s = d.studio.blueprint.empty;
    const iAp = s.toLowerCase().indexOf(ap);
    const iTr = s.toLowerCase().indexOf(tr);
    assert.ok(iAp >= 0, `${loc}: empty copy names approve (${ap}) — got ${s}`);
    assert.ok(iTr >= 0, `${loc}: empty copy names trial (${tr}) — got ${s}`);
    assert.ok(iAp < iTr, `${loc}: approve before trial — got ${s}`);
  }
});
