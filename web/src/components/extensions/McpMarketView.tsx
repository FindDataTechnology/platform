// ── McpMarketView ───────────────────────────────────────────────────────
//
// Render-only component for MCP servers market tab. Extracted from
// MarketTab so /extensions/mcp and /extensions can each render this
// independently without showing skills.

import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useExtensionsStore } from "@/hooks/useExtensionsStore";
import { McpMarketCard } from "./McpMarketCard";
import { McpServerForm } from "./McpServerForm";
import { RegistryConnectPanel } from "./RegistryConnectPanel";
import type { MarketMcpServer } from "@platform/core";

interface McpMarketViewProps {
  onInstalled?: () => void;
}

export function McpMarketView({ onInstalled }: McpMarketViewProps = {}) {
  const { t } = useTranslation();
  const { marketCatalog, refreshMarketCatalog, refreshRegistryConnection } = useExtensionsStore();
  const [mcpFormOpen, setMcpFormOpen] = useState(false);
  const [selectedMcp, setSelectedMcp] = useState<MarketMcpServer | null>(null);

  useEffect(() => {
    refreshMarketCatalog();
    // Registry entries install against the user's market credential, so the
    // Store reads its state wherever those installs happen.
    refreshRegistryConnection();
  }, [refreshMarketCatalog, refreshRegistryConnection]);

  const handleInstallMcp = (server: MarketMcpServer) => {
    setSelectedMcp(server);
    setMcpFormOpen(true);
  };

  const mcpServers = marketCatalog?.mcpServers || [];

  return (
    <>
      <section data-testid="mcp-market-section">
        <h2 className="text-lg font-semibold text-foreground mb-4">{t("extensions.market.mcpTitle")}</h2>
        {/* The MCP market account (registry-sso-credentials): registry installs
            authenticate with this credential, so its state lives here. */}
        <RegistryConnectPanel className="mb-4" />
        {mcpServers.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("extensions.market.empty")}</p>
        ) : (
          <div className="grid gap-3">
            {mcpServers.map((server) => (
              <McpMarketCard key={server.name} server={server} onInstall={handleInstallMcp} />
            ))}
          </div>
        )}
      </section>

      <McpServerForm
        open={mcpFormOpen}
        onOpenChange={setMcpFormOpen}
        setupServer={selectedMcp || null}
        onInstalled={onInstalled}
      />
    </>
  );
}