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
// Chat store: the page reads the model roster for the judge-model picker; on
// the facet host no chat plane feeds it, so the roster stays empty and the
// judge lane resolves through the deployment env route (LLM_BASE_URL route —
// same posture the 壹座 cell processes already run with an empty roster).
import { MemoryRouter } from "react-router-dom";
import { useTranslation } from "react-i18next";
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

export function StudioView() {
  // Hook call (add-supply-studio-migration 1.6): the shim mirrors the facet
  // session into the shared auth store. It was previously rendered as
  // `<useAuthStoreShim />` — lowercase JSX is a DOM tag to React, so the
  // mount effect never ran; call it as the hook it is.
  useAuthStoreShim();
  const { t } = useTranslation();
  const query = studioQueryFromHash(window.location.hash);
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="facet-studio-face">
      <MemoryRouter initialEntries={[`/studio${query}`]}>
        <div className="flex items-center justify-between border-b border-border px-4 py-2">
          <span className="text-sm font-medium text-muted-foreground">
            {t("facetShell.studioTitle")}
          </span>
        </div>
        <AgentStudioPage runOrigin={RUN_ORIGIN} />
      </MemoryRouter>
    </div>
  );
}
