// Tests for fetch_document_file's core (add-doc-studio task 2.1, openspec
// delta: document-library-tools). The three contract scenarios — original
// lands in the workspace, original-not-retained is an explicit error, unknown
// document is an error — plus the workspace-resolution precedence that must
// mirror resolveBootWorkspace, because a drift there sends produced files to
// a directory the platform cannot serve.

import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  OriginalNotRetainedError,
  resolveWorkspaceDir,
  safeFilename,
  storeOriginalInWorkspace,
} from "../server/library-fetch.js";

async function makeLibrary(id, filename, bytes) {
  const root = await mkdtemp(path.join(tmpdir(), "lib-fetch-"));
  await mkdir(path.join(root, id), { recursive: true });
  await writeFile(path.join(root, id, filename), bytes);
  return root;
}

test("original lands in the workspace under the document's name", async () => {
  const uploadsRoot = await makeLibrary("doc-1", "report.docx", Buffer.from("PK-original-bytes"));
  const ws = await mkdtemp(path.join(tmpdir(), "ws-"));
  const rel = await storeOriginalInWorkspace({
    doc: { id: "doc-1", name: "季度报告.docx" },
    uploadsRoot,
    workspaceDir: ws,
  });
  assert.equal(rel, safeFilename("季度报告.docx"));
  const written = await readFile(path.join(ws, rel));
  assert.ok(written.equals(Buffer.from("PK-original-bytes")));
});

test("original not retained is an explicit error, no file written", async () => {
  // An uploads root with no directory for the doc: URL-ingested sources.
  const uploadsRoot = await mkdtemp(path.join(tmpdir(), "lib-fetch-"));
  const ws = await mkdtemp(path.join(tmpdir(), "ws-"));
  await assert.rejects(
    storeOriginalInWorkspace({ doc: { id: "doc-url", name: "web page" }, uploadsRoot, workspaceDir: ws }),
    OriginalNotRetainedError,
  );
  // And the empty-directory variant (dir exists, nothing usable in it).
  await mkdir(path.join(uploadsRoot, "doc-empty"), { recursive: true });
  await writeFile(path.join(uploadsRoot, "doc-empty", ".hidden"), Buffer.from("x"));
  await assert.rejects(
    storeOriginalInWorkspace({ doc: { id: "doc-empty", name: "empty" }, uploadsRoot, workspaceDir: ws }),
    OriginalNotRetainedError,
  );
  assert.equal((await readFile(path.join(ws, "empty")).catch(() => null)), null);
});

test("unknown document is rejected before touching the workspace", async () => {
  const uploadsRoot = await makeLibrary("doc-1", "a.docx", Buffer.from("x"));
  const ws = await mkdtemp(path.join(tmpdir(), "ws-"));
  await assert.rejects(
    storeOriginalInWorkspace({ doc: null, uploadsRoot, workspaceDir: ws }),
    OriginalNotRetainedError,
  );
});

test("workspace resolution mirrors resolveBootWorkspace precedence", async () => {
  const pin = await mkdtemp(path.join(tmpdir(), "ws-pin-"));
  const saved = await mkdtemp(path.join(tmpdir(), "ws-saved-"));
  const missing = path.join(await mkdtemp(path.join(tmpdir(), "ws-none-")), "gone");

  // Pin wins over preference; preference wins over cwd; invalid tiers fall through.
  const a = await resolveWorkspaceDir({ env: { AGENT_WORKSPACE: pin }, getPreference: () => saved });
  assert.equal(a.source, "env");
  assert.equal(a.path, await realpathOf(pin));

  const b = await resolveWorkspaceDir({ env: { AGENT_WORKSPACE: missing }, getPreference: () => saved });
  assert.equal(b.source, "preference");
  assert.equal(b.path, await realpathOf(saved));

  const c = await resolveWorkspaceDir({ env: { AGENT_WORKSPACE: missing }, getPreference: () => missing });
  assert.equal(c.source, "cwd");

  // No preference getter (db not ready) degrades to cwd, not a crash.
  const d = await resolveWorkspaceDir({ env: {}, getPreference: null });
  assert.equal(d.source, "cwd");
});

test("a symlinked workspace tier validates the target, not the link", async () => {
  const real = await mkdtemp(path.join(tmpdir(), "ws-real-"));
  const linkParent = await mkdtemp(path.join(tmpdir(), "ws-link-"));
  const link = path.join(linkParent, "linked");
  await symlink(real, link);
  const r = await resolveWorkspaceDir({ env: { AGENT_WORKSPACE: link }, getPreference: null });
  assert.equal(r.path, await realpathOf(real));
});

async function realpathOf(p) {
  return (await import("node:fs/promises")).realpath(p);
}
