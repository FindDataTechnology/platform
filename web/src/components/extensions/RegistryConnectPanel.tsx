// RegistryConnectPanel.tsx
// The MCP-market credential control (registry-sso-credentials): connection
// state, one-click silent connect, re-connect when stale/expired, manual paste
// fallback, disconnect. Rendered in the Store header and inside the registry
// install dialog, so both places share one implementation.

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useExtensionsStore } from "@/hooks/useExtensionsStore";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Icon } from "@/components/ui/icon";

interface RegistryConnectPanelProps {
  // compact: dialog variant — no outer card, no disconnect button (the install
  // flow only needs "get me credentials").
  compact?: boolean;
  className?: string;
}

export function RegistryConnectPanel({ compact = false, className = "" }: RegistryConnectPanelProps) {
  const { t } = useTranslation();
  const {
    registryConnection,
    connecting,
    connectMarket,
    saveMarketCredential,
    disconnectMarket,
  } = useExtensionsStore();

  const [pasteOpen, setPasteOpen] = useState(false);
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  // Unknown (not fetched / unauthenticated) renders nothing: the Store must not
  // claim "not connected" before it knows.
  if (!registryConnection) return null;
  const conn = registryConnection;
  const configured = Boolean(conn.registryUrl);

  const state = conn.connected
    ? "connected"
    : conn.stale
      ? "stale"
      : conn.expired
        ? "expired"
        : "disconnected";

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
      await saveMarketCredential(token.trim(), "paste");
      setToken("");
      setPasteOpen(false);
    });
  };

  const badge = {
    connected: { key: "connected", cls: "bg-success/15 text-success" },
    stale: { key: "stale", cls: "bg-warning/15 text-warning" },
    expired: { key: "expired", cls: "bg-warning/15 text-warning" },
    disconnected: { key: "disconnected", cls: "bg-secondary text-secondary-foreground" },
  }[state];

  return (
    <div
      data-testid="registry-connect-panel"
      data-registry-state={state}
      data-registry-compact={compact ? "true" : undefined}
      className={`${compact ? "" : "border border-border rounded-lg bg-card p-4"} ${className}`}
    >
      <div className="flex flex-wrap items-center gap-3">
        <Icon name="plug" size={16} className="text-muted-foreground" />
        <span className="text-sm font-medium">{t("extensions.registry.title")}</span>
        <span data-testid="registry-state-badge" className={`text-xs px-2 py-0.5 rounded-full ${badge.cls}`}>
          {t(`extensions.registry.state.${badge.key}`)}
        </span>
        {conn.connected && conn.expiresAt && (
          <span className="text-xs text-muted-foreground" data-testid="registry-expiry">
            {t("extensions.registry.expires", { date: new Date(conn.expiresAt).toLocaleString() })}
          </span>
        )}

        <div className="flex-1" />

        {/* In the install dialog a connected credential needs no controls:
            the flow is already satisfied, so it shows status alone. */}
        {!(compact && state === "connected") && state !== "connected" && (
          <Button
            size="sm"
            disabled={busy || connecting || !configured}
            onClick={() => run(connectMarket)}
            data-testid="registry-connect"
          >
            <Icon name="sparkles" size={14} className={connecting ? "animate-pulse" : ""} />
            {connecting
              ? t("extensions.registry.connecting")
              : state === "disconnected"
                ? t("extensions.registry.connect")
                : t("extensions.registry.reconnect")}
          </Button>
        )}
        {!(compact && state === "connected") && (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => setPasteOpen((v) => !v)}
            data-testid="registry-paste-toggle"
          >
            {t("extensions.registry.pasteToggle")}
          </Button>
        )}
        {state === "connected" && !compact && (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => run(disconnectMarket)}
            data-testid="registry-disconnect"
          >
            {t("extensions.registry.disconnect")}
          </Button>
        )}
      </div>

      {/* No registry URL on this deployment (registry-bridge disabled): the
          paste path is the only way to a credential, and the silent connect
          would open a popup at a URL that does not exist. */}
      {!configured && (
        <p className="text-xs text-muted-foreground mt-2" data-testid="registry-unconfigured">
          {t("extensions.registry.unconfigured")}
        </p>
      )}
      {state === "stale" && (
        <p className="text-xs text-warning mt-2" data-testid="registry-stale-hint">
          {t("extensions.registry.staleHint")}
        </p>
      )}

      {pasteOpen && (
        <div className="mt-3 space-y-2">
          <Label htmlFor="registry-token">{t("extensions.registry.tokenLabel")}</Label>
          <div className="flex gap-2">
            <Input
              id="registry-token"
              value={token}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setToken(e.target.value)}
              placeholder={t("extensions.registry.tokenPlaceholder")}
              data-testid="registry-token-input"
            />
            <Button size="sm" disabled={busy || !token.trim()} onClick={submitPaste} data-testid="registry-paste-save">
              {t("common.save")}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">{t("extensions.registry.pasteHint")}</p>
        </div>
      )}

      {error && (
        <div className="flex items-start gap-2 mt-2 text-destructive text-sm" role="alert" data-testid="registry-error">
          <Icon name="alert-circle" size={16} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}
    </div>
  );
}
