// Documents + collections REST API (local-extraction library).
// Ingests PDF, Markdown, text, URL, DOCX, XLSX, PPTX, CSV, HTML with local
// text extraction and SQLite persistence — no LLM pipeline. The add route
// responds with the TERMINAL status (ready, or 422 + message on extraction
// failure). Status transitions still broadcast as documents_status WS events
// as a consistency mechanism.

import { removeUploadDir, saveUploadFile } from "./files.js";
// The semantic-rung settings live in the search module, not in documents.js:
// they gate retrieval and embedding, not ingestion.
import * as librarySearch from "../../documents-search.js";

export function registerDocumentRoutes(ctx) {
  const { app, db, documents, collections, upload } = ctx;

  app.post("/api/documents", upload.single("file"), async (req, res) => {
    // The accountless demo pod accepts no uploads (openspec: mp-demo-sandbox):
    // anonymous visitors must not be able to fill the ephemeral disk, and the
    // prompt cap cannot bound upload traffic. Chat and agents stay open.
    if (ctx.DEMO_SANDBOX) {
      return res.status(403).json({ error: "演示环境不支持上传文档；绑定账号后可在完整平台使用" });
    }
    if (!db.isDbReady()) {
      return res.status(503).json({ error: "Document collection is disabled (database unavailable)" });
    }
    try {
      const { id, name, type } = req.body;
      if (!req.file && !type) {
        return res.status(400).json({ error: "Missing file or type" });
      }

      const result = await documents.addDocument({
        id,
        name: req.file ? req.file.originalname : name,
        type: req.file ? documents.typeForFilename(req.file.originalname) : type,
        buffer: req.file?.buffer,
        content: req.body.content,
        url: req.body.url,
      });

      // Persist the original alongside ingestion so the composer chip can
      // preview it. addDocument returns an id on BOTH outcomes, so the file is
      // stored even when extraction failed — the case where a user most wants
      // to open the source. Best-effort: a write failure must not fail the
      // attachment, whose real job (ingestion) already happened.
      let preview = null;
      if (req.file) {
        try {
          preview = await saveUploadFile(req.file.buffer, req.file.originalname, result.id);
        } catch (err) {
          console.error(`[documents] storing attachment original failed: ${err.message}`);
        }
      }

      // Extraction failed: the row persists as `error` (visible in the list);
      // 422 lets the client attachment chip show the failure.
      if (result.status === "error") {
        return res.status(422).json({ error: result.error, id: result.id, status: "error", preview });
      }
      res.json({ ...result, preview });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  app.get("/api/documents", (_req, res) => {
    res.json({ documents: documents.listDocuments() });
  });

  app.get("/api/documents/:id", async (req, res) => {
    try {
      const content = await documents.getDocumentContent(req.params.id);
      if (content === null) return res.status(404).json({ error: "Not found" });
      res.json({ content });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  app.delete("/api/documents/:id", async (req, res) => {
    const removed = await documents.removeDocument(req.params.id);
    // Removing the document removes its stored attachment original too, so a
    // delete never orphans bytes on disk (idempotent; refuses unsafe keys).
    // Best-effort AND guarded: Express 4 does not catch a rejected async
    // handler, and nothing upstream handles unhandled rejections, so an fs
    // error here (EBUSY while the preview still streams the file, EPERM) would
    // take the whole server down for a delete that already succeeded.
    await removeUploadDir(req.params.id).catch((err) => {
      console.error(`[documents] removing stored original failed: ${err.message}`);
    });
    res.status(removed ? 200 : 404).json({ removed });
  });

  // ── Collections REST API routes (named document groups) ───────────────────
  // Collections organize library documents into named groups: chat-starting
  // selections and scoping filters for the agent's library tools.

  app.get("/api/collections", (req, res) => {
    // projectId query: absent = every collection (default view, unchanged);
    // "default" = the unattributed (默认项目) bucket; an id = that project.
    const q = req.query?.projectId;
    const projectId = q === undefined ? undefined : q === "default" ? null : String(q);
    res.json({ collections: collections.listCollections(projectId === undefined ? {} : { projectId }) });
  });

  app.post("/api/collections", async (req, res) => {
    const { name, description, projectId } = req.body;
    if (!name) return res.status(400).json({ error: "Missing name" });
    try {
      const collection = await collections.createCollection({ name, description, projectId: projectId ?? null });
      res.json(collection);
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  app.patch("/api/collections/:id", async (req, res) => {
    const { name, description } = req.body;
    try {
      const collection = await collections.renameCollection(req.params.id, { name, description });
      res.json(collection);
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  app.delete("/api/collections/:id", async (req, res) => {
    await collections.deleteCollection(req.params.id);
    res.json({ ok: true });
  });

  app.get("/api/collections/:id/documents", async (req, res) => {
    try {
      const docs = await collections.listCollectionDocuments(req.params.id);
      res.json({ documents: docs });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  app.post("/api/collections/:id/documents", async (req, res) => {
    const { documentId } = req.body;
    if (!documentId) return res.status(400).json({ error: "Missing documentId" });
    try {
      await collections.addDocument(req.params.id, documentId);
      res.json({ ok: true });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  app.delete("/api/collections/:id/documents/:documentId", async (req, res) => {
    await collections.removeDocument(req.params.id, req.params.documentId);
    res.json({ ok: true });
  });

  // ── Semantic rung settings (add-library-semantic-rung 4.1/4.2) ────────────
  //
  // The rung sends chunk text to an external embedding lane, so it is OFF until
  // the owner says so after seeing the disclosure. GET reports the full state
  // (including WHY it cannot be enabled); PUT requires `acknowledged: true`
  // alongside `enabled: true` — consent that was not asked for is not consent.

  app.get("/api/library/semantic-rung", (_req, res) => {
    res.json({
      state: librarySearch.semanticOptInState(),
      usage: librarySearch.embedUsage(),
      footprint: librarySearch.estimateVectorFootprint(),
    });
  });

  app.put("/api/library/semantic-rung", async (req, res) => {
    const { enabled, acknowledged } = req.body ?? {};
    if (typeof enabled !== "boolean") {
      return res.status(400).json({ error: "enabled (boolean) is required" });
    }
    const out = librarySearch.setSemanticOptIn(enabled, { acknowledged: acknowledged === true });
    if (!out.ok) return res.status(409).json({ error: out.reason, disclosure: out.disclosure });
    // Turning it on starts draining the backlog; a bounded pass keeps the request
    // fast and the rest is picked up by the next pass.
    let backfill = null;
    if (out.state?.enabled) {
      try {
        backfill = await librarySearch.backfillVectors();
      } catch (err) {
        backfill = { status: "failed", error: err.message };
      }
    }
    res.json({ ok: true, state: out.state, backfill, usage: librarySearch.embedUsage() });
  });
}
