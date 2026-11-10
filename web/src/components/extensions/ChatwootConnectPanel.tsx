// ChatwootConnectPanel.tsx
// The merchant's own Chatwoot BYOK card (add-crm-desk-pack-embed task 2.1):
// one pasted API token (tool face + gated send) plus optional login
// email/password used ONLY by the embed's server-side sign-in. Paste-family
// semantics — never echoed back, re-paste recovers a 401-stale row. Local
// fetch state on purpose: the card is self-contained and the /api/connections
// aggregation serves the badges elsewhere.

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Icon } from "@/components/ui/icon";

interface ChatwootConnection {
  ref: string;
  connected: boolean;
  stale: boolean;
  hasLoginCredentials: boolean;
}

interface ChatwootConnectPanelProps {
  compact?: boolean;
  className?: string;
}

export function ChatwootConnectPanel({ compact = false, className = "" }: ChatwootConnectPanelProps) {
  const { t } = useTranslation();
  const [conn, setConn] = useState<ChatwootConnection | null>(null);
  const [token, setToken] = useState("");
  const [loginEmail, setLoginEmail] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch("/api/chatwoot/connection");
      if (r.ok) setConn(await r.json());
    } catch {
      // unreachable platform — the card stays in its last known state
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const submit = async () => {
    if (!token.trim()) return;
    setError("");
    setBusy(true);
    try {
      const r = await fetch("/api/chatwoot/connection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token: token.trim(),
          ...(loginEmail.trim() ? { loginEmail: loginEmail.trim() } : {}),
          ...(loginPassword ? { loginPassword } : {}),
        }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      setToken("");
      setLoginPassword("");
      await refresh();
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
      await fetch("/api/chatwoot/connection", { method: "DELETE" });
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // Unknown (not fetched / unauthenticated) renders nothing — never claim
  // "not connected" before the state is known.
  if (!conn) return null;
  const state = conn.stale ? "stale" : conn.connected ? "connected" : "disconnected";

  return (
    <div
      data-testid="chatwoot-connect-panel"
      data-chatwoot-state={state}
      className={className || (compact ? "" : "rounded-md border border-border p-3")}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Icon name="inbox" size={16} className="text-muted-foreground" />
          {t("extensions.chatwoot.title")}
        </div>
        <span className="text-xs text-muted-foreground">
          {conn.stale
            ? t("extensions.chatwoot.staleBadge")
            : conn.connected
              ? t("extensions.chatwoot.connected")
              : t("extensions.chatwoot.notConnected")}
        </span>
      </div>

      {conn.connected ? (
        <div className="mt-2 flex items-center justify-between gap-2">
          <div className="text-xs text-muted-foreground">
            {conn.hasLoginCredentials ? t("extensions.chatwoot.loginReady") : t("extensions.chatwoot.tokenOnly")}
          </div>
          <Button variant="outline" size="sm" disabled={busy} onClick={disconnect} data-testid="chatwoot-disconnect">
            {t("extensions.chatwoot.disconnect")}
          </Button>
        </div>
      ) : (
        <div className="mt-2 space-y-2">
          <Label htmlFor="chatwoot-token" className="text-xs text-muted-foreground">
            {t("extensions.chatwoot.tokenLabel")}
          </Label>
          <Input
            id="chatwoot-token"
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder={t("extensions.chatwoot.tokenPlaceholder")}
            data-testid="chatwoot-token-input"
          />
          <p className="text-xs text-muted-foreground">{t("extensions.chatwoot.pasteHint")}</p>
          <details className="text-xs text-muted-foreground">
            <summary className="cursor-pointer">{t("extensions.chatwoot.loginSection")}</summary>
            <div className="mt-2 space-y-2">
              <Label htmlFor="chatwoot-login-email" className="text-xs text-muted-foreground">
                {t("extensions.chatwoot.loginEmail")}
              </Label>
              <Input
                id="chatwoot-login-email"
                type="email"
                value={loginEmail}
                onChange={(e) => setLoginEmail(e.target.value)}
                autoComplete="off"
              />
              <Label htmlFor="chatwoot-login-password" className="text-xs text-muted-foreground">
                {t("extensions.chatwoot.loginPassword")}
              </Label>
              <Input
                id="chatwoot-login-password"
                type="password"
                value={loginPassword}
                onChange={(e) => setLoginPassword(e.target.value)}
                autoComplete="new-password"
              />
              <p>{t("extensions.chatwoot.loginHint")}</p>
            </div>
          </details>
          {error && (
            <p className="text-xs text-destructive" data-testid="chatwoot-connect-error">
              {error}
            </p>
          )}
          <Button size="sm" disabled={busy || !token.trim()} onClick={submit} data-testid="chatwoot-connect-save">
            {t("extensions.chatwoot.save")}
          </Button>
        </div>
      )}
    </div>
  );
}
