// Projects state (add-web-project-container).
//
// The web-side top-level container: a persisted entity with identity (id +
// display name) standing ABOVE the workspace path. This hook is the single
// client source for the project list — the sidebar groups sessions by it, and
// the collection/task pickers filter with it.
//
// Fetch-on-mount with a cheap in-flight guard: the list is small and changes
// only on create/rename, so a fetch per mount plus an explicit `refresh()` from
// those two actions is enough. Failures degrade to an empty list — the sidebar
// then renders every session under 默认项目, which is exactly the pre-change
// behaviour, so a projects read failure never blanks the session list.
import { create } from "zustand";

export interface ProjectRow {
  id: string;
  name: string;
  backingPath: string;
  owner?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

interface ProjectsState {
  projects: ProjectRow[];
  loading: boolean;
  error: string | null;
  loaded: boolean;
  /** Fetch the list once (idempotent while in flight unless forced). */
  load: (opts?: { force?: boolean }) => Promise<void>;
  /** Re-fetch after a create/rename. */
  refresh: () => Promise<void>;
  /** Look up a project's display name by id (undefined when not listed). */
  nameOf: (id: string | null | undefined) => string | undefined;
}

let inflight: Promise<void> | null = null;

export const useProjectsStore = create<ProjectsState>((set, get) => ({
  projects: [],
  loading: false,
  error: null,
  loaded: false,

  load: async ({ force = false } = {}) => {
    const { loaded, loading } = get();
    if (!force && (loaded || loading)) return;
    if (inflight) return inflight;
    set({ loading: true, error: null });
    inflight = (async () => {
      try {
        const r = await fetch("/api/projects");
        if (!r.ok) throw new Error(`projects ${r.status}`);
        const body = await r.json();
        set({ projects: Array.isArray(body?.projects) ? body.projects : [], loaded: true, error: null });
      } catch (e) {
        // Degrade to empty: sessions still render (默认项目), the list just
        // cannot show project names — never a blank sidebar.
        set({ projects: [], loaded: true, error: String((e as Error).message ?? e) });
      } finally {
        set({ loading: false });
        inflight = null;
      }
    })();
    return inflight;
  },

  refresh: async () => {
    await get().load({ force: true });
  },

  nameOf: (id) => {
    if (!id) return undefined;
    return get().projects.find((p) => p.id === id)?.name;
  },
}));
