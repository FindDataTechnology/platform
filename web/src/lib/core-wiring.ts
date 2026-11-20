// One-time wiring of the platform-agnostic core to this (browser) host:
// the chat error sink and the dev/e2e store exposure seam. Imported for its
// side effects from main.tsx, before any component touches the store.

import { setChatErrorSink, setStoreExposer, useCronStore } from "@platform/core";
import { showToast } from "@/components/Toast";

setChatErrorSink(showToast);

// Expose the store on window so e2e can drive it without a real WebSocket.
// Gated to dev builds and the Playwright dist build (VITE_E2E_SEAM=1) — never
// in shipped/release builds, so the Zustand store is not globally
// readable/mutable in production.
if (import.meta.env.DEV || import.meta.env.VITE_E2E_SEAM === "1") {
  setStoreExposer((store) => {
    (window as unknown as { __chatStore?: unknown }).__chatStore = store;
  });
  // The cron store has no exposer seam of its own — subscribe once and pin
  // the live instance under the same gate.
  useCronStore.subscribe(() => {});
  (window as unknown as { __cronStore?: unknown }).__cronStore = useCronStore;
}
