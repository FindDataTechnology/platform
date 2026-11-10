// Documents + collections state. Fetches REST on mount; subscribes to the
// `documents_status` WS event (forwarded by useWebSocket) for live status.
// No query state lives here — Q&A is the chat window's job (attachments +
// the agent's library tools).
import { create } from "zustand";
import * as api from "@platform/core";
import type { DocMeta, CollectionMeta } from "@platform/core";
import type { ServerMessage } from "@platform/core";

interface DocumentsState {
  documents: DocMeta[];
  collections: CollectionMeta[];
  loading: boolean;
  error: string | null;
  selectedDocId: string | null;
  selectedDocContent: string | null;

  load: () => Promise<void>;
  refreshDocs: () => Promise<void>;
  selectDoc: (id: string | null) => Promise<void>;
  applyEvent: (msg: ServerMessage) => void;
}

export const useDocumentsStore = create<DocumentsState>((set) => ({
  documents: [],
  collections: [],
  loading: false,
  error: null,
  selectedDocId: null,
  selectedDocContent: null,

  load: async () => {
    set({ loading: true, error: null });
    try {
      const [documents, collections] = await Promise.all([
        api.listDocuments(),
        api.listCollections(),
      ]);
      set({ documents, collections, loading: false });
    } catch (err) {
      set({ error: (err as Error).message, loading: false });
    }
  },

  refreshDocs: async () => {
    try {
      const documents = await api.listDocuments();
      set({ documents });
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },

  selectDoc: async (id) => {
    if (id === null) {
      set({ selectedDocId: null, selectedDocContent: null });
      return;
    }
    set({ selectedDocId: id, selectedDocContent: null });
    try {
      const content = await api.getDocumentContent(id);
      set({ selectedDocContent: content });
    } catch (err) {
      set({ selectedDocContent: `Error: ${(err as Error).message}` });
    }
  },

  applyEvent: (msg) => {
    if (msg.type !== "documents_status") return;
    const { id, status, error } = msg as unknown as { id: string; status: string; error?: string };
    set((s) => ({
      documents: s.documents.map((d) =>
        d.id === id ? { ...d, status: status as DocMeta["status"], error } : d,
      ),
    }));
  },
}));

// Dev/test hook: expose the store on window so tests can seed library rows
// without real uploads. Same gating as __chatStore — dev or e2e builds only,
// never shipped.
if (typeof window !== "undefined" && (import.meta.env.DEV || import.meta.env.VITE_E2E_SEAM === "1")) {
  (window as unknown as { __documentsStore?: typeof useDocumentsStore }).__documentsStore =
    useDocumentsStore;
}
