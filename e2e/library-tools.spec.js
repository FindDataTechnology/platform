import { test, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Library index + MCP tools integration (rebuild-knowledge-as-file-library).
//
// Self-contained on purpose: this spec does NOT round-trip through the
// playwright webServer. It runs the REAL ingest in-process (documents.js
// against a private SQLite file), then drives the library MCP child
// (stdio JSON-RPC) over that same file — worker process and its spawned
// children share one filesystem view, which cannot be assumed across the
// webServer boundary in every environment. The REST surface is covered by
// documents-react.spec.js (UI) against the webServer.

const MARKER = "WUMPUS-CORPUS-MARKER-778899";

test.describe("library index + tools", () => {
  let dbDir;
  let db;
  let search;
  let documents;
  let docId;

  test.beforeAll(async () => {
    dbDir = mkdtempSync(path.join(os.tmpdir(), "paas-lib-tools-"));
    process.env.DB_PATH = path.join(dbDir, "app.db");
    db = await import("../db.js");
    await db.initDb();
    search = await import("../documents-search.js");
    documents = await import("../documents.js");
    await documents.initStore({ broadcast: () => {} });

    // Real ingest through the production path: local extraction + chunking.
    const r = await documents.addDocument({
      type: "markdown",
      name: "searchable.md",
      content: `# Searchable Doc\n\nThe quick brown fox jumps over the lazy dog near the riverbank.\n\n## Notes\n\n${MARKER} body text that must never be injected wholesale into a prompt.`,
    });
    expect(r.status).toBe("ready");
    docId = r.id;
  });

  test.afterAll(() => {
    rmSync(dbDir, { recursive: true, force: true });
  });

  test("ingest chunks are searchable through the MCP tools", async () => {
    const mcp = await McpChild.start(dbDir);
    const tools = await mcp.call("tools/list", {});
    expect(tools.result.tools.map((t) => t.name)).toEqual([
      "list_library",
      "search_library",
      "read_document",
    ]);

    const list = await mcp.call("tools/call", { name: "list_library", arguments: {} });
    expect(list.result.content[0].text).toContain("searchable.md");
    expect(list.result.content[0].text).toContain("status=ready");

    const hit = await mcp.call("tools/call", {
      name: "search_library",
      arguments: { query: "riverbank" },
    });
    expect(hit.result.content[0].text).toContain("searchable.md");
    expect(hit.result.content[0].text).toContain("riverbank");

    const none = await mcp.call("tools/call", {
      name: "search_library",
      arguments: { query: "京都" },
    });
    expect(none.result.content[0].text).toMatch(/^No matches/);

    const page = await mcp.call("tools/call", {
      name: "read_document",
      arguments: { doc_id: docId },
    });
    expect(page.result.content[0].text).toContain("Searchable Doc");
    expect(page.result.content[0].text).toContain("[end of document]");

    const bad = await mcp.call("tools/call", {
      name: "read_document",
      arguments: { doc_id: "does-not-exist" },
    });
    expect(bad.result.isError).toBe(true);
    await mcp.stop();
  });

  test("deleting the document removes its chunks from search", async () => {
    await documents.removeDocument(docId);
    expect(search.searchLibrary("riverbank")).toEqual([]);
    const mcp = await McpChild.start(dbDir);
    const hit = await mcp.call("tools/call", {
      name: "search_library",
      arguments: { query: "riverbank" },
    });
    expect(hit.result.content[0].text).toMatch(/^No matches/);
    await mcp.stop();
  });

  test("@doc:/@collection: expansions carry light context, not source text", async () => {
    // Body larger than the 220-char summary window, with the marker placed
    // well past it — its absence proves only the bounded summary is injected.
    const filler = "R".repeat(600);
    const r = await documents.addDocument({
      type: "markdown",
      name: "expand-me.md",
      content: `# Expand Me\n\nShort intro line.\n\n${filler}\n\n${MARKER} deep in the body.`,
    });
    db.createCollection({
      id: "col-x",
      name: "Xpand Set",
      description: null,
      created_at: new Date().toISOString(),
    });
    db.addDocumentToCollection("col-x", r.id);

    const { expandDocRefs } = await import("../server/skills.js");
    const docOut = await expandDocRefs({ db }, `@doc:${r.id} please summarize`);
    expect(docOut).toContain("summary:");
    expect(docOut).toContain("mcp__library__read_document");
    expect(docOut).not.toContain(MARKER); // body beyond the summary stays out
    expect(docOut).not.toContain(filler);
    expect(docOut).toContain("please summarize"); // the user's words stay

    const colOut = await expandDocRefs({ db }, `@collection:col-x and go`);
    expect(colOut).toContain("1 document(s)");
    expect(colOut).toContain("mcp__library__search_library");

    const unknown = await expandDocRefs({ db }, "@doc:missing-id what is this");
    expect(unknown).toContain("unavailable");
  });
});

// Minimal MCP stdio client for the spec: newline-delimited JSON-RPC, one
// pending promise per id. Mirrors what dsh-mcp-client does on the real path.
class McpChild {
  static async start(dbDir) {
    const child = spawn("node", ["server/library-mcp.js"], {
      env: { ...process.env, DB_PATH: path.join(dbDir, "app.db") },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const mcp = new McpChild(child);
    child.stdout.on("data", mcp.#onData);
    child.stderr.on("data", () => {}); // db.js open line etc. — stderr is fine
    const init = await mcp.call("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "e2e-probe", version: "0" },
    });
    expect(init.result.serverInfo.name).toBe("library");
    await mcp.notify("notifications/initialized", {});
    return mcp;
  }

  #child;
  #buf = "";
  #pending = new Map();
  #nextId = 1;

  constructor(child) {
    this.#child = child;
  }

  #onData = (chunk) => {
    this.#buf += chunk.toString();
    for (;;) {
      const nl = this.#buf.indexOf("\n");
      if (nl < 0) break;
      const line = this.#buf.slice(0, nl);
      this.#buf = this.#buf.slice(nl + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      if (msg.id != null && this.#pending.has(msg.id)) {
        this.#pending.get(msg.id)(msg);
        this.#pending.delete(msg.id);
      }
    }
  };

  call(method, params) {
    return this.#send(method, params, false);
  }

  notify(method, params) {
    return this.#send(method, params, true);
  }

  #send(method, params, isNotification) {
    return new Promise((resolve) => {
      const id = this.#nextId++;
      if (!isNotification) this.#pending.set(id, resolve);
      this.#child.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", ...(isNotification ? {} : { id }), method, params }) + "\n",
      );
      if (isNotification) resolve();
    });
  }

  async stop() {
    this.#child.kill();
    await new Promise((r) => this.#child.once("exit", r));
  }
}
