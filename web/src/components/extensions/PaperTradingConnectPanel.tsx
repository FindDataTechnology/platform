// PaperTradingConnectPanel.tsx
// The 柏讯模拟交易 token card (paper-trading-credentials): one pasted `fdt_`
// long-lived token per user — minted on the service's own web UI, submitted
// once, and thereafter never echoed back (the card only renders state).
// Re-pasting replaces the token and is the one recovery from a 401-stale row.
// Rendered beside the registry / connector / facet-market cards so all four
// MCP credential surfaces share one mental model.

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useExtensionsStore } from "@/hooks/useExtensionsStore";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Icon } from "@/components/ui/icon";

interface PaperTradingConnectPanelProps {
  compact?: boolean;
  className?: string;
}

export function PaperTradingConnectPanel({ compact = false, className = "" }: PaperTradingConnectPanelProps) {
  const { t } = useTranslation();
  const { paperTradingConnection, refreshPaperTradingConnection, savePaperTradingCredential, disconnectPaperTrading } =
    useExtensionsStore();

  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  // Self-fetch once — mount-safe everywhere (same rule as the other cards).
  useEffect(() => {
    refreshPaperTradingConnection();
  }, [refreshPaperTradingConnection]);

  // Unknown (not fetched / unauthenticated) renders nothing — never claim
  // "not connected" before the state is known.
  if (!paperTradingConnection) return null;
  const conn = paperTradingConnection;

  const submit = async () => {
    if (!token.trim()) return;
    setError("");
    setBusy(true);
    try {
      await savePaperTradingCredential(token.trim());
      setToken("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    setError("");
    setBusy(true);
    try {
      await disconnectPaperTrading();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      data-testid="paper-trading-connect-panel"
      data-paper-trading-state={conn.stale ? "stale" : conn.connected ? "connected" : "disconnected"}
      className={className || "rounded-md border border-border p-3"}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Icon name="line-chart" size={16} className="text-muted-foreground" />
          {t("extensions.paperTrading.title")}
        </div>
        <span className="text-xs text-muted-foreground">
          {conn.stale
            ? t("extensions.paperTrading.staleBadge")
            : conn.connected
              ? t("extensions.paperTrading.connected")
              : t("extensions.paperTrading.notConnected")}
        </span>
      </div>

      {conn.connected ? (
        <div className="mt-2 flex items-center justify-between gap-2">
          <div className="text-xs text-muted-foreground">
            {conn.updatedAt
              ? t("extensions.paperTrading.updated", { date: new Date(conn.updatedAt).toLocaleString() })
              : ""}
          </div>
          <Button variant="outline" size="sm" disabled={busy} onClick={disconnect} data-testid="paper-trading-disconnect">
            {t("extensions.paperTrading.disconnect")}
          </Button>
        </div>
      ) : (
        <div className="mt-2 space-y-2">
          <Label htmlFor="paper-trading-token" className="text-xs text-muted-foreground">
            {conn.stale
              ? t("extensions.paperTrading.staleHint")
              : t("extensions.paperTrading.pasteHint")}
          </Label>
          <div className="flex items-center gap-2">
            <Input
              id="paper-trading-token"
              type="password"
              placeholder="fdt_…"
              value={token}
              disabled={busy}
              onChange={(e) => setToken(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && token.trim()) void submit();
              }}
              className="font-mono text-xs"
              data-testid="paper-trading-token-input"
            />
            <Button size="sm" disabled={busy || !token.trim()} onClick={submit} data-testid="paper-trading-save">
              {t("common.save")}
            </Button>
            {conn.serviceUrl && (
              <a
                href={conn.serviceUrl}
                target="_blank"
                rel="noreferrer"
                className="shrink-0 text-xs underline underline-offset-2 text-muted-foreground"
                data-testid="paper-trading-service-link"
              >
                {t("extensions.paperTrading.openService")}
              </a>
            )}
          </div>
        </div>
      )}

      {!compact && conn.connected && !conn.stale && (
        <div className="mt-1 text-xs text-muted-foreground">
          {t("extensions.paperTrading.paperOnlyNote")}
        </div>
      )}

      {error && (
        <div className="mt-2 text-xs text-destructive" data-testid="paper-trading-error">
          {error}
        </div>
      )}
    </div>
  );
}
