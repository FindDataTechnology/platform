// ConnectorConnectPanel.tsx
// The 萬星 connector credential control (connector-credentials): paste a PAT
// minted on the connector's 我的连接 page, see connected / invalidated state,
// disconnect. No silent-connect flow — the connector's login is a browser
// redirect on its own app, so v1 is paste-only. Rendered beside
// RegistryConnectPanel (McpMarketView header + the add-server dialog) so both
// MCP credential surfaces share one mental model.

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useExtensionsStore } from "@/hooks/useExtensionsStore";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Icon } from "@/components/ui/icon";

interface ConnectorConnectPanelProps {
  compact?: boolean;
  className?: string;
}

export function ConnectorConnectPanel({ compact = false, className = "" }: ConnectorConnectPanelProps) {
  const { t } = useTranslation();
  const {
    connectorConnection,
    refreshConnectorConnection,
    saveConnectorCredential,
    disconnectConnector,
  } = useExtensionsStore();

  const [pasteOpen, setPasteOpen] = useState(false);
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  // Self-fetch once: the panel is mount-safe everywhere (the registry panel
  // relies on its mount sites fetching; the connector card owns its fetch).
  useEffect(() => {
    refreshConnectorConnection();
  }, [refreshConnectorConnection]);

  // Unknown (not fetched / unauthenticated) renders nothing — same rule as the
  // registry panel: never claim "not connected" before the state is known.
  if (!connectorConnection) return null;
  const conn = connectorConnection;

  const state = conn.connected ? "connected" : conn.stale ? "stale" : "disconnected";

  const run = async (fn: () => Promise<void>) => {
    setError("");
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const submitPaste = async () => {
    if (!token.trim()) return;
    await run(async () => {
      await saveConnectorCredential(token.trim());
      setToken("");
      setPasteOpen(false);
    });
  };

  const badge = {
    connected: { key: "connected", cls: "bg-success/15 text-success" },
    stale: { key: "stale", cls: "bg-warning/15 text-warning" },
    disconnected: { key: "disconnected", cls: "bg-secondary text-secondary-foreground" },
  }[state];

  // The PAT minting page: the connector's /me shell on this deployment's
  // connector origin (absent when the baseline has no connector row).
  const meUrl = conn.connectorUrl ? `${conn.connectorUrl}${conn.mePath}` : null;

  return (
    <div
      data-testid="connector-connect-panel"
      data-connector-state={state}
      className={`${compact ? "" : "border border-border rounded-lg bg-card p-4"} ${className}`}
    >
      <div className="flex flex-wrap items-center gap-3">
        <Icon name="plug" size={16} className="text-muted-foreground" />
        <span className="text-sm font-medium">{t("extensions.connector.title")}</span>
        <span data-testid="connector-state-badge" className={`text-xs px-2 py-0.5 rounded-full ${badge.cls}`}>
          {t(`extensions.connector.state.${badge.key}`)}
        </span>
        {conn.connected && conn.updatedAt && (
          <span className="text-xs text-muted-foreground" data-testid="connector-updated">
            {t("extensions.connector.updated", { date: new Date(conn.updatedAt).toLocaleString() })}
          </span>
        )}

        <div className="flex-1" />

        {!(compact && state === "connected") && (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => setPasteOpen((v) => !v)}
            data-testid="connector-paste-toggle"
          >
            {t(state === "stale" ? "extensions.connector.repasteToggle" : "extensions.connector.pasteToggle")}
          </Button>
        )}
        {state === "connected" && !compact && (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => run(disconnectConnector)}
            data-testid="connector-disconnect"
          >
            {t("extensions.connector.disconnect")}
          </Button>
        )}
      </div>

      {state === "stale" && (
        <p className="text-xs text-warning mt-2" data-testid="connector-stale-hint">
          {t("extensions.connector.staleHint")}
        </p>
      )}

      {pasteOpen && (
        <div className="mt-3 space-y-2">
          <Label htmlFor="connector-token">{t("extensions.connector.tokenLabel")}</Label>
          <div className="flex gap-2">
            <Input
              id="connector-token"
              value={token}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setToken(e.target.value)}
              placeholder={t("extensions.connector.tokenPlaceholder")}
              data-testid="connector-token-input"
            />
            <Button size="sm" disabled={busy || !token.trim()} onClick={submitPaste} data-testid="connector-paste-save">
              {t("common.save")}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            {meUrl ? (
              <>
                {t("extensions.connector.pasteHint")}{" "}
                <a href={meUrl} target="_blank" rel="noreferrer" className="underline underline-offset-2">
                  {t("extensions.connector.meLink")}
                </a>
              </>
            ) : (
              t("extensions.connector.pasteHintNoLink")
            )}
          </p>
        </div>
      )}

      {error && (
        <div className="flex items-start gap-2 mt-2 text-destructive text-sm" role="alert" data-testid="connector-error">
          <Icon name="alert-circle" size={16} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}
    </div>
  );
}
