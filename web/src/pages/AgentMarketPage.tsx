// 智能体市场 (restructure-yizuo-ia): the product's SINGLE in-product pack
// doorway, at the existing `/agents` route (the slug is public API).
//
// Before this change supply had three doors: this façade, a standalone `/packs`
// page (with ZERO links to it — the creator drafts/publish flow was reachable
// only by typing the URL), and the external facet market. The standalone page's
// two tabs are absorbed here:
//   市场 — browse / inspect / subscribe (PackMarketView), plus the explicit
//          outbound entries: the supply-domain market hall and the Studio.
//   我的 — installed snapshots (updates, uninstall) and creator drafts /
//          publish (PackDraftsView consumes the preset-conversion handoff).
//
// The tab set is registry-resolved (`agentsTabs` = market, mine) and may be
// narrowed by the layout chain; the pack-marketplace predicate lives on the
// `market` tab entry, so a market-less deployment renders 我的 alone instead of
// an empty market shell (installed packs and drafts are local state).
//
// Legacy deep links: `/agents?tab=agents|creations|supply|apps|build` resolve
// through SURFACE_SLUG_ALIASES; `/packs?…` is redirected by the route layer and
// keeps `deployCastPack=` so the Studio's deploy handoff still lands.

import { useEffect, useMemo } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Blocks, ExternalLink } from "lucide-react";
import { EmptyState } from "@/components/ui/states-kit";
import { Button } from "@/components/ui/button";
import { PageShell } from "@/components/ui/page-shell";
import { Tabs } from "@/components/ui/tabs";
import { useChatStore } from "@platform/core";
import { useAppConfig } from "@/hooks/useAppConfig";
import { hasBridgeHandoff } from "@/lib/pack-draft-bridge";
import { PackMarketView } from "@/components/packs/PackMarketView";
import { CustomPresetsPage } from "@/pages/CustomPresetsPage";
import { ExtensionsPage } from "@/pages/ExtensionsPage";
import { PluginCatalogView } from "@/components/plugins/PluginCatalogView";
import { MyPacksView } from "@/components/packs/MyPacksView";
import { PackDraftsView } from "@/components/packs/PackDraftsView";
import { studioHref } from "@/lib/studio-origin";

type Tab = "agents" | "tools" | "skills" | "plugins" | "mine";

const ALL_TABS: Tab[] = ["agents", "tools", "skills", "plugins", "mine"];
const TAB_LABEL: Record<Tab, string> = {
  agents: "agents.tab.agents",
  tools: "agents.tab.tools",
  skills: "agents.tab.skills",
  plugins: "agents.tab.plugins",
  mine: "agents.tab.mine",
};

// Legacy/retired tab slugs → their successor. Kept client-side as well because
// the URL is read before any layout round-trip; the aliases themselves live in
// @platform/core (SURFACE_SLUG_ALIASES) so presets normalize identically.
const LEGACY_TAB: Record<string, Tab> = {
  creations: "mine",
  market: "agents",
  supply: "agents",
  apps: "agents",
  build: "agents",
};

export function AgentMarketPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const setComposerDraft = useChatStore((s) => s.setComposerDraft);
  const { packMarketplace, resolvedLayout } = useAppConfig();

  // The visible set comes from the server-resolved layout; an older server (no
  // field) falls back to the full tab set. No tab is predicate-gated any more:
  // the 智能体 front page degrades in place on a market-less deployment.
  const tabs = useMemo<Tab[]>(() => {
    const resolved = resolvedLayout?.agentsTabs;
    const raw = resolved ?? ALL_TABS;
    const visible = raw.filter((slug): slug is Tab => (ALL_TABS as string[]).includes(slug));
    return visible.length ? visible : ["agents"];
  }, [resolvedLayout]);

  const requested = searchParams.get("tab") ?? "";
  const active: Tab = useMemo(() => {
    const candidate = LEGACY_TAB[requested] ?? requested;
    const normalized = (ALL_TABS as string[]).includes(candidate) ? (candidate as Tab) : null;
    return normalized && tabs.includes(normalized) ? normalized : (tabs[0] ?? "agents");
  }, [requested, tabs]);

  // Keep the URL truthful: a legacy slug or a hidden tab normalizes to the tab
  // actually rendered, so a reload cannot land somewhere else.
  useEffect(() => {
    if (requested === active) return;
    const next = new URLSearchParams(searchParams);
    next.set("tab", active);
    setSearchParams(next, { replace: true });
  }, [requested, active, searchParams, setSearchParams]);

  // A preset-conversion handoff lands with 我的 targeted — PackDraftsView
  // consumes it there (opens the converted draft, shows the report once).
  useEffect(() => {
    if (hasBridgeHandoff() && tabs.includes("mine")) {
      const next = new URLSearchParams(searchParams);
      next.set("tab", "mine");
      setSearchParams(next, { replace: true });
    }
  }, [searchParams, setSearchParams, tabs]);

  // deployCastPack deep link (add-supply-studio-migration 2.2): the supply
  // Studio hands the cast pack off here; the market opens its detail dialog
  // straight on it (install surface → from-template wizard → team page).
  const deployCastPack = searchParams.get("deployCastPack") ?? undefined;

  const selectTab = (tab: Tab) => {
    const next = new URLSearchParams(searchParams);
    next.set("tab", tab);
    setSearchParams(next);
  };

  return (
    <PageShell
      data-testid="agent-market-page"
      title={t("nav.agents")}
      titleTestId="agent-market-title"
      subtitle={t("agents.market.subtitle")}
      filters={
        <div className="border-b border-border pb-1">
          {/* The foundation tab bar, not a hand-rolled one (polish-material-
              market-tabs 2.2/2.3): one keyboard contract (arrows/Home/End,
              roving tabindex, aria-selected) and no 2px coloured border for the
              active state. The public test contract rides itemProps:
              agent-market-tab-<slug> and data-active are asserted by e2e and
              stay byte-identical. */}
          <Tabs
            items={tabs.map((tab) => ({ id: tab, label: t(TAB_LABEL[tab]) }))}
            value={active}
            onChange={(id) => selectTab(id as Tab)}
            ariaLabel={t("nav.agents")}
            itemProps={(id) => ({
              "data-testid": `agent-market-tab-${id}`,
              "data-active": active === id ? "true" : "false",
            })}
          />
        </div>
      }
      bodyClassName="pt-4"
    >        {active === "agents" && packMarketplace === false && (
          <EmptyState
            icon={<Blocks className="h-5 w-5" />}
            title={t("market.agents.unavailableTitle")}
            hint={t("market.agents.unavailableBody")}
            action={
              tabs.includes("mine") ? (
                <Button variant="outline" size="sm" onClick={() => selectTab("mine")}>
                  {t("agents.tab.mine")}
                </Button>
              ) : null
            }
          />
        )}

        {active === "agents" && packMarketplace !== false && (
          <div data-testid="agent-market-panel-agents">
            {/* The marketplace is INTERNAL (drop-external-market-door): its
                catalogue is this deployment's own market plane, so a button
                leaving the product for "the market" would present the same
                catalogue as another product with another identity. The one
                outbound door left is authoring — the supply-domain Studio —
                and it is labelled as authoring, never as the market. */}
            <div className="mb-6 flex flex-wrap items-center gap-3">
              <a
                href={studioHref()}
                target="_blank"
                rel="noopener"
                data-testid="agent-market-studio"
                className="inline-flex items-center gap-2 rounded-md border border-border px-4 py-2 text-sm font-medium hover:bg-muted"
              >
                <Blocks className="h-4 w-4" />
                {t("agents.market.openStudio")}
                <ExternalLink className="h-3.5 w-3.5 opacity-60" />
              </a>
            </div>
            {/* Preset management lives here because this IS the doorway the
                parked e2e suite expects (/agents?tab=agents + preset-create):
                agent-catalog's「Experts 子标签」was this page's inline
                management before the IA consolidation removed the sub-tab and
                left a built, server-backed page unmounted (9 tests fixme'd in
                custom-presets / preset-pack-bridge / preset-publish-flow).
                Rendering it under the catalogue restores the doorway without
                inventing a new top-level surface — the 6-top IA stays. */}
            <section className="mt-10 border-t border-border pt-6" data-testid="agent-market-presets">
              <CustomPresetsPage />
            </section>
            <PackMarketView
              initialDetailId={deployCastPack}
              onSubscribed={() => tabs.includes("mine") && selectTab("mine")}
              onUsePrompt={(prompt) => {
                // Parked-draft channel (P2 3.5, same as DocumentsPage): the
                // composer consumes it exactly once on the chat page.
                setComposerDraft(prompt);
                navigate("/chat");
              }}
            />
          </div>
        )}

        {(active === "tools" || active === "skills") && (
          <div data-testid={`agent-market-panel-${active}`}>
            {/* The Settings modal used to host this pair; the container moved,
                the views and every testid inside them did not. */}
            <ExtensionsPage type={active === "tools" ? "mcp" : "skills"} />
          </div>
        )}

        {active === "plugins" && (
          <div data-testid="agent-market-panel-plugins">
            <PluginCatalogView />
          </div>
        )}

        {active === "mine" && (
          <div className="flex flex-col gap-8" data-testid="agent-market-panel-mine">
            <section data-testid="agent-market-mine-installed">
              <h2 className="mb-3 text-sm font-medium text-muted-foreground">
                {t("packs.mineSections.installed")}
              </h2>
              <MyPacksView />
            </section>
            <section data-testid="agent-market-mine-creations">
              <h2 className="mb-3 text-sm font-medium text-muted-foreground">
                {t("packs.mineSections.creations")}
              </h2>
              <PackDraftsView
                onPublished={() => tabs.includes("agents") && selectTab("agents")}
                onOpenChat={() => navigate("/chat")}
              />
            </section>
          </div>
        )}
    </PageShell>
  );
}
