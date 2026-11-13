// ── Library MCP server (stdio) ───────────────────────────────────────────────
//
// Exposes the document library to the dsh agent as four MCP tools —
// list_library, search_library, read_document, fetch_document_file — so a
// conversation retrieves library content on demand instead of having it
// injected wholesale (design D3/D4). Declared in mcp.json; dsh-profile.js
// mounts it through dsh-mcp-client as mcp__library__<tool>.
//
// Read-only on the library side by construction: it goes through the shared
// search module (documents-search.js) and never writes the database or the
// uploads root. The one write it performs is fetch_document_file copying a
// retained original INTO the agent workspace (add-doc-studio) — workspace
// writes are the agent's home turf, not library state. It opens the same
// SQLite file the platform server writes — safe under WAL because reads here
// are short statements, and a crashed or killed child costs at most one tool
// call (dsh-mcp-client reconnects; the platform server never depends on it).

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import * as db from "../db.js";
import * as search from "../documents-search.js";
import { storeDir } from "../paths.js";
import {
  OriginalNotRetainedError,
  resolveWorkspaceDir,
  storeOriginalInWorkspace,
} from "./library-fetch.js";

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
  {
    name: "fetch_document_file",
    description:
      "Copy a document's ORIGINAL uploaded file (docx, xlsx, pdf, …) from the library " +
      "into the agent workspace under its filename, and return the workspace-relative " +
      "path. Use it when the task needs the real file — editing an uploaded document, " +
      "reformatting, extracting tables — rather than the extracted text from " +
      "read_document. Fails explicitly when the original was not retained (e.g. a " +
      "URL-ingested source).",
    inputSchema: {
      type: "object",
      properties: {
        doc_id: { type: "string", description: "Document id from list_library or a search hit." },
      },
      required: ["doc_id"],
    },
  },
];

// ── Tool implementations (plain strings — the model reads text) ─────────────

// Retrieval boundary (add-knowledge-memory-surface, design D2): the TOOL SERVER
// enforces the turn's project boundary — prompt text is not a boundary. The
// project id arrives as a server-set env var (the lane that spawns this child
// stamps it); absent = no project context = the pre-change whole-account view.
// Bounded view = this project's collections ∪ unattributed (NULL) collections.
// Reads outside answer "does not exist" — never "forbidden", which would
// confirm existence to a caller that must not know about it.
const PROJECT_ID = (process.env.LIBRARY_PROJECT_ID || "").trim() || null;

// Collection whitelist (add-knowledge-memory-surface 3.2): a KB-pinned agent
// (blueprint dataSources `library:<id>`, materialized) gets EXACTLY those
// collections ∪ shared — narrower than a project boundary. Takes precedence
// over LIBRARY_PROJECT_ID when both are present.
const COLLECTION_IDS = (process.env.LIBRARY_COLLECTIONS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function boundedCollectionIds() {
  if (COLLECTION_IDS.length > 0) {
    // Spec: a pinned member sees the pinned collections ∪ SHARED (unattributed)
    // — same shared bucket the project boundary unions with.
    const shared = db.listCollections({ projectId: null }).map((c) => c.id);
    return new Set([...COLLECTION_IDS, ...shared]);
  }
  if (!PROJECT_ID) return null; // null = unbounded (whole account library)
  const mine = db.listCollections({ projectId: PROJECT_ID }).map((c) => c.id);
  const shared = db.listCollections({ projectId: null }).map((c) => c.id);
  return new Set([...mine, ...shared]);
}

function isDocInBoundary(docId) {
  const allowed = boundedCollectionIds();
  if (!allowed) return true;
  // In-boundary = belongs to an allowed collection, OR belongs to no collection
  // at all (a loose library doc is account-level, like the shared bucket).
  const memberships = db
    .listCollections()
    .filter((c) => db.listCollectionDocuments(c.id).some((d) => d.id === docId))
    .map((c) => c.id);
  if (memberships.length === 0) return true;
  return memberships.some((id) => allowed.has(id));
}

function toolListLibrary({ collection } = {}) {
  if (!db.isDbReady()) return errOut("library unavailable (database not open)");
  const allowed = boundedCollectionIds();
  if (collection && !db.getCollection(collection)) {
    return errOut(`collection ${collection} does not exist`);
  }
  // Out-of-bound collection reads answer "does not exist" (no existence leak).
  if (collection && allowed && !allowed.has(collection)) {
    return errOut(`collection ${collection} does not exist`);
  }
  let docs = collection
    ? db.listCollectionDocuments(collection)
    : db.listDocuments().slice(0, LIST_CAP);
  if (!collection && allowed) {
    // Whole-library listing under a boundary: keep docs reachable through an
    // allowed collection (plus loose docs), drop the rest.
    const reachable = new Set();
    for (const id of allowed) {
      for (const d of db.listCollectionDocuments(id)) reachable.add(d.id);
    }
    const collected = new Set(
      db.listCollections().flatMap((c) => db.listCollectionDocuments(c.id).map((d) => d.id)),
    );
    docs = docs.filter((d) => reachable.has(d.id) || !collected.has(d.id));
  }
  const truncated = !collection && db.listDocuments().length > LIST_CAP;
  const lines = [
    `Documents (${docs.length}${truncated ? ", listing truncated" : ""}):`,
    ...docs.map(
      (d) => `- ${JSON.stringify(d.name)} [id: ${d.id}] type=${d.type} status=${d.status}`,
    ),
  ];
  if (!collection) {
    const cols = db.listCollections().filter((c) => !allowed || allowed.has(c.id));
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

async function toolSearchLibrary({ query, collection, doc, limit } = {}) {
  if (!db.isDbReady()) return errOut("library unavailable (database not open)");
  const allowed = boundedCollectionIds();
  if (collection && allowed && !allowed.has(collection)) {
    return errOut(`collection ${collection} does not exist`);
  }
  if (doc && !isDocInBoundary(String(doc))) {
    return errOut(`document ${JSON.stringify(String(doc))} does not exist`);
  }
  const lexical = search.searchLibrary(String(query ?? ""), {
    collectionId: collection || null,
    docId: doc || null,
    limit: Number(limit) || 10,
  });
  // Semantic rung: opt-in, and it can only ever ADD candidates or be absent —
  // never replace the lexical answer. A lane failure downgrades the label, it
  // does not turn a working search into an error.
  const semantic = await search.semanticHits(String(query ?? ""), {
    collectionId: collection || null,
    docId: doc || null,
    limit: Number(limit) || 10,
  });
  const hits = semantic.ok
    ? search.fuseRrf(lexical, semantic.hits, Number(limit) || 10)
    : lexical;
  // Post-filter hits that landed outside the boundary: search spans the whole
  // index, the boundary decides what this caller may see.
  const visible = allowed ? hits.filter((h) => isDocInBoundary(String(h.docId))) : hits;
  // Which rung answered, stated rather than implied. This build has no semantic
  // tier, so the rung is always `keyword`; `via` says whether that was the
  // ranked trigram/unicode61 path or the unranked LIKE escape hatch — an
  // unranked answer must not look like a ranked one.
  //
  // The empty case keeps the label too (library-semantic-rung R3): "no matches"
  // and "no matches BECAUSE the lane was down" must not read as the same thing.
  // Dropping the header here made a degraded search indistinguishable from a
  // clean one — the exact conflation the contract forbids.
  const header = search.rungHeader(visible, semantic);
  if (!visible.length) {
    return textOut(`${header}\nNo matches for ${JSON.stringify(String(query))}.`);
  }
  return textOut(
    [header]
      .concat(
        visible.map(
          (h) => `- ${JSON.stringify(h.name)} [doc_id: ${h.docId}, loc: ${h.loc}]: ${h.snippet}`,
        ),
      )
      .join("\n"),
  );
}

function toolReadDocument({ doc_id, cursor } = {}) {
  if (!db.isDbReady()) return errOut("library unavailable (database not open)");
  const id = String(doc_id ?? "");
  // Out-of-bound reads answer exactly like an unknown id (no existence leak).
  if (!isDocInBoundary(id)) return errOut(`document ${JSON.stringify(id)} does not exist`);
  const page = search.readDocumentPage(id, Number(cursor) || 0);
  if (page.error) return errOut(page.error);
  const header = `(${JSON.stringify(page.name)}, ${page.text.length} chars of ${page.total} total)`;
  const next = page.nextCursor != null ? `\n[next_cursor: ${page.nextCursor}]` : "\n[end of document]";
  return textOut(`${header}\n${page.text}${next}`);
}

// Not gated on db.isDbReady the way the readers are: the DB tiers in only as
// the workspace-preference lookup, and an unavailable database degrades to the
// cwd tier rather than disabling the tool.
async function toolFetchDocumentFile({ doc_id } = {}) {
  const id = String(doc_id ?? "").trim();
  if (!id) return errOut("fetch_document_file requires doc_id");
  if (!db.isDbReady()) return errOut("library unavailable (database not open)");
  // Boundary applies here too — otherwise bytes become an existence oracle.
  if (!isDocInBoundary(id)) return errOut(`document ${JSON.stringify(id)} does not exist`);
  const doc = db.getDocument(id);
  if (!doc) return errOut(`document ${JSON.stringify(id)} does not exist`);
  try {
    const ws = await resolveWorkspaceDir({ getPreference: (k) => db.getPreference(k) });
    const rel = await storeOriginalInWorkspace({ doc, uploadsRoot: storeDir("uploads"), workspaceDir: ws.path });
    return textOut(`Saved original (${doc.name}) into the workspace: ${rel} (workspace source=${ws.source})`);
  } catch (err) {
    if (err instanceof OriginalNotRetainedError) return errOut(err.message);
    throw err;
  }
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
          return await toolSearchLibrary(args);
        case "read_document":
          return toolReadDocument(args);
        case "fetch_document_file":
          return await toolFetchDocumentFile(args);
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
