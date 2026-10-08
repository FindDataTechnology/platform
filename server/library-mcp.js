// ── Library MCP server (stdio) ───────────────────────────────────────────────
//
// Exposes the document library to the dsh agent as three MCP tools —
// list_library, search_library, read_document — so a conversation retrieves
// library content on demand instead of having it injected wholesale (design
// D3/D4). Declared in mcp.json; dsh-profile.js mounts it through
// dsh-mcp-client as mcp__library__<tool>.
//
// Read-only by construction: it goes through the shared search module
// (documents-search.js) and never writes. It opens the same SQLite file the
// platform server writes — safe under WAL because reads here are short
// statements, and a crashed or killed child costs at most one tool call
// (dsh-mcp-client reconnects; the platform server never depends on it).

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import * as db from "../db.js";
import * as search from "../documents-search.js";

// The stdio channel IS the protocol: stdout must carry JSON-RPC and nothing
// else. db.js logs its open line via console.log — reroute logging to stderr
// before the DB opens (module side effects here run only at initDb below).
console.log = (...args) => console.error(...args);

// list_library keeps its answer bounded even against a large library: beyond
// this many docs the listing truncates with a marker (agents should narrow
// with search_library anyway).
const LIST_CAP = 200;

const TOOLS = [
  {
    name: "list_library",
    description:
      "List the documents in the platform's library, with id, name, type, and status. " +
      "With no arguments, also lists collections with their member document ids. " +
      "Use the ids with read_document/search_library.",
    inputSchema: {
      type: "object",
      properties: {
        collection: {
          type: "string",
          description: "Restrict the listing to one collection's member documents (collection id).",
        },
      },
    },
  },
  {
    name: "search_library",
    description:
      "Full-text search over the library's documents. Returns ranked chunk hits with " +
      "the document name, doc id, a locator (loc), and a snippet. Follow up with " +
      "read_document (optionally starting near a hit's loc) for full context.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Free-text query (terms are OR'd)." },
        collection: {
          type: "string",
          description: "Restrict the search to one collection's documents (collection id).",
        },
        doc: { type: "string", description: "Restrict the search to a single document id." },
        limit: { type: "number", description: "Max hits (1-20, default 10)." },
      },
      required: ["query"],
    },
  },
  {
    name: "read_document",
    description:
      "Read one document's extracted text, one page at a time (~8000 characters). " +
      "Pass the nextCursor from a previous call to continue reading.",
    inputSchema: {
      type: "object",
      properties: {
        doc_id: { type: "string", description: "Document id from list_library or a search hit." },
        cursor: {
          type: "number",
          description: "Start offset from a previous call's nextCursor (default 0).",
        },
      },
      required: ["doc_id"],
    },
  },
];

// ── Tool implementations (plain strings — the model reads text) ─────────────

function toolListLibrary({ collection } = {}) {
  if (!db.isDbReady()) return errOut("library unavailable (database not open)");
  if (collection && !db.getCollection(collection)) {
    return errOut(`collection ${collection} does not exist`);
  }
  const docs = collection
    ? db.listCollectionDocuments(collection)
    : db.listDocuments().slice(0, LIST_CAP);
  const truncated = !collection && db.listDocuments().length > LIST_CAP;
  const lines = [
    `Documents (${docs.length}${truncated ? ", listing truncated" : ""}):`,
    ...docs.map(
      (d) => `- ${JSON.stringify(d.name)} [id: ${d.id}] type=${d.type} status=${d.status}`,
    ),
  ];
  if (!collection) {
    const cols = db.listCollections();
    lines.push("", `Collections (${cols.length}):`);
    for (const c of cols) {
      const members = db
        .listCollectionDocuments(c.id)
        .map((m) => `${JSON.stringify(m.name)} (${m.id})`)
        .join(", ");
      lines.push(`- ${JSON.stringify(c.name)} [id: ${c.id}] (${c.documentCount} docs): ${members || "(empty)"}`);
    }
  }
  return textOut(lines.join("\n"));
}

function toolSearchLibrary({ query, collection, doc, limit } = {}) {
  if (!db.isDbReady()) return errOut("library unavailable (database not open)");
  const hits = search.searchLibrary(String(query ?? ""), {
    collectionId: collection || null,
    docId: doc || null,
    limit: Number(limit) || 10,
  });
  if (!hits.length) return textOut(`No matches for ${JSON.stringify(String(query))}.`);
  return textOut(
    hits
      .map((h) => `- ${JSON.stringify(h.name)} [doc_id: ${h.docId}, loc: ${h.loc}]: ${h.snippet}`)
      .join("\n"),
  );
}

function toolReadDocument({ doc_id, cursor } = {}) {
  if (!db.isDbReady()) return errOut("library unavailable (database not open)");
  const page = search.readDocumentPage(String(doc_id ?? ""), Number(cursor) || 0);
  if (page.error) return errOut(page.error);
  const header = `(${JSON.stringify(page.name)}, ${page.text.length} chars of ${page.total} total)`;
  const next = page.nextCursor != null ? `\n[next_cursor: ${page.nextCursor}]` : "\n[end of document]";
  return textOut(`${header}\n${page.text}${next}`);
}

function textOut(text) {
  return { content: [{ type: "text", text }] };
}
function errOut(message) {
  return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}

// ── Server wiring ────────────────────────────────────────────────────────────

// A fresh Server per transport: stdio uses one for the process lifetime; the
// http mode below connects one per request (the SDK's stateless pattern — a
// Server instance refuses a second connect).
function buildServer() {
  const server = new Server(
    { name: "library", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args = {} } = req.params ?? {};
    try {
      switch (name) {
        case "list_library":
          return toolListLibrary(args);
        case "search_library":
          return toolSearchLibrary(args);
        case "read_document":
          return toolReadDocument(args);
        default:
          return errOut(`unknown tool: ${name}`);
      }
    } catch (err) {
      return errOut(err.message || "tool failed");
    }
  });

  return server;
}

// Open the database read-side, then serve until stdio closes. A DB failure is
// fatal for the child but never for the platform — the agent sees tool errors
// and dsh-mcp-client handles restarts.
await db.initDb();

// Stdio is the default (dsh mounts it via mcp.json). With LIBRARY_MCP_HTTP_PORT
// set, the same tools are also served over streamable-http at /mcp — used to
// expose the library to external MCP clients (e.g. behind an
// mcp-gateway-registry). Stateless: POST-only, one transport per request.
const httpPort = Number(process.env.LIBRARY_MCP_HTTP_PORT || 0);
if (httpPort > 0) {
  const { StreamableHTTPServerTransport } = await import(
    "@modelcontextprotocol/sdk/server/streamableHttp.js"
  );
  const http = await import("node:http");

  const readBody = (req) =>
    new Promise((resolve, reject) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString();
        resolve(raw.length ? JSON.parse(raw) : undefined);
      });
      req.on("error", reject);
    });

  const serve = http.createServer(async (req, res) => {
    if (req.url.split("?")[0] !== "/mcp") {
      res.writeHead(404).end();
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405, { Allow: "POST" }).end();
      return;
    }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => transport.close());
    try {
      const body = await readBody(req);
      await buildServer().connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      console.error(`[library-mcp] http request failed: ${err.message}`);
      if (!res.headersSent) res.writeHead(500).end();
    }
  });
  await new Promise((resolve) => serve.listen(httpPort, "0.0.0.0", resolve));
  console.error(`[library-mcp] streamable-http listening on 0.0.0.0:${httpPort}/mcp`);
} else {
  await buildServer().connect(new StdioServerTransport());
}
