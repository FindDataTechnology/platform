// Unit coverage for the shared link-resolution rule (openspec:
// wire-unpreviewable-links-to-drawer, task 1.1). The rule lives in
// packages/core and is consumed by BOTH clients — the web preview drawer and
// the mini program's file chip — so a drift here is a per-client behavior
// difference. It had no unit coverage before this file: only e2e specs touched
// it indirectly, and they did not pin which types each rule admits.
//
// Node ≥23.6 strips the TS import natively (same approach as
// scripts/test-chart-fence-hash.mjs).

import assert from "node:assert/strict";
import { test } from "node:test";

const { extOf, fileLinkRef, kindOf, looksLikeFile, resolveRef, FILE_EXTENSIONS } = await import(
  "../packages/core/src/lib/file-ref.ts"
);
const coreModule = await import("../packages/core/src/lib/file-ref.ts");

const WS = "/workspace";

// The types the broad rule admits but the narrow one does not — the exact set
// this change makes reachable from the web chat.
const UNPREVIEWABLE_PRODUCED = [
  "bundle.zip",
  "sheet.xlsx",
  "legacy.xls",
  "deck.pptx",
  "legacy.doc",
  "data.json",
  "conf.yaml",
  "conf.yml",
  "feed.xml",
  "table.tsv",
];

// Types that already had a renderer, so both rules admit them.
const PREVIEWABLE = [
  "pic.png",
  "shot.jpeg",
  "doc.pdf",
  "notes.md",
  "data.csv",
  "page.html",
  "report.docx",
  "plain.txt",
  "run.log",
];

test("extOf is case-folded and takes the final extension", () => {
  assert.equal(extOf("BUNDLE.ZIP"), "zip");
  assert.equal(extOf("archive.tar.gz"), "gz");
  assert.equal(extOf("no-extension"), "");
  assert.equal(extOf("  spaced.PDF  "), "pdf");
});

test("kindOf reports a renderer only for renderable types", () => {
  assert.equal(kindOf("pic.png"), "image");
  assert.equal(kindOf("doc.pdf"), "pdf");
  assert.equal(kindOf("notes.md"), "markdown");
  assert.equal(kindOf("data.csv"), "csv");
  assert.equal(kindOf("page.html"), "html");
  assert.equal(kindOf("report.docx"), "docx");
  // Produced files with no renderer: recognized as produced, but no kind.
  for (const name of UNPREVIEWABLE_PRODUCED) {
    assert.equal(kindOf(name), "none", `${name} must have no renderer`);
  }
});

test("the broad rule admits every produced-file type, renderable or not", () => {
  for (const name of [...PREVIEWABLE, ...UNPREVIEWABLE_PRODUCED]) {
    assert.ok(looksLikeFile(name), `${name} must count as a produced file`);
    const ref = fileLinkRef(name, WS);
    assert.deepEqual(ref, { root: "workspace", rel: name }, `${name} must resolve`);
  }
});

test("the broad rule refuses targets that name no produced file", () => {
  assert.equal(fileLinkRef("loose.bin", WS), null);
  assert.equal(fileLinkRef("program.exe", WS), null);
  assert.equal(fileLinkRef("object.o", WS), null);
  assert.equal(fileLinkRef("no-extension", WS), null);
  assert.equal(fileLinkRef("", WS), null);
  assert.equal(fileLinkRef(undefined, WS), null);
});

test("the single rule refuses external URLs", () => {
  for (const href of [
    "https://example.com/report.pdf",
    "http://example.com/a.zip",
    "mailto:someone@example.com",
  ]) {
    assert.equal(fileLinkRef(href, WS), null, `${href} must not resolve`);
  }
});

test("a route href is admitted regardless of extension", () => {
  // The route form is self-describing: the server already decided to serve it.
  // e2e/session-open.spec.js relies on this for the unpreviewable case.
  const route = "/api/files?root=workspace&path=bundle.zip";
  assert.deepEqual(fileLinkRef(route, WS), { root: "workspace", rel: "bundle.zip" });
});

test("a route href naming an unknown root or a missing path is refused", () => {
  assert.equal(fileLinkRef("/api/files?root=elsewhere&path=a.zip", WS), null);
  assert.equal(fileLinkRef("/api/files?root=workspace", WS), null);
});

test("no second, narrower link rule exists", () => {
  // Regression guard for the defect this change fixes: a narrow variant that
  // admitted only renderable types used to sit beside the broad rule, and the
  // web chat resolved through it, so a produced-but-unrenderable file was
  // unreachable from the conversation. "Can I render this" is `kindOf`, asked
  // by the drawer — a different question from "is this a produced file".
  const core = coreModule;
  assert.equal(core.linkRef, undefined, "the narrow link rule must not come back");
});

test("a produced file is not addressable outside the workspace", () => {
  // An absolute path is only resolvable when it lands inside the workspace —
  // the only absolute root the server knows.
  assert.equal(resolveRef("/etc/passwd", WS), null);
  assert.equal(resolveRef("/etc/passwd", null), null);
  assert.equal(fileLinkRef("/etc/passwd", WS), null);
  // Inside it, absolute and relative forms agree.
  assert.deepEqual(resolveRef(`${WS}/bundle.zip`, WS), { root: "workspace", rel: "bundle.zip" });
  assert.deepEqual(resolveRef("./bundle.zip", WS), { root: "workspace", rel: "bundle.zip" });
});

test("a target escaping the workspace is refused", () => {
  assert.equal(resolveRef("../outside.zip", WS), null);
  assert.equal(resolveRef("..", WS), null);
  assert.equal(fileLinkRef("../outside.zip", WS), null);
});

test("mid-path traversal resolves lexically and is stopped by the server", () => {
  // resolveRef is a LEXICAL resolver, not the containment boundary: it refuses
  // a leading escape but does not collapse `nested/../../`. The server's route
  // is the authority and rejects both forms with 403 (probed against the real
  // route; see scripts/test-file-serving.mjs for its own traversal coverage).
  // Pinned here so the split of responsibility is explicit rather than
  // assumed: the client may hand the route a ref, and the route refuses it.
  assert.deepEqual(resolveRef("nested/../../outside.zip", WS), {
    root: "workspace",
    rel: "nested/../../outside.zip",
  });
});

test("the produced-file table stays coherent", () => {
  // Every extension the broad rule admits must survive extOf's lowercasing and
  // must be a bare extension (no dots), or lookups would never match.
  for (const ext of FILE_EXTENSIONS) {
    assert.equal(ext, ext.toLowerCase(), `${ext} must be lowercase`);
    assert.ok(!ext.includes("."), `${ext} must not contain a dot`);
    assert.ok(looksLikeFile(`file.${ext}`), `file.${ext} must be recognized`);
  }
});
