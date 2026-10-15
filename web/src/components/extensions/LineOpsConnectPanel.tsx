// LineOpsConnectPanel.tsx
// The line operation-MCP credential cards (line-credentials): 柏讯（wire）/识律（lex）
// connect through the SERVER-MEDIATED mint — a full-page authorization-code
// round trip (prompt=none while the shared Logto session lives, one interactive
// consent ever) that lands back on /settings/mcp; the server does the code→token
// exchange, so no token ever passes through browser JS. 萬星 caller is a pasted
// long-lived sk- key (billing panel). ID tokens are short-lived — the platform
// omits those MCP servers when a token expires, so the card says "自动续期"
// and the next connect click re-mints silently. Rendered beside the registry /
// connector / facet-market cards.

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Icon } from "@/components/ui/icon";
import type { LineConnection, LineName } from "@platform/core";
import { disconnectLine, fetchLineConnection, saveLineCredential } from "@platform/core";
import { startLineMint, takeLineMintError, type MintLine } from "@/lib/line-mint";

interface LineOpsConnectPanelProps {
  compact?: boolean;
  className?: string;
}

const MINT_LINES: Array<{ line: LineName; title: string; hint: string }> = [
  { line: "wire-customer", title: "柏讯操作", hint: "需求单/数据查询/市场订阅的凭据（静默铸造，自动续期）" },
  { line: "lex", title: "识律操作", hint: "账户/用量/检索凭据管理的凭据（静默铸造，自动续期）" },
];

const CALLER_LINE: LineName = "wanxing-caller";

export function LineOpsConnectPanel({ compact = false, className = "" }: LineOpsConnectPanelProps) {
  const { t } = useTranslation();
  const [mintStates, setMintStates] = useState<Partial<Record<LineName, LineConnection | null>>>({});
  const [caller, setCaller] = useState<LineConnection | null>(null);
  const [callerKey, setCallerKey] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<LineName | null>(null);
  const [showPaste, setShowPaste] = useState(false);

  const refresh = useCallback(async () => {
    for (const line of ["wire-customer", "lex", CALLER_LINE] as LineName[]) {
      try {
        const conn = await fetchLineConnection(line);
        if (line === CALLER_LINE) setCaller(conn);
        else setMintStates((prev) => ({ ...prev, [line]: conn }));
      } catch {
        // leave that card unknown — never claim "not connected" before known
      }
    }
  }, []);

  // Self-fetch once; a mint-failure marker left by the callback redirect turns
  // into one readable line.
  useEffect(() => {
    const failed = takeLineMintError();
    if (failed) setError(t("settings.lines.mintFailed", "连接未完成——请重试"));
    void refresh();
  }, [refresh, t]);

  const connectMint = (line: LineName) => {
    setError("");
    setBusy(line);
    // Full-page round trip; the settings deep-link is where it comes back.
    startLineMint(line as MintLine);
  };

  const pasteCaller = async () => {
    setError("");
    setBusy(CALLER_LINE);
    try {
      await saveLineCredential(CALLER_LINE, callerKey.trim());
      setCallerKey("");
      setShowPaste(false);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const disconnect = async (line: LineName) => {
    setError("");
    setBusy(line);
    try {
      await disconnectLine(line);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const row = (title: string, hint: string, conn: LineConnection | null | undefined, actions: React.ReactNode) => (
    <div className="border-t border-border/60 py-2 first:border-t-0">
      <div className="flex items-center justify-between gap-2">
        <div className="text-sm font-medium">{title}</div>
        {conn ? (
          <span className="text-xs text-muted-foreground">
            {conn.connected
              ? conn.expiresAt
                ? t("settings.lines.connectedUntil", "已连接 · 至") + " " + new Date(conn.expiresAt).toLocaleString()
                : t("settings.lines.connected", "已连接")
              : conn.stale
                ? t("settings.lines.stale", "已失效——请重连")
                : t("settings.lines.notConnected", "未连接")}
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">{t("settings.lines.unknown", "…")}</span>
        )}
      </div>
      <div className="mt-1 flex items-center justify-between gap-2">
        <div className="text-xs text-muted-foreground">{hint}</div>
        <div className="flex items-center gap-1.5">{actions}</div>
      </div>
    </div>
  );

  return (
    <div className={className || "rounded-md border border-border p-3"}>
      <div className="flex items-center gap-2 text-sm font-medium">
        <Icon name="sparkles" size={16} className="text-muted-foreground" />
        {t("settings.lines.title", "产品线操作")}
        <span className="text-xs text-muted-foreground">
          {t("settings.lines.subtitle", "各线操作 MCP 的凭据")}
        </span>
      </div>

      {MINT_LINES.map(({ line, title, hint }) => {
        const conn = mintStates[line];
        return row(
          title,
          hint,
          conn,
          conn?.connected ? (
            <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => disconnect(line)}>
              {t("common.disconnect", "断开")}
            </Button>
          ) : (
            <Button size="sm" disabled={busy !== null} onClick={() => connectMint(line)}>
              {busy === line ? t("settings.lines.connecting", "连接中…") : t("settings.lines.connect", "连接")}
            </Button>
          ),
        );
      })}

      {row(
        t("settings.lines.wanxingCaller", "萬星 Caller"),
        t("settings.lines.wanxingCallerHint", "發起萬星回合用的计费 key（token.finddatatech.cloud 自铸）"),
        caller,
        caller?.connected ? (
          <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => disconnect(CALLER_LINE)}>
            {t("common.disconnect", "断开")}
          </Button>
        ) : showPaste ? (
          <div className="flex items-center gap-1.5">
            <Input
              value={callerKey}
              onChange={(e) => setCallerKey(e.target.value)}
              placeholder="sk-…"
              className="h-7 w-40 font-mono text-xs"
            />
            <Button size="sm" disabled={busy !== null || !callerKey.trim()} onClick={pasteCaller}>
              {t("settings.lines.save", "保存")}
            </Button>
          </div>
        ) : (
          <Button size="sm" onClick={() => setShowPaste(true)}>
            {t("settings.lines.pasteKey", "粘贴 key")}
          </Button>
        ),
      )}

      {error && <div className="mt-2 text-xs text-destructive">{error}</div>}
      {!compact && (
        <div className="mt-1 text-xs text-muted-foreground">
          {t(
            "settings.lines.footnote",
            "短命 ID token 过期时对应工具暂不可用，点「连接」即静默重铸（Logto 会话在则无需交互）；萬星 caller key 401 时需重贴。",
          )}
        </div>
      )}
      <Label className="hidden" />
    </div>
  );
}
