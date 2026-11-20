// McpMarketCard.tsx
// Card component for displaying a market MCP server.

import { useTranslation } from "react-i18next";
import type { MarketMcpServer } from "@platform/core";
import { Button } from "@/components/ui/button";
import { Download } from "lucide-react";

interface McpMarketCardProps {
  server: MarketMcpServer;
  onInstall: (server: MarketMcpServer) => void;
}

export function McpMarketCard({ server, onInstall }: McpMarketCardProps) {
  const { t } = useTranslation();

  return (
    <div data-testid="mcp-market-card" data-market-name={server.name} className="border border-border rounded-lg p-4 bg-card">
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <h3 className="font-medium text-foreground truncate">{server.annotation?.name || server.displayName}</h3>
            <span className="text-xs px-2 py-0.5 rounded-full bg-secondary text-secondary-foreground">
              {server.category}
            </span>
            <span
              data-testid="mcp-config-badge"
              className={`text-xs px-2 py-0.5 rounded-full ${
                server.requiresConfig
                  ? "bg-warning/15 text-warning"
                  : "bg-success/15 text-success"
              }`}
            >
              {server.requiresConfig
                ? t("extensions.market.needsConfig")
                : t("extensions.market.readyToUse")}
            </span>
            {server.origin === "registry" && (
              <span
                data-testid="mcp-registry-badge"
                className="text-xs px-2 py-0.5 rounded-full bg-primary/10 text-primary"
              >
                Registry
              </span>
            )}
          </div>
          {/* Supply annotation (add-mcp-annotation-overlay): the localized
              human track leads when present; the raw upstream description
              stays reachable in the advanced disclosure (never replaced). */}
          <p className="text-sm text-muted-foreground line-clamp-2 mb-2" data-testid="mcp-market-description">
            {server.annotation?.summary || server.description}
          </p>
          {server.annotation?.summary && (
            <details className="mb-2">
              <summary className="cursor-pointer text-xs text-muted-foreground select-none">{t("extensions.mcp.advanced")}</summary>
              <p className="mt-1 text-xs text-muted-foreground">{server.description}</p>
            </details>
          )}
          <p className="text-xs text-muted-foreground italic">{server.installInstructions}</p>
        </div>
        <Button size="sm" onClick={() => onInstall(server)}>
          <Download className="h-4 w-4 mr-1" />
          {t("extensions.market.install")}
        </Button>
      </div>
    </div>
  );
}
