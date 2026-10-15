// ExtensionsPage.tsx — Dedicated page for managing MCP servers OR skills.
// Accepts a `type` prop to determine whether to show MCP or Skills management.
// Used by: /extensions/mcp (MCP), /extensions/skills (Skills).
// The third tab (external, add-external-skill-sources 刀一) is shared by both
// sub-views: a read-only mirror of external skill markets, no install path.

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { McpInstalledView } from "@/components/extensions/McpInstalledView";
import { McpMarketView } from "@/components/extensions/McpMarketView";
import { SkillsInstalledView } from "@/components/extensions/SkillsInstalledView";
import { SkillsMarketView } from "@/components/extensions/SkillsMarketView";
import { ExternalSourceTab } from "@/components/extensions/ExternalSourceTab";
import { useExtensionsStore } from "@/hooks/useExtensionsStore";
import { useEffect } from "react";

export interface ExtensionsPageProps {
  type: "mcp" | "skills";
}

type Tab = "installed" | "market" | "external";

// The line-credential mint callback lands on /settings/mcp?tab=market — the
// connect cards live in the market tab, so the round trip must come back to
// that surface, not the installed list.
function initialTab(): Tab {
  try {
    const tab = new URL(window.location.href).searchParams.get("tab");
    if (tab === "market" || tab === "external") return tab;
  } catch {
    /* default below */
  }
  return "installed";
}

export function ExtensionsPage({ type }: ExtensionsPageProps) {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<Tab>(initialTab);
  const { load, loading, error } = useExtensionsStore();

  useEffect(() => {
    load();
  }, [load]);

  // No page header: this renders as a Settings section, and the modal's nav
  // already names it. The old <h1> duplicated that label, and its subtitle
  // read `extensions.mcp.description` — a key that was never defined in any
  // locale (check-locales verifies parity across locales, not existence, so it
  // passed). Deleting the header removes the duplication and the broken key.
  return (
    <div className="flex flex-col h-full bg-background" data-testid="extensions-page" data-extensions-type={type}>
      {/* Tabs */}
      <div className="border-b border-border px-6">
        <nav className="flex gap-4">
          <button
            onClick={() => setActiveTab("installed")}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              activeTab === "installed"
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {t("extensions.tabs.installed")}
          </button>
          <button
            onClick={() => setActiveTab("market")}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              activeTab === "market"
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {t("extensions.tabs.market")}
          </button>
          <button
            onClick={() => setActiveTab("external")}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              activeTab === "external"
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
            data-testid="extensions-tab-external"
          >
            {t("extensions.tabs.external")}
          </button>
        </nav>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto">
        {loading && (
          <div className="flex items-center justify-center h-full">
            <div className="text-muted-foreground">{t("common.loading")}</div>
          </div>
        )}
        {error && (
          <div className="p-6">
            <div className="bg-destructive/10 text-destructive px-4 py-3 rounded-md">{error}</div>
          </div>
        )}
        {!loading && !error && (
          <div className="p-6">
            {activeTab === "installed" &&
              (type === "mcp" ? <McpInstalledView /> : <SkillsInstalledView />)}
            {activeTab === "market" &&
              (type === "mcp" ? (
                <McpMarketView onInstalled={() => setActiveTab("installed")} />
              ) : (
                <SkillsMarketView onInstalled={() => setActiveTab("installed")} />
              ))}
            {activeTab === "external" && <ExternalSourceTab />}
          </div>
        )}
      </div>
    </div>
  );
}
