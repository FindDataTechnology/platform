// ── Document collections ──────────────────────────────────────────────────────
//
// Named groups of documents. Collections and their memberships persist in the
// project SQLite database (db.js). Collection CRUD + membership management are
// thin wrappers over the db helpers. A collection is a chat-starting selection
// ("Start conversation" hands its members to the chat composer) and an optional
// scoping filter for the agent's library search tool — there is no
// collection-scoped RAG query anymore.
//
// Deleting a document cascade-removes its memberships (FK ON DELETE CASCADE);
// deleting a collection removes its memberships but leaves documents intact.

import { randomUUID } from "node:crypto";
import * as db from "./db.js";

function notFound(msg) {
  return Object.assign(new Error(msg), { status: 404 });
}

export function listCollections() {
  return db.listCollections();
}

export function getCollection(id) {
  return db.getCollection(id);
}

export function createCollection({ name, description }) {
  const id = randomUUID();
  const now = new Date().toISOString();
  db.createCollection({ id, name: (name || "").trim() || "Untitled collection", description: description || null, created_at: now });
  return db.getCollection(id);
}

export function renameCollection(id, { name, description }) {
  const existing = db.getCollection(id);
  if (!existing) throw notFound("Collection not found");
  db.renameCollection(id, {
    name: name != null ? ((name || "").trim() || existing.name) : existing.name,
    description: description != null ? (description || null) : existing.description,
  });
  return db.getCollection(id);
}

export function deleteCollection(id) {
  // Idempotent: deleting a missing collection succeeds.
  db.deleteCollection(id);
}

export function listMembers(collectionId) {
  if (!db.getCollection(collectionId)) throw notFound("Collection not found");
  return db.listCollectionDocuments(collectionId);
}

// Add a document to a collection. Idempotent (INSERT OR IGNORE). Throws 404 if
// the collection or document does not exist. Returns the updated collection.
export function addDocument(collectionId, documentId) {
  if (!db.getCollection(collectionId)) throw notFound("Collection not found");
  if (!db.documentExists(documentId)) throw notFound("Document not found");
  db.addDocumentToCollection(collectionId, documentId);
  return db.getCollection(collectionId);
}

// Remove a document from a collection. Idempotent (no error if not a member).
export function removeDocument(collectionId, documentId) {
  db.removeDocumentFromCollection(collectionId, documentId);
}
