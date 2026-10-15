// Tests for the preview drawer's file-serving route (openspec:
// file-preview-drawer, tasks 7.1-7.3). The route is the only place the app
// hands arbitrary bytes to the browser, so these assert the safety properties
// rather than the happy path alone: traversal is rejected without reading
// anything outside the root, and content that could execute in this origin is
// forced to a download.

import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { mkdtemp, mkdir, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

// UPLOADS_DIR is read from PLATFORM_DATA_DIR at import time by paths.js, so set
// it before importing the route (a dev machine's ./uploads must not be touched).
const DATA_DIR = await mkdtemp(path.join(tmpdir(), "file-preview-data-"));
process.env.PLATFORM_DATA_DIR = DATA_DIR;
const { registerFileRoutes, UPLOADS_DIR, saveUploadFile, removeUploadDir } = await import(
  "../server/routes/files.js"
);
// The resources root resolves through paths.js too, so it also honors the
// PLATFORM_DATA_DIR set above (openspec: add-resource-library, task 4.1).
const resources = await import("../resources.js");

function request(app, path_, headers = {}) {
  const server = createServer(app);
  return new Promise((resolve, reject) => {
    server.unref();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      const req = httpRequest({ host: "127.0.0.1", port, path: path_, headers }, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks),
          }),
        );
      });
      req.on("error", reject);
      req.end();
    });
    server.on("error", reject);
  });
}

async function appWith(workspace) {
  const express = (await import("express")).default;
  const app = express();
  registerFileRoutes({ app, dshBridge: { getCwd: () => workspace } });
  return app;
}

const file = (root, rel) => `/api/files?root=${root}&path=${encodeURIComponent(rel)}`;

test("serves a file inside the workspace", async () => {
  const ws = await mkdtemp(path.join(tmpdir(), "ws-"));
  await writeFile(path.join(ws, "hello.txt"), "hi there");
  const app = await appWith(ws);

  const res = await request(app, file("workspace", "hello.txt"));
  assert.equal(res.status, 200);
  assert.equal(res.body.toString(), "hi there");
  assert.equal(res.headers["content-type"], "text/plain; charset=utf-8");
  assert.match(res.headers["content-disposition"], /^inline;/);
});

test("rejects traversal, absolute paths, and escaping symlinks without reading outside the root", async () => {
  const ws = await mkdtemp(path.join(tmpdir(), "ws-"));
  const outside = await mkdtemp(path.join(tmpdir(), "outside-"));
  await writeFile(path.join(outside, "secret.txt"), "TOP SECRET");
  await writeFile(path.join(ws, "ok.txt"), "fine");
  // A symlink that lives inside the root but points out of it.
  await symlink(path.join(outside, "secret.txt"), path.join(ws, "escape.txt"));
  const app = await appWith(ws);

  const traversal = await request(app, file("workspace", "../" + path.basename(outside) + "/secret.txt"));
  assert.equal(traversal.status, 403);
  assert.ok(!traversal.body.toString().includes("TOP SECRET"));

  // Deep traversal against a path that does not exist must also be 403, not 404.
  const deep = await request(app, file("workspace", "../../../../etc/passwd"));
  assert.equal(deep.status, 403);

  const absolute = await request(app, file("workspace", path.join(outside, "secret.txt")));
  assert.equal(absolute.status, 403);
  assert.ok(!absolute.body.toString().includes("TOP SECRET"));

  const escapingLink = await request(app, file("workspace", "escape.txt"));
  assert.equal(escapingLink.status, 403);
  assert.ok(!escapingLink.body.toString().includes("TOP SECRET"));

  // The in-root file still serves, so the rejections are the check working.
  assert.equal((await request(app, file("workspace", "ok.txt"))).status, 200);
});

test("a missing file inside the root is 404", async () => {
  const ws = await mkdtemp(path.join(tmpdir(), "ws-"));
  const app = await appWith(ws);
  assert.equal((await request(app, file("workspace", "nope.txt"))).status, 404);
});

test("HTML and unknown types are forced to download, not served inline", async () => {
  const ws = await mkdtemp(path.join(tmpdir(), "ws-"));
  await writeFile(path.join(ws, "evil.html"), "<script>alert(document.cookie)</script>");
  await writeFile(path.join(ws, "thing.bin"), "opaque");
  const app = await appWith(ws);

  for (const name of ["evil.html", "thing.bin"]) {
    const res = await request(app, file("workspace", name));
    assert.equal(res.status, 200, name);
    assert.match(res.headers["content-disposition"], /^attachment;/, name);
    assert.equal(res.headers["content-type"], "application/octet-stream", name);
  }
});

test("uploads root serves files written by saveUploadFile, keyed by document id", async () => {
  const stored = await saveUploadFile(Buffer.from("uploaded bytes"), "my report.csv", "doc-123");
  const app = await appWith(await mkdtemp(path.join(tmpdir(), "ws-")));

  assert.equal(stored.root, "uploads");
  assert.equal(stored.rel, "doc-123/my_report.csv");

  const res = await request(app, file(stored.root, stored.rel));
  assert.equal(res.status, 200);
  assert.equal(res.body.toString(), "uploaded bytes");
  // CSV is not an inline type: the client fetches it for the table renderer,
  // which a download disposition does not block.
  assert.match(res.headers["content-disposition"], /^attachment;/);
  assert.ok(UPLOADS_DIR.startsWith(DATA_DIR));
});

test("removeUploadDir removes a document's stored original and is idempotent", async () => {
  const stored = await saveUploadFile(Buffer.from("bytes"), "a.bin", "doc-456");
  const app = await appWith(await mkdtemp(path.join(tmpdir(), "ws-")));
  assert.equal((await request(app, file(stored.root, stored.rel))).status, 200);

  await removeUploadDir("doc-456");
  assert.equal((await request(app, file(stored.root, stored.rel))).status, 404);

  // Deleting twice must not error (a document row can be removed after its
  // original is already gone).
  await removeUploadDir("doc-456");
});

test("removeUploadDir refuses a key that would escape the uploads root", async () => {
  // DELETE /api/documents/:id passes a URL-derived id straight to this helper,
  // so a crafted key must be a no-op rather than a traversal.
  const sentinel = path.join(DATA_DIR, "sentinel");
  await mkdir(sentinel);
  await removeUploadDir("../sentinel");
  await removeUploadDir("..");
  await removeUploadDir("a/../../sentinel");
  assert.ok((await stat(sentinel)).isDirectory());
});

test("a root under a dotted path still serves; only dotfiles inside the root are refused", async () => {
  // The dotfiles policy must be relative to the served root. Applied to an
  // absolute path it would read a dot in the root's OWN prefix (a home dir like
  // /Users/john.doe, or the e2e temp root) as a forbidden dotfile and 403
  // everything.
  const parent = await mkdtemp(path.join(tmpdir(), "wsparent-"));
  const ws = path.join(parent, ".dotted-root");
  await mkdir(ws);
  await writeFile(path.join(ws, "ok.txt"), "served");
  await writeFile(path.join(ws, ".env"), "SECRET");
  const app = await appWith(ws);

  const ok = await request(app, file("workspace", "ok.txt"));
  assert.equal(ok.status, 200);
  assert.equal(ok.body.toString(), "served");

  // The guard still protects what it is for: a dotfile inside the root.
  const secret = await request(app, file("workspace", ".env"));
  assert.equal(secret.status, 403);
  assert.ok(!secret.body.toString().includes("SECRET"));
});

test("a dotted upload filename is stored under a name the route can serve", async () => {
  // Stored as-is, `.env` would be a dotfile: the route refuses it and the
  // returned reference would 403 forever. The sanitizer strips the leading dot.
  const stored = await saveUploadFile(Buffer.from("SECRET=x"), ".env", "doc-789");
  assert.equal(stored.rel, "doc-789/env");

  const app = await appWith(await mkdtemp(path.join(tmpdir(), "ws-")));
  const res = await request(app, file(stored.root, stored.rel));
  assert.equal(res.status, 200);
  assert.equal(res.body.toString(), "SECRET=x");
});

test("an upload filename that would resolve onto the root is not silently lost", async () => {
  // ".." normalizes back onto the uploads root, where writeFile fails EISDIR —
  // which the ingest route swallows, leaving the attachment without a preview.
  const stored = await saveUploadFile(Buffer.from("x"), "..", "doc-790");
  assert.equal(stored.rel, "doc-790/upload");

  const app = await appWith(await mkdtemp(path.join(tmpdir(), "ws-")));
  assert.equal((await request(app, file(stored.root, stored.rel))).status, 200);
});

test("an unknown root is rejected", async () => {
  const ws = await mkdtemp(path.join(tmpdir(), "ws-"));
  const app = await appWith(ws);
  await mkdir(path.join(ws, "sub"));
  assert.equal((await request(app, file("etc", "passwd"))).status, 403);
});

test("the resources root serves stored copies with the same disposition rules", async () => {
  // A stored resource file is addressed as `<resource-id>/<name>` relative to
  // the resources root, which lives under PLATFORM_DATA_DIR.
  const app = await appWith(await mkdtemp(path.join(tmpdir(), "ws-")));
  await mkdir(path.join(resources.filesRoot(), "res-1"), { recursive: true });
  await writeFile(path.join(resources.filesRoot(), "res-1", "report.pdf"), "%PDF-1.4 bytes");
  await writeFile(
    path.join(resources.filesRoot(), "res-1", "evil.html"),
    "<script>alert(document.cookie)</script>",
  );

  const pdf = await request(app, file("resources", "res-1/report.pdf"));
  assert.equal(pdf.status, 200);
  assert.equal(pdf.body.toString(), "%PDF-1.4 bytes");
  assert.equal(pdf.headers["content-type"], "application/pdf");
  assert.match(pdf.headers["content-disposition"], /^inline;/);

  const html = await request(app, file("resources", "res-1/evil.html"));
  assert.equal(html.status, 200);
  assert.match(html.headers["content-disposition"], /^attachment;/);
  assert.equal(html.headers["content-type"], "application/octet-stream");

  assert.ok(resources.filesRoot().startsWith(DATA_DIR), "root lives under the data dir");
});

test("traversal against the resources root is rejected without reading outside", async () => {
  const outside = await mkdtemp(path.join(tmpdir(), "outside-"));
  await writeFile(path.join(outside, "secret.txt"), "TOP SECRET");
  const app = await appWith(await mkdtemp(path.join(tmpdir(), "ws-")));

  const traversal = await request(
    app,
    file("resources", "../" + path.basename(outside) + "/secret.txt"),
  );
  assert.equal(traversal.status, 403);
  assert.ok(!traversal.body.toString().includes("TOP SECRET"));

  const absolute = await request(app, file("resources", path.join(outside, "secret.txt")));
  assert.equal(absolute.status, 403);

  // A symlink inside the root pointing out of it: refused by realpath.
  await mkdir(path.join(resources.filesRoot(), "res-2"), { recursive: true });
  await symlink(
    path.join(outside, "secret.txt"),
    path.join(resources.filesRoot(), "res-2", "escape.txt"),
  );
  const escaping = await request(app, file("resources", "res-2/escape.txt"));
  assert.equal(escaping.status, 403);
  assert.ok(!escaping.body.toString().includes("TOP SECRET"));

  assert.equal((await request(app, file("resources", "res-2/nope.txt"))).status, 404);
});
