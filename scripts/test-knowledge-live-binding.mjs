// Task 5.3 (add-member-knowledge-profile): the RUNTIME half of the collection
// binding — the member's library boundary follows LIBRARY_COLLECTIONS live.
//
// The pure half (normalize/effective/patch stamping) is covered by
// test-knowledge-profile.mjs and test-member-mcp-patch.mjs. This file drives
// the actual tool server (server/library-mcp.js) against a seeded temp DB and
// asserts the three spec clauses:
//   1. a collection outside LIBRARY_COLLECTIONS answers "does not exist"
//      (existence leak forbidden — the spec's explicit error wording);
//   2. REMOVING a collection from the member's set (restart with a narrower env
//      — the same effect a PUT /knowledge-profile patch-cache invalidation has
//      on the next composed member env) makes previously visible documents
//      invisible;
//   3. ADDING a collection makes its documents visible immediately (list +
//      search + read all honor the new boundary).
//
// Transport: streamable-http (LIBRARY_MCP_HTTP_PORT), NOT stdio.
//
// Why the change (2026-11-10): the original stdio harness was quarantined for
// hanging, and its recorded cause ("child teardown") proved wrong. Re-measured
// here and each ruled out: teardown completeness, env inheritance (empty /
// PATH-only / full), `using` scoping, frame framing (2184B, one newline), WAL
// residue, and the seeded DB state (journal_mode=wal, integrity ok). The child
// answers `tools/list` with 4 tools in a plain node process, and the identical
// seed + child combination works there too — inside `node --test`, frames
// written to the child's stdin never get an answer, same binary and bytes.
// Rather than keep chasing a test-runner/stdio interaction, this harness starts
// the child in HTTP mode and speaks JSON-RPC over POST /mcp. Verified under
// `node --test`: status 200, tools listed.
//
// The child process is still the unit under test: LIBRARY_COLLECTIONS IS the
// member boundary, so it has to live in the child's env, not in this process.
// Only the way calls travel changed.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test as baseTest } from "node:test";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

// A child left running keeps the runner alive; reap them all on teardown.
const liveChildren = new Set();
let reapArmed = false;
function reap(child) {
  liveChildren.delete(child);
  try { child.kill("SIGKILL"); } catch {}
  try { child.unref(); } catch {}
}
function armReapHook() {
  if (reapArmed) return;
  reapArmed = true;
  // Registered lazily (not at module top level) so it cannot interfere with
  // test() registration.
  after(() => { for (const child of [...liveChildren]) reap(child); });
}

async function freePort() {
  const net = await import("node:net");
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// Start library-mcp in HTTP mode for one member boundary and wait until it
// answers. `collections` is the member's LIBRARY_COLLECTIONS — the whole point.
async function startLibraryMcp(collections, dataDir) {
  const port = await freePort();
  const child = spawn(
    process.execPath,
    [path.join(ROOT, "server", "library-mcp.js")],
    {
      env: {
        ...process.env,
        DB_PATH: path.join(dataDir, "library.sqlite"),
        PLATFORM_DATA_DIR: dataDir,
        LIBRARY_COLLECTIONS: collections,
        LIBRARY_MCP_HTTP_PORT: String(port),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  liveChildren.add(child);
  armReapHook();
  const base = `http://127.0.0.1:${port}/mcp`;
  let reqId = 0;

  // Streamable-http answers JSON-RPC frames as an SSE `event: message` payload.
  const parse = (body, ct) => {
    if (/text\/event-stream/i.test(ct ?? "")) {
      const line = body.split("\n").find((l) => l.startsWith("data:"));
      return line ? JSON.parse(line.slice(5).trim()) : null;
    }
    try { return JSON.parse(body); } catch { return null; }
  };

  const rpc = async (method, params, timeoutMs = 8000) => {
    const id = ++reqId;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(base, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        signal: ctrl.signal,
      });
      const msg = parse(await res.text(), res.headers.get("content-type"));
      if (!msg) throw new Error(`${method}: unparseable response`);
      return msg;
    } finally {
      clearTimeout(timer);
    }
  };

  const tool = async (name, args) => {
    const res = await rpc("tools/call", { name, arguments: args ?? {} });
    return res?.result;
  };

  // Total budget, not "timeout per attempt × N": a slow boot must not outlast CI.
  const deadline = Date.now() + 20000;
  let ready = false;
  while (Date.now() < deadline) {
    try {
      const r = await rpc("tools/list", {}, 3000);
      if (r?.result?.tools?.length) { ready = true; break; }
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!ready) throw new Error("library-mcp never answered tools/list within 20s");

  return { child, tool, dispose: () => reap(child) };
}

async function seedLibrary(dir) {
  // Seed via the same modules the server uses — a separate one-shot node run
  // keeps the parent test process free of the better-sqlite3 handle.
  const script = `
    process.env.DB_PATH = ${JSON.stringify(path.join(dir, "library.sqlite"))};
    const db = await import(${JSON.stringify(path.join(ROOT, "db.js"))});
    await db.initDb();
    db.createCollection({ id: "col-a", name: "Alpha", description: "", created_at: new Date().toISOString(), project_id: null });
    // col-b is ATTRIBUTED to a project — NOT in the shared (unattributed) bucket,
    // so visibility genuinely hinges on the member's LIBRARY_COLLECTIONS pin.
    db.createCollection({ id: "col-b", name: "Beta", description: "", created_at: new Date().toISOString(), project_id: "proj-x" });
    db.upsertDocument({ id: "doc-1", name: "Alpha Doc", type: "txt", status: "ready", added_at: new Date().toISOString(), source_text: "alpha membership terms" });
    db.upsertDocument({ id: "doc-2", name: "Beta Doc", type: "txt", status: "ready", added_at: new Date().toISOString(), source_text: "beta membership terms" });
    // The FTS index: the real ingest path (documents.js) indexes chunks right
    // after storing source_text — search_library reads document_chunks, not
    // documents.source_text.
    const { chunkText } = await import(${JSON.stringify(path.join(ROOT, "documents-search.js"))});
    db.replaceDocumentChunks("doc-1", "Alpha Doc", chunkText("alpha membership terms"));
    db.replaceDocumentChunks("doc-2", "Beta Doc", chunkText("beta membership terms"));
    db.addDocumentToCollection("col-a", "doc-1");
    db.addDocumentToCollection("col-b", "doc-2");
    console.log("seeded");
  `;
  await new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ["--input-type=module", "-e", script], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    p.stdout.on("data", (c) => (out += c));
    p.stderr.on("data", (c) => (out += c));
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`seed failed (${code}): ${out.slice(-400)}`))));
  });
}

const text = (res) => String(res?.content?.[0]?.text ?? "");

const test = (name, options, fn) => baseTest(name, options ?? {}, fn);

test("member library boundary: out-of-bound collection reads answer 'does not exist'", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "kprofile-boundary-"));
  await seedLibrary(dir);
  const mcp = await startLibraryMcp("col-a", dir);
  try {
    // In-bound: col-a documents are reachable.
    const inList = await mcp.tool("list_library", { collection: "col-a" });
    assert.match(text(inList), /Alpha Doc/);

    // Out-of-bound collection: "does not exist" — the spec's no-existence-leak
    // wording, even though col-b exists in the DB.
    const outList = await mcp.tool("list_library", { collection: "col-b" });
    assert.match(text(outList), /does not exist/);

    // Out-of-bound document (through search post-filter and direct read).
    const search = await mcp.tool("search_library", { query: "beta" });
    assert.match(text(search), /No matches/);
    const read = await mcp.tool("read_document", { doc_id: "doc-2" });
    assert.match(text(read), /does not exist/);
  } finally {
    mcp.dispose();
  }
});

test("removing a collection from the member's env makes its documents invisible (next-turn effect)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "kprofile-remove-"));
  await seedLibrary(dir);
  // "Before": col-a+col-b stamped — doc-2 visible.
  const before = await startLibraryMcp("col-a,col-b", dir);
  try {
    const read = await before.tool("read_document", { doc_id: "doc-2" });
    assert.doesNotMatch(text(read), /does not exist/);
  } finally {
    before.dispose();
  }
  // "After" (the profile write invalidated the patch; the next turn composes a
  // member env without col-b): doc-2 gone — invisible, not forbidden.
  const narrowed = await startLibraryMcp("col-a", dir);
  try {
    const read = await narrowed.tool("read_document", { doc_id: "doc-2" });
    assert.match(text(read), /does not exist/);
    const list = await narrowed.tool("list_library", { collection: "col-b" });
    assert.match(text(list), /does not exist/);
  } finally {
    narrowed.dispose();
  }
});

test("adding a collection takes effect immediately on the next composition", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "kprofile-add-"));
  await seedLibrary(dir);
  const before = await startLibraryMcp("col-a", dir);
  try {
    const res = await before.tool("search_library", { query: "beta" });
    assert.match(text(res), /No matches/);
  } finally {
    before.dispose();
  }

  // The PUT /knowledge-profile → invalidateMemberPatchCache → next-turn compose
  // chain lands here as a restarted member env including col-b.
  const wide = await startLibraryMcp("col-a,col-b", dir);
  try {
    const res = await wide.tool("search_library", { query: "beta" });
    assert.match(text(res), /Beta Doc/);
    const read = await wide.tool("read_document", { doc_id: "doc-2" });
    assert.doesNotMatch(text(read), /does not exist/);
  } finally {
    wide.dispose();
  }
});
