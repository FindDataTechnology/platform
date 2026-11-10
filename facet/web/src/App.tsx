// Facet's thin shell: a header (text site mark + identity + locale switcher +
// login/logout) over hash-addressed views — the mechanism-first intro
// (#/, the default landing), the 壹座 packs market surface reused verbatim
// (#/packs), the MCP catalog (#/mcp), and the docs view (#/docs). v1 scope on
// the facet domain: browse, inspect, subscribe (recorded at the market),
// publish via the same /api/packs API. Cell-side install stays a 壹座 surface
// — the service answers /api/mypacks/* with a guided 501 and the dialog shows it.
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { PackMarketView } from "@/components/packs/PackMarketView";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { useLanguage } from "@/i18n/useLanguage";
import { FACET_HELP_COMMAND } from "./cliFacts";
import { ErrorBoundary } from "./ErrorBoundary";
import { CurateView } from "./CurateView";
import { DocsView } from "./DocsView";
import { IntroView } from "./IntroView";
import { McpCatalog } from "./McpCatalog";
import { MineView } from "./MineView";
import { StudioView } from "./StudioView";
import { FilingFooter, PageFooter } from "./PageFooter";
import { SiteMark } from "./SiteMark";

// Conditional views (add-facet-content-management): #/mine needs a signed-in
// viewer, #/curate needs an admin — an unauthorized deep link falls back to
// the intro landing (the data plane rejects those calls anyway).
// studio (add-supply-studio-migration 1.6): the supply-domain creation face —
// signed-in only (documents are owner-scoped; anonymous deep links fall back
// to the intro landing, same gate as #/mine).
type View = "intro" | "packs" | "mcp" | "docs" | "mine" | "curate" | "studio";

type WhoamiUser = { email: string; groups: string[]; creator?: boolean; admin?: boolean } | null;

const VIEW_HASH: Record<View, string> = {
  intro: "#/",
  packs: "#/packs",
  mcp: "#/mcp",
  docs: "#/docs",
  mine: "#/mine",
  curate: "#/curate",
  studio: "#/studio",
};

/** Hash → view, gated by identity; unknown/empty/unauthorized fall back to intro.
 *
 *  The query rides the hash (`#/studio?doc=bp_x` — supply-studio 深链契约, the
 *  shape the cross-domain back-links use), so the view match reads the PATH
 *  part only. Comparing the whole hash dropped every deep link to intro: the
 *  fleet 来源蓝图 chip opened the market page instead of the document (live
 *  2026-11-08). */
function viewFromHash(hash: string, user: WhoamiUser): View {
  const path = hash.split("?")[0];
  if (path === "#/packs") return "packs";
  if (path === "#/mcp") return "mcp";
  if (path === "#/docs") return "docs";
  if (path === "#/mine") return user ? "mine" : "intro";
  if (path === "#/studio") return user ? "studio" : "intro";
  if (path === "#/curate") return user?.admin ? "curate" : "intro";
  return "intro";
}

function Whoami({ onUser }: { onUser: (u: WhoamiUser) => void }) {
  useEffect(() => {
    fetch("/api/whoami")
      .then((r) => r.json())
      .then((d) => onUser(d?.email ? d : null))
      .catch(() => onUser(null));
  }, [onUser]);
  return null;
}

/** Five-locale switcher; an explicit choice persists in the app's locale store. */
function LocaleSwitcher() {
  const { t } = useTranslation();
  const { locale, locales, changeLocale } = useLanguage();
  return (
    <select
      aria-label={t("facetShell.langLabel")}
      data-testid="facet-locale-switcher"
      value={locale}
      onChange={(e) => changeLocale(e.target.value as (typeof locales)[number]["code"])}
      className="rounded-md border border-border bg-background px-2 py-1 text-xs text-muted-foreground"
    >
      {locales.map((l) => (
        <option key={l.code} value={l.code}>
          {l.label}
        </option>
      ))}
    </select>
  );
}

export function App() {
  const { t } = useTranslation();
  const [user, setUser] = useState<WhoamiUser>(null);
  const [view, setView] = useState<View>(() => viewFromHash(window.location.hash, null));
  // A failed OIDC return lands on /?auth_error=state|token. Without this the
  // shell silently shows the anonymous face — the user believes the sign-in
  // happened and wonders why the header still says "登录". Surface it once,
  // then scrub the param so a refresh does not re-raise it.
  const [authError, setAuthError] = useState<string | null>(null);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const kind = params.get("auth_error");
    if (!kind) return;
    params.delete("auth_error");
    const rest = params.toString();
    window.history.replaceState(null, "", `${window.location.pathname}${rest ? `?${rest}` : ""}${window.location.hash}`);
    setAuthError(kind);
  }, []);

  // Whoami resolves after first paint: re-derive the view once identity is in,
  // so an authorized deep link to #/mine or #/curate lands after the probe.
  useEffect(() => {
    setView(viewFromHash(window.location.hash, user));
  }, [user]);

  useEffect(() => {
    const onHash = () => setView(viewFromHash(window.location.hash, user));
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [user]);

  // Tabs write the hash (deep-linkable, reload-stable); the hashchange listener
  // above is the single place that moves the view. The path part decides "same
  // view" so a tab click does not strip a live deep-link query (#/studio?doc=).
  const go = useCallback((next: View) => {
    if (window.location.hash.split("?")[0] === VIEW_HASH[next]) setView(next);
    else window.location.hash = VIEW_HASH[next];
  }, []);

  // Signed-out viewers subscribing from the detail dialog land on the login
  // entry with a same-origin return path (logto-auth's safeReturnPath keeps
  // the hash) — back to the packs market, dialog state intentionally lost.
  const goLogin = useCallback(() => {
    window.location.href = `/auth/login?rd=${encodeURIComponent(window.location.href)}`;
  }, []);

  const tabs: [View, string][] = [
    ["intro", t("facetShell.tabs.intro")],
    ["packs", t("facetShell.tabs.packs")],
    ["mcp", t("facetShell.tabs.mcp")],
    ["docs", t("facetShell.tabs.docs")],
    ...(user ? ([["mine", t("facetShell.tabs.mine")]] as [View, string][]) : []),
    // Studio (add-supply-studio-migration 1.6): the creation face is a
    // signed-in tab — the funnel entry the 壹座-side deep links resolve to.
    ...(user ? ([["studio", t("facetShell.tabs.studio")]] as [View, string][]) : []),
    ...(user?.admin ? ([["curate", t("facetShell.tabs.curate")]] as [View, string][]) : []),
  ];

  return (
    <div className="flex flex-col h-full min-h-screen bg-background text-foreground">
      <Whoami onUser={setUser} />
      <header className="border-b border-border px-6 py-3 flex flex-wrap items-center justify-between gap-y-2">
        <div className="flex flex-wrap items-center gap-3">
          <SiteMark chars="谦" size="md" />
          <span className="text-lg font-semibold">谦面 Facet</span>
          <nav className="ml-2 flex gap-2" data-testid="facet-tabs">
            {tabs.map(([id, label]) => (
              <button
                key={id}
                onClick={() => go(id)}
                className={`px-3 py-1.5 text-sm font-medium border-b-2 transition-colors ${
                  view === id
                    ? "border-primary text-primary"
                    : "border-transparent text-muted-foreground hover:text-foreground"
                }`}
              >
                {label}
              </button>
            ))}
          </nav>
        </div>
        <div className="flex items-center gap-3">
          <LocaleSwitcher />
          {user ? (
            <>
              <span
                className="flex items-center gap-1.5 text-sm text-muted-foreground"
                data-testid="facet-user-chip"
                title={t("facetShell.loggedInAs", { email: user.email })}
              >
                <span className="inline-block h-2 w-2 rounded-full bg-success" aria-hidden />
                {user.email}
              </span>
              <Button variant="outline" size="sm" onClick={() => (window.location.href = "/api/auth/logout")}>
                {t("auth.logout")}
              </Button>
            </>
          ) : (
            <Button size="sm" onClick={() => (window.location.href = "/auth/login")}>
              {t("auth.login")}
            </Button>
          )}
        </div>
      </header>
      {authError && (
        <div
          className="border-b border-border bg-warning/10 px-6 py-2 flex flex-wrap items-center gap-3"
          data-testid="facet-auth-error"
          role="alert"
        >
          <Icon name="alert-circle" size={16} className="text-warning shrink-0" />
          <span className="flex-1 text-sm text-warning">
            {t(`facetShell.loginBanner.${authError === "state" || authError === "token" ? authError : "generic"}`)}
          </span>
          <Button size="sm" onClick={() => (window.location.href = "/auth/login")}>
            {t("facetShell.loginBanner.retry")}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setAuthError(null)}>
            {t("facetShell.loginBanner.dismiss")}
          </Button>
        </div>
      )}
      <main className="flex-1 overflow-auto p-6">
        {/* key={view} resets the boundary when tabs switch: a contained
            failure never leaks into the next view (spec: facet-platform,
            tabs still work after a contained failure). */}
        <ErrorBoundary key={view}>
          {view === "intro" && <IntroView />}
          {view === "packs" && (
            <div className="space-y-4">
              {/* onOpenChat={null}: the next-steps wizard footer points at a
                  conversation view this shell doesn't have (installing stays a
                  壹座 surface), so the footer is suppressed — the report panel
                  itself renders unchanged (spec: pack-marketplace). */}
              {/* Fork deep link (add-agent-fork-lineage D5): cross-domain to
                  壹座 — facet renders the affordance, the write lands in the
                  user's 壹座 cell after SSO. */}
              <PackMarketView
                studioOrigin="https://platform.finddatatech.cloud"
                onSubscribed={() => {}}
                onOpenChat={null}
                // No install plane on this host (overhaul-market-catalog-
                // presentation P0 1.7): the detail dialog skips its deployments/
                // billing probes — requests that can never carry data here.
                installSurface={false}
                // Only a signed-out viewer gets the gated path: after login
                // these must be undefined so the buttons fire for real (the
                // earlier unconditional wiring sent signed-in users to login).
                onRequireLogin={user ? undefined : goLogin}
                // goto-mine: signed-out the dialog flips the guidance row
                // itself; signed-in facet has no installed-packs surface, so
                // the button is omitted entirely.
                onGotoMine={user ? undefined : () => {}}
              />
              <p className="text-xs text-muted-foreground">
                {t("facetShell.packsFootnote")} <code className="font-mono">{FACET_HELP_COMMAND}</code>
              </p>
            </div>
          )}
          {view === "mcp" && <McpCatalog />}
          {view === "docs" && <DocsView />}
          {view === "mine" && <MineView />}
          {view === "curate" && <CurateView />}
          {view === "studio" && <StudioView />}
        </ErrorBoundary>
        {/* Spec: the intro landing carries the full marketing footer (ladder,
            brand, mission); the tool views carry the filing-only footer. */}
        {view === "intro" ? <PageFooter /> : <FilingFooter />}
      </main>
    </div>
  );
}