// Studio face auth shim (add-supply-studio-migration 1.6): the single-sourced
// AgentStudioPage reads the 壹座 auth store (`useAuthStore`) for the owner
// email stamped on every document write. On the facet host the identity lives
// in the facet session (/api/whoami) — this component mirrors the whoami
// answer into the shared zustand store once at mount, so the page's owner
// stamping works verbatim without forking the page. Anonymous visitors get
// email:null and the page's own auth-required affordances (login deep link)
// take over.
import { useEffect } from "react";
import { useAuthStore } from "@/hooks/useAuth";

export function useAuthStoreShim() {
  useEffect(() => {
    let alive = true;
    fetch("/api/whoami", { credentials: "same-origin" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!alive) return;
        if (d?.email) {
          useAuthStore.setState({
            email: d.email,
            groups: Array.isArray(d.groups) ? d.groups : [],
            loading: false,
            error: null,
          });
        } else {
          useAuthStore.setState({ email: null, loading: false, error: null });
        }
      })
      .catch(() => {
        if (alive) useAuthStore.setState({ email: null, loading: false, error: null });
      });
    return () => {
      alive = false;
    };
  }, []);
  return null;
}
