// FacetMarketConnectPanel.tsx
// The 谦面市场 device credential card (facet-market-credentials, C1.1-B):
// one device identity per user — pair by the 6-digit bind code minted on the
// facet market's settings page; the server owns the Ed25519 key and mints
// 12h tokens silently. No token ever transits the browser: the card only
// ever submits a bind code and renders state. Rendered beside the registry /
// connector cards so all three MCP credential surfaces share one mental
// model.

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useExtensionsStore } from "@/hooks/useExtensionsStore";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Icon } from "@/components/ui/icon";

interface FacetMarketConnectPanelProps {
  compact?: boolean;
  className?: string;
}

export function FacetMarketConnectPanel({ compact = false, className = "" }: FacetMarketConnectPanelProps) {
  const { t } = useTranslation();
  const { facetMarketConnection, refreshFacetMarketConnection, pairFacetMarket, disconnectFacetMarket } =
    useExtensionsStore();

  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  // Self-fetch once — mount-safe everywhere (same rule as the connector card).
  useEffect(() => {
    refreshFacetMarketConnection();
  }, [refreshFacetMarketConnection]);

  // Unknown (not fetched / unauthenticated) renders nothing — never claim
  // "not connected" before the state is known.
  if (!facetMarketConnection) return null;
  const conn = facetMarketConnection;

  const pair = async () => {
    setError("");
    setBusy(true);
    try {
      await pairFacetMarket(code.trim());
      setCode("");
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
      await disconnectFacetMarket();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const facetSettingsUrl = conn.facetUrl
    ? `${conn.facetUrl}${conn.bindPath || "/settings/devices"}`
    : null;

  return (
    <div className={className || "rounded-md border border-border p-3"}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Icon name="sparkles" size={16} className="text-muted-foreground" />
          {t("settings.facetMarket.title", "谦面市场")}
        </div>
        {conn.connected ? (
          <span className="text-xs text-muted-foreground">
            {t("settings.facetMarket.connectedAs", "已连接")} · {conn.facetAccount ?? ""}
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">
            {t("settings.facetMarket.notConnected", "未连接")}
          </span>
        )}
      </div>

      {conn.connected ? (
        <div className="mt-2 flex items-center justify-between gap-2">
          <div className="text-xs text-muted-foreground">
            {conn.stale
              ? t("settings.facetMarket.staleHint", "设备被吊销——请重新配对")
              : t("settings.facetMarket.silentHint", "凭据自动续期，无需干预")}
          </div>
          <Button variant="outline" size="sm" disabled={busy} onClick={disconnect}>
            {t("common.disconnect", "断开")}
          </Button>
        </div>
      ) : (
        <div className="mt-2 space-y-2">
          <Label htmlFor="facet-market-bindcode" className="text-xs text-muted-foreground">
            {t("settings.facetMarket.pairHint", "在谦面市场设置页生成 6 位绑定码，填入此处完成配对")}
          </Label>
          <div className="flex items-center gap-2">
            <Input
              id="facet-market-bindcode"
              inputMode="numeric"
              maxLength={6}
              placeholder="000000"
              value={code}
              disabled={busy}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              onKeyDown={(e) => {
                if (e.key === "Enter" && /^\d{6}$/.test(code)) void pair();
              }}
              className="w-28 font-mono tracking-widest"
            />
            <Button size="sm" disabled={busy || !/^\d{6}$/.test(code)} onClick={pair}>
              {t("settings.facetMarket.pair", "配对")}
            </Button>
            {facetSettingsUrl && (
              <a
                href={facetSettingsUrl}
                target="_blank"
                rel="noreferrer"
                className="ml-auto text-xs underline underline-offset-2 text-muted-foreground"
              >
                {t("settings.facetMarket.openSettings", "打开市场设置 →")}
              </a>
            )}
          </div>
        </div>
      )}

      {!compact && conn.tokenExpiresAt != null && conn.connected && (
        <div className="mt-1 text-xs text-muted-foreground">
          {t("settings.facetMarket.tokenUntil", "凭据有效期至")}{" "}
          {new Date(conn.tokenExpiresAt).toLocaleString()}
        </div>
      )}

      {error && <div className="mt-2 text-xs text-destructive">{error}</div>}
    </div>
  );
}
