// Studio face host (add-supply-studio-migration 1.6): the three-pane creation
// surface moves to the supply domain — this shell wraps the single-sourced
// AgentStudioPage (imported through the `@` alias into web/src, zero copy)
// with a MemoryRouter so the page's react-router hooks (useSearchParams for
// the ?new/?doc/?fork deep links, useNavigate) resolve against the deep-link
// query the hash view carries in. Runtime-domain affordances the page renders
// for a signed-in 壹座 session (deploy actions hitting /api/mypacks + from-
// template) answer honestly on this host: the API plane replies 501 guided
// (pack-marketplace v1 scope) and the deploy dialog's honest-boundary wording
// covers the run-domain account requirement (spec: 部署动作的诚实边界).
//
// Routing (overhaul-facet-shell-ia-and-space D4): the router is scoped — a
// route table holding the creation face and nothing else. Before it, the page
// mounted with no table at all, so its own back/team/market navigations were
// silent no-ops on this host (supply-studio: 不存在静默无操作). Every
// destination leaves through `handleNavigate`: run-domain targets open real
// links to 壹座, 壹座-page targets become the host's own view change, and only
// the creation face's own ?doc= deep links stay inside the local router.
//
// Chat store: the page reads the model roster for the judge-model picker; on
// the facet host no chat plane feeds it, so the roster stays empty and the
// judge lane resolves through the deployment env route (LLM_BASE_URL route —
// same posture the 壹座 cell processes already run with an empty roster).
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { AgentStudioPage } from "@/pages/AgentStudioPage";
import { useAuthStoreShim } from "./studioAuthShim";

const QUERY_KEYS = ["new", "doc", "fork"];

// The run domain (壹座) origin for the deploy deep link (D4 honest boundary):
// the studio page hands the cast pack off there for install+from-template.
const RUN_ORIGIN = import.meta.env.VITE_RUN_ORIGIN ?? "https://platform.finddatatech.cloud";

/** Extract the studio deep-link query (?new=agent&doc=&fork=) from the hash
 * fragment: `#/studio?doc=bp_x` → `?doc=bp_x`. Unknown keys are dropped —
 * the page's own deep-link contract (supply-studio 深链契约) is the only
 * surface this host forwards. */
export function studioQueryFromHash(hash: string): string {
  const idx = hash.indexOf("?");
  if (idx < 0) return "";
  const params = new URLSearchParams(hash.slice(idx + 1));
  const out = new URLSearchParams();
  for (const key of QUERY_KEYS) {
    const v = params.get(key);
    if (v) out.set(key, v);
  }
  const s = out.toString();
  return s ? `?${s}` : "";
}

export function StudioView({ onExit }: { onExit?: () => void } = {}) {
  // Hook call (add-supply-studio-migration 1.6): the shim mirrors the facet
  // session into the shared auth store. It was previously rendered as
  // `<useAuthStoreShim />` — lowercase JSX is a DOM tag to React, so the
  // mount effect never ran; call it as the hook it is.
  useAuthStoreShim();
  const query = studioQueryFromHash(window.location.hash);

  /** Claim a destination that has no page on this host. Returns false for the
   *  creation face's own doc deep links, which the local table serves. */
  const handleNavigate = (to: string): boolean => {
    // Run-domain surfaces (a freshly deployed team) live in 壹座: open it for
    // real so the URL is copyable and the back button works.
    if (to.startsWith("/fleets/")) {
      window.open(`${RUN_ORIGIN}${to}`, "_blank", "noopener,noreferrer");
      return true;
    }
    // 壹座's own pages — the market is this host's packs view.
    if (to.startsWith("/agents")) {
      onExit?.();
      return true;
    }
    return false;
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="facet-studio-face">
      <MemoryRouter initialEntries={[`/studio${query}`]}>
        {/* Scoped route table: the creation face only. Nothing else on this
            host can be reached by a borrowed view's navigation. */}
        <Routes>
          <Route
            path="/studio"
            element={<AgentStudioPage runOrigin={RUN_ORIGIN} onExit={onExit} onNavigate={handleNavigate} />}
          />
        </Routes>
      </MemoryRouter>
    </div>
  );
}
