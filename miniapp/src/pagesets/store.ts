// Pageset authorization store (openspec: add-erp-miniapp-pagesets 1.2).
//
// Loads the tenant's authorized pageset combination over the base runtime's
// configured http transport (installHttp() runs at runtime boot, so this read
// rides the same auth-header/401-retry pipeline as every other REST call —
// never a bypass). Fail-closed: until a well-formed response arrives the
// store holds NO entries, so no pageset entry renders and every pageset
// route is blocked. A failed or malformed read is "error", also with no
// entries — a network blip must never open pages.

import { http } from "@platform/core";
import { create } from "zustand";
import { parsePagesetAuth, PAGESET_AUTH_PATH, type PagesetAuthStatus, type PagesetGrants } from "./authorize.ts";

interface PagesetAuthState {
  status: PagesetAuthStatus;
  grants: PagesetGrants;
  /** Millisecond timestamp of the last successful read; 0 when none. */
  loadedAt: number;
  refresh: () => Promise<void>;
}

// Single-flight: a burst of pages mounting at once shares one read.
let inFlight: Promise<void> | null = null;

export const usePagesetAuthStore = create<PagesetAuthState>((set) => ({
  status: "unknown",
  grants: {},
  loadedAt: 0,
  refresh: () => {
    if (inFlight) return inFlight;
    set({ status: "loading" });
    inFlight = (async () => {
      try {
        const res = await http(PAGESET_AUTH_PATH);
        const payload = await res.json();
        if (!res.ok) {
          // Unauthorized/unknown tenants are a fail-closed "ready with zero
          // entries" — an explicit server NO is a decided answer, not an error.
          set({ status: "ready", grants: {}, loadedAt: 0 });
          return;
        }
        const grants = parsePagesetAuth(payload);
        set({ status: "ready", grants, loadedAt: Date.now() });
      } catch {
        set({ status: "error", grants: {}, loadedAt: 0 });
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  },
}));

// Re-auth (login/bind switch) must drop whatever the previous identity was
// allowed to see: reset to fail-closed before the next refresh.
export function resetPagesetAuth() {
  inFlight = null;
  usePagesetAuthStore.setState({ status: "unknown", grants: {}, loadedAt: 0 });
}
