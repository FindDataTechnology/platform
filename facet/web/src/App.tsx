// Facet's thin shell: a header (text site mark + identity + locale switcher +
// login/logout) over three hash-addressed views — the mechanism-first intro
// (#/, the default landing), the 壹座 packs market surface reused verbatim
// (#/packs), and the MCP catalog (#/mcp). v1 scope on the facet domain:
// browse, inspect, subscribe (recorded at the market), publish via the same
// /api/packs API. Cell-side install stays a 壹座 surface — the service answers
// /api/mypacks/* with a guided 501 and the dialog shows it.
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { PackMarketView } from "@/components/packs/PackMarketView";
import { Button } from "@/components/ui/button";
import { useLanguage } from "@/i18n/useLanguage";
import { FACET_HELP_COMMAND } from "./cliFacts";
import { IntroView } from "./IntroView";
import { McpCatalog } from "./McpCatalog";
import { PageFooter } from "./PageFooter";
import { SiteMark } from "./SiteMark";

type View = "intro" | "packs" | "mcp";

const VIEW_HASH: Record<View, string> = { intro: "#/", packs: "#/packs", mcp: "#/mcp" };

/** Hash → view; unknown or empty hashes fall back to the intro landing. */
function viewFromHash(hash: string): View {
  if (hash === "#/packs") return "packs";
  if (hash === "#/mcp") return "mcp";
  return "intro";
}

function Whoami({ onUser }: { onUser: (u: { email: string; groups: string[] } | null) => void }) {
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
  const [user, setUser] = useState<{ email: string; groups: string[] } | null>(null);
  const [view, setView] = useState<View>(() => viewFromHash(window.location.hash));

  useEffect(() => {
    const onHash = () => setView(viewFromHash(window.location.hash));
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  // Tabs write the hash (deep-linkable, reload-stable); the hashchange listener
  // above is the single place that moves the view.
  const go = useCallback((next: View) => {
    if (window.location.hash === VIEW_HASH[next]) setView(next);
    else window.location.hash = VIEW_HASH[next];
  }, []);

  const tabs: [View, string][] = [
    ["intro", t("facetShell.tabs.intro")],
    ["packs", t("facetShell.tabs.packs")],
    ["mcp", t("facetShell.tabs.mcp")],
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
              <span className="text-sm text-muted-foreground">{user.email}</span>
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
      <main className="flex-1 overflow-auto p-6">
        {view === "intro" && <IntroView />}
        {view === "packs" && (
          <div className="space-y-4">
            <PackMarketView onSubscribed={() => {}} />
            <p className="text-xs text-muted-foreground">
              {t("facetShell.packsFootnote")} <code className="font-mono">{FACET_HELP_COMMAND}</code>
            </p>
          </div>
        )}
        {view === "mcp" && <McpCatalog />}
        <PageFooter />
      </main>
    </div>
  );
}