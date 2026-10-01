// Resource library state (openspec: add-resource-library).
//
// REST owns the data; the `resources_changed` WS event triggers a REFETCH of
// the current query instead of a client-side merge — library lists are small
// and keeping filtering/paging in one place removes all merge logic. Events
// are coalesced: one assistant turn with three charts is three captures, and
// the page needs one refresh.
//
// The store is also the "already in the library" oracle the chat's save
// affordance consults before offering a save.

import { create } from "zustand";
import * as api from "@platform/core";
import type { Resource, ServerMessage } from "@platform/core";

export type ResourceTypeFilter = "all" | "chart" | "file";

const PAGE = 60;
// Capture bursts (a turn with several charts, a seeding run) collapse into one
// refetch.
const EVENT_COALESCE_MS = 300;

interface ResourcesState {
  items: Resource[];
  total: number;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  typeFilter: ResourceTypeFilter;
  search: string;

  setTypeFilter: (filter: ResourceTypeFilter) => void;
  setSearch: (search: string) => void;
  load: () => Promise<void>;
  loadMore: () => Promise<void>;
  rename: (id: string, title: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  applyEvent: (msg: ServerMessage) => void;
}

let eventTimer: ReturnType<typeof setTimeout> | null = null;

export const useResourcesStore = create<ResourcesState>((set, get) => ({
  items: [],
  total: 0,
  loading: false,
  loadingMore: false,
  error: null,
  typeFilter: "all",
  search: "",

  setTypeFilter: (typeFilter) => {
    set({ typeFilter });
    void get().load();
  },

  setSearch: (search) => {
    set({ search });
    void get().load();
  },

  load: async () => {
    const { typeFilter, search } = get();
    set({ loading: true, error: null });
    try {
      const page = await api.listResources({
        type: typeFilter === "all" ? undefined : typeFilter,
        q: search.trim() || undefined,
        limit: PAGE,
        offset: 0,
      });
      set({ items: page.items, total: page.total, loading: false });
    } catch (err) {
      set({ error: (err as Error).message, loading: false });
    }
  },

  loadMore: async () => {
    const { typeFilter, search, items, loadingMore, loading } = get();
    if (loadingMore || loading) return;
    set({ loadingMore: true });
    try {
      const page = await api.listResources({
        type: typeFilter === "all" ? undefined : typeFilter,
        q: search.trim() || undefined,
        limit: PAGE,
        offset: items.length,
      });
      const seen = new Set(items.map((r) => r.id));
      set({
        items: [...items, ...page.items.filter((r) => !seen.has(r.id))],
        total: page.total,
        loadingMore: false,
      });
    } catch (err) {
      set({ error: (err as Error).message, loadingMore: false });
    }
  },

  rename: async (id, title) => {
    await api.renameResource(id, title);
    await get().load();
  },

  remove: async (id) => {
    await api.deleteResource(id);
    await get().load();
  },

  applyEvent: (msg) => {
    if (msg.type !== "resources_changed") return;
    if (eventTimer) clearTimeout(eventTimer);
    eventTimer = setTimeout(() => {
      eventTimer = null;
      void get().load();
    }, EVENT_COALESCE_MS);
  },
}));

// Dev/test seam: lets e2e specs seed/inspect the library without a real turn.
// Same gating as __chatStore — dev or e2e builds only, never shipped.
if (typeof window !== "undefined" && (import.meta.env.DEV || import.meta.env.VITE_E2E_SEAM === "1")) {
  (window as unknown as { __resourcesStore?: typeof useResourcesStore }).__resourcesStore =
    useResourcesStore;
}