// PacksPage.tsx — the pack marketplace surface (add-pack-marketplace), served
// as a Settings section on gateway-fronted deployments only (design D15; the
// registry gates this section on /api/config's packMarketplace flag).
//
// Three tabs: the market (browse/inspect/subscribe), my packs (installed
// snapshots, updates, uninstall), and creator drafts (authoring + publish).
// Mounted only when config.packMarketplace is true, so no code path here
// needs a local-deployment fallback.

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { PackMarketView } from "@/components/packs/PackMarketView";
import { MyPacksView } from "@/components/packs/MyPacksView";
import { PackDraftsView } from "@/components/packs/PackDraftsView";

type Tab = "market" | "mine" | "drafts";

export function PacksPage() {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<Tab>("market");

  return (
    <div className="flex flex-col h-full bg-background" data-testid="packs-page">
      <div className="border-b border-border px-6">
        <nav className="flex gap-4" data-testid="packs-tabs">
          {(
            [
              ["market", "packs.tabs.market"],
              ["mine", "packs.tabs.mine"],
              ["drafts", "packs.tabs.drafts"],
            ] as const
          ).map(([tab, key]) => (
            <button
              key={tab}
              data-testid={`packs-tab-${tab}`}
              onClick={() => setActiveTab(tab)}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                activeTab === tab
                  ? "border-primary text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              {t(key)}
            </button>
          ))}
        </nav>
      </div>
      <div className="flex-1 overflow-auto p-6">
        {activeTab === "market" && <PackMarketView onSubscribed={() => setActiveTab("mine")} />}
        {activeTab === "mine" && <MyPacksView />}
        {activeTab === "drafts" && <PackDraftsView onPublished={() => setActiveTab("market")} />}
      </div>
    </div>
  );
}
