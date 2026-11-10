// ConnectorConnectPanel.tsx
// The 萬星 connector account control (connector-credentials;
// add-connector-account-picker): a list of connector accounts with per-row
// state and actions, a zero-paste "connect new account" entry (probe → login
// popup → cross-origin mint → store), and manual paste kept as the always-
// available fallback. Exactly one account is active — its token is what
// profile writes inject; switching is explicit, deleting the active account
// leaves nothing active (pick again deliberately). Stale rows offer only
// "reconnect", never "set active". The "open connector console" entry stays
// visible in BOTH states and hides only when the baseline has no connector
// row. Rendered beside RegistryConnectPanel (McpMarketView header + the
// add-server dialog) so both MCP credential surfaces share one mental model.

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useExtensionsStore } from "@/hooks/useExtensionsStore";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Icon } from "@/components/ui/icon";
import { connectorLearnMoreUrl } from "@/lib/connector-mint";

interface ConnectorConnectPanelProps {
  compact?: boolean;
  className?: string;
}

export function ConnectorConnectPanel({ compact = false, className = "" }: ConnectorConnectPanelProps) {
  const { t, i18n } = useTranslation();
  const {
    connectorConnection,
    connectorAccounts,
    refreshConnectorConnection,
    connectConnectorAccount,
    saveConnectorCredential,
    setActiveConnectorAccount,
    disconnectConnector,
    connecting,
  } = useExtensionsStore();

  const [pasteOpen, setPasteOpen] = useState(false);
  const [token, setToken] = useState("");
  const [pasteSlot, setPasteSlot] = useState("");
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
  const accounts = connectorAccounts ?? [];

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
      await saveConnectorCredential(token.trim(), pasteSlot.trim() || "default");
      setToken("");
      setPasteSlot("");
      setPasteOpen(false);
    });
  };

  // The PAT minting page: the connector's /me shell on this deployment's
  // connector origin (absent when the baseline has no connector row).
  const meUrl = conn.connectorUrl ? `${conn.connectorUrl}${conn.mePath}` : null;
  const zeroPasteAvailable = !!conn.connectorUrl;

  return (
    <div
      data-testid="connector-connect-panel"
      data-connector-state={accounts.some((a) => a.active && a.connected) ? "connected" : "disconnected"}
      className={`${compact ? "" : "border border-border rounded-lg bg-card p-4"} ${className}`}
    >
      <div className="flex flex-wrap items-center gap-3">
        <Icon name="plug" size={16} className="text-muted-foreground" />
        <span className="text-sm font-medium">{t("extensions.connector.title")}</span>

        <div className="flex-1" />

        {zeroPasteAvailable && (
          <Button
            size="sm"
            disabled={busy || connecting}
            onClick={() => run(connectConnectorAccount)}
            data-testid="connector-connect-new"
          >
            {connecting ? t("extensions.connector.connecting") : t("extensions.connector.connectNew")}
          </Button>
        )}
        {meUrl && (
          <a
            href={meUrl}
            target="_blank"
            rel="noreferrer"
            data-testid="connector-console-link"
            className="inline-flex h-9 items-center justify-center rounded-md border border-input bg-background px-3 text-sm font-medium hover:bg-accent hover:text-accent-foreground"
          >
            <Icon name="external-link" size={14} className="mr-1.5" />
            {t("extensions.connector.openConsole")}
          </a>
        )}
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => setPasteOpen((v) => !v)}
          data-testid="connector-paste-toggle"
        >
          {t("extensions.connector.pasteToggle")}
        </Button>
      </div>

      {/* add-connector-context: what this product is and where to read more —
          shown before the user ever clicks "connect". */}
      <p className="mt-1 text-xs text-muted-foreground" data-testid="connector-context-line">
        {t("extensions.connector.contextLine")}{" "}
        <a
          href={connectorLearnMoreUrl(i18n.language)}
          target="_blank"
          rel="noreferrer"
          data-testid="connector-learn-more"
          className="text-primary hover:underline"
        >
          {t("extensions.connector.learnMore")}
        </a>
      </p>

      {/* Account list — one row per connected connector identity. */}
      {accounts.length > 0 && (
        <ul className="mt-3 space-y-1" data-testid="connector-account-list">
          {accounts.map((account) => {
            const state = account.stale ? "stale" : "connected";
            const badge = {
              connected: { key: "connected", cls: "bg-success/15 text-success" },
              stale: { key: "stale", cls: "bg-warning/15 text-warning" },
            }[state];
            return (
              <li
                key={account.slot}
                data-testid="connector-account-row"
                data-slot={account.slot}
                data-active={account.active ? "1" : "0"}
                className="flex flex-wrap items-center gap-2 rounded-md border border-border/60 px-3 py-2"
              >
                <Icon name="plug" size={14} className="text-muted-foreground" />
                <span className="text-sm max-w-[16rem] truncate" title={account.slot}>
                  {account.slot}
                </span>
                {account.active && (
                  <span
                    data-testid="connector-active-badge"
                    className="text-xs px-2 py-0.5 rounded-full bg-primary/10 text-primary"
                  >
                    {t("extensions.connector.activeBadge")}
                  </span>
                )}
                <span data-testid="connector-state-badge" className={`text-xs px-2 py-0.5 rounded-full ${badge.cls}`}>
                  {t(`extensions.connector.state.${badge.key}`)}
                </span>
                {account.updatedAt && (
                  <span className="text-xs text-muted-foreground">
                    {t("extensions.connector.updated", { date: new Date(account.updatedAt).toLocaleString() })}
                  </span>
                )}

                <div className="flex-1" />

                {!account.active && !account.stale && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => run(() => setActiveConnectorAccount(account.slot))}
                    data-testid="connector-set-active"
                  >
                    {t("extensions.connector.setActive")}
                  </Button>
                )}
                {account.stale && zeroPasteAvailable && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy || connecting}
                    onClick={() => run(connectConnectorAccount)}
                    data-testid="connector-reconnect"
                  >
                    {t("extensions.connector.reconnect")}
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => run(() => disconnectConnector(account.slot))}
                  data-testid="connector-disconnect"
                >
                  {t("extensions.connector.disconnect")}
                </Button>
              </li>
            );
          })}
        </ul>
      )}

      {accounts.length > 0 && !accounts.some((a) => a.active) && (
        <p className="text-xs text-muted-foreground mt-2" data-testid="connector-no-active-hint">
          {t("extensions.connector.noActiveHint")}
        </p>
      )}

      {accounts.length === 0 && (
        <p className="text-xs text-muted-foreground mt-2" data-testid="connector-empty-hint">
          {zeroPasteAvailable
            ? t("extensions.connector.emptyHintZeroPaste")
            : t("extensions.connector.emptyHintPasteOnly")}
        </p>
      )}

      {/* Manual paste — the collapsed, always-available fallback. */}
      {pasteOpen && (
        <div className="mt-3 space-y-2 border-t border-border pt-3">
          <Label htmlFor="connector-token">{t("extensions.connector.tokenLabel")}</Label>
          <div className="flex gap-2">
            <Input
              id="connector-token"
              value={token}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setToken(e.target.value)}
              placeholder={t("extensions.connector.tokenPlaceholder")}
              data-testid="connector-token-input"
            />
            <Input
              id="connector-slot"
              value={pasteSlot}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setPasteSlot(e.target.value)}
              placeholder={t("extensions.connector.slotPlaceholder")}
              className="w-40 shrink-0"
              data-testid="connector-slot-input"
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
