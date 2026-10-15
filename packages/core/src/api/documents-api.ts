// Client wrappers for the document + collection REST endpoints.
// Mirrors the vanilla app.js behavior but typed and React-friendly.

import { http, type HttpResponse } from "./http";
// The reference the read-only serving route resolves ({root,rel} of a stored
// file). Defined once in lib/file-ref (shared with the mini program's file
// chip); the document API is just another producer of them.
import type { FileRef } from "../lib/file-ref";

export type { FileRef } from "../lib/file-ref";

export interface DocMeta {
  id: string;
  name: string;
  type: string;
  status: "queued" | "indexing" | "ready" | "error";
  error?: string;
  addedAt?: string;
  // Where the upload's original was stored for the preview drawer. Present
  // whenever the request carried a file — including on extraction failure.
  preview?: FileRef | null;
}

export interface CollectionMeta {
  id: string;
  name: string;
  description?: string;
  documentCount?: number;
  createdAt?: string;
}

async function jsonOrThrow<T>(res: HttpResponse): Promise<T> {
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { const j = await res.json(); if (j?.error) msg = j.error; } catch { /* ignore */ }
    throw new Error(msg);
  }
  return res.json() as Promise<T>;
}

export async function listDocuments(): Promise<DocMeta[]> {
  const r = await http("/api/documents");
  const j = await jsonOrThrow<{ documents: DocMeta[] }>(r);
  return j.documents ?? [];
}

export async function getDocumentContent(id: string): Promise<string> {
  const r = await http(`/api/documents/${encodeURIComponent(id)}`);
  const j = await jsonOrThrow<{ content: string }>(r);
  return j.content ?? "";
}

export async function deleteDocument(id: string): Promise<void> {
  const r = await http(`/api/documents/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
}

export async function uploadFile(file: File, signal?: AbortSignal): Promise<DocMeta> {
  const fd = new FormData();
  fd.append("file", file);
  const r = await http("/api/documents", { method: "POST", body: fd, signal });
  if (!r.ok) {
    // A failed extraction still stored the original, so carry its preview
    // reference on the thrown error — the chip stays previewable even when
    // indexing failed. jsonOrThrow would discard this response body.
    let body: { error?: string; preview?: FileRef } | null = null;
    try {
      body = await r.json();
    } catch {
      /* non-JSON error body */
    }
    const err = new Error(body?.error || `HTTP ${r.status}`) as Error & { preview?: FileRef };
    if (body?.preview) err.preview = body.preview;
    throw err;
  }
  return r.json() as Promise<DocMeta>;
}

export async function addText(content: string, name?: string): Promise<DocMeta> {
  const r = await http("/api/documents", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "text", content, name }),
  });
  return jsonOrThrow<DocMeta>(r);
}

export async function addUrl(url: string, name?: string): Promise<DocMeta> {
  const r = await http("/api/documents", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "url", url, name }),
  });
  return jsonOrThrow<DocMeta>(r);
}

// ── Collections ──

export async function listCollections(): Promise<CollectionMeta[]> {
  const r = await http("/api/collections");
  const j = await jsonOrThrow<{ collections: CollectionMeta[] }>(r);
  return j.collections ?? [];
}

export async function createCollection(name: string, description?: string): Promise<CollectionMeta> {
  const r = await http("/api/collections", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, description }),
  });
  const j = await jsonOrThrow<{ collection: CollectionMeta }>(r);
  return j.collection;
}

export async function deleteCollection(id: string): Promise<void> {
  const r = await http(`/api/collections/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
}

export async function listCollectionMembers(id: string): Promise<DocMeta[]> {
  const r = await http(`/api/collections/${encodeURIComponent(id)}/documents`);
  const j = await jsonOrThrow<{ documents: DocMeta[] }>(r);
  return j.documents ?? [];
}

export async function addDocumentToCollection(id: string, documentId: string): Promise<void> {
  const r = await http(`/api/collections/${encodeURIComponent(id)}/documents`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ documentId }),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
}
