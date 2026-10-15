// Documents + collections REST API (local-extraction library).
// Ingests PDF, Markdown, text, URL, DOCX, XLSX, PPTX, CSV, HTML with local
// text extraction and SQLite persistence — no LLM pipeline. The add route
// responds with the TERMINAL status (ready, or 422 + message on extraction
// failure). Status transitions still broadcast as documents_status WS events
// as a consistency mechanism.

import { removeUploadDir, saveUploadFile } from "./files.js";

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

  app.get("/api/collections", (_req, res) => {
    res.json({ collections: collections.listCollections() });
  });

  app.post("/api/collections", async (req, res) => {
    const { name, description } = req.body;
    if (!name) return res.status(400).json({ error: "Missing name" });
    try {
      const collection = await collections.createCollection({ name, description });
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
      await collections.addDocumentToCollection(req.params.id, documentId);
      res.json({ ok: true });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  app.delete("/api/collections/:id/documents/:documentId", async (req, res) => {
    await collections.removeDocumentFromCollection(req.params.id, req.params.documentId);
    res.json({ ok: true });
  });
}
