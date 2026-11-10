// CiyuanAccountConnectPanel.tsx — the 词元 (萬星·词元) account card
// (ciyuan-account-lane). Zero-paste: the user types their 词元 email + password
// once; the platform server logs in and mints a key server-side and stores only
// the key (the password never persists anywhere — the field is cleared the
// moment the request returns). In a hosted cell the bound key drives the model
// lane (the user's own 词元 quota bills their chats); in a shared single-process
// deployment the card says so and the account only serves the operations MCP.
// A pasted `sk-` key stays available as the escape hatch when 词元 login is down
// (same validation as the retired 萬星 Caller row).

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Icon } from "@/components/ui/icon";
import type { CiyuanAccountConnection } from "@platform/core";
import {
  connectCiyuanAccount,
  disconnectCiyuanAccount,
  fetchCiyuanAccount,
  saveLineCredential,
  testCiyuanAccount,
} from "@platform/core";

interface CiyuanAccountConnectPanelProps {
  compact?: boolean;
  className?: string;
}

type Busy = "connect" | "test" | "disconnect" | "paste" | null;

function stateOf(conn: CiyuanAccountConnection | null): "unknown" | "connected" | "stale" | "disconnected" {
  if (!conn) return "unknown";
  if (conn.connected) return "connected";
  if (conn.stale) return "stale";
  return "disconnected";
}

export function CiyuanAccountConnectPanel({ compact = false, className = "" }: CiyuanAccountConnectPanelProps) {
  const { t } = useTranslation();
  const [conn, setConn] = useState<CiyuanAccountConnection | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [pasteKey, setPasteKey] = useState("");
  const [showPaste, setShowPaste] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState<Busy>(null);

  const refresh = useCallback(async () => {
    try {
      setConn(await fetchCiyuanAccount());
    } catch {
      // leave the card unknown — never claim "not connected" before known
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const run = async (kind: Exclude<Busy, null>, fn: () => Promise<CiyuanAccountConnection>) => {
    setError("");
    setNotice("");
    setBusy(kind);
    try {
      setConn(await fn());
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(null);
    }
  };

  const connect = async () => {
    const ok = await run("connect", () => connectCiyuanAccount(email.trim(), password));
    // The password is single-use by design: clear it whether or not the bind
    // succeeded so it never lingers in the form.
    setPassword("");
    if (ok) setEmail("");
  };

  const paste = async () => {
    const ok = await run("paste", async () => {
      await saveLineCredential("wanxing-caller", pasteKey.trim());
      return fetchCiyuanAccount();
    });
    if (ok) {
      setPasteKey("");
      setShowPaste(false);
    }
  };

  const test = async () => {
    const ok = await run("test", testCiyuanAccount);
    if (ok) setNotice(t("settings.ciyuanAccount.testDone", "已测试"));
  };

  const disconnect = async () => {
    const ok = await run("disconnect", disconnectCiyuanAccount);
    if (ok) setNotice(t("settings.ciyuanAccount.revokeHint", "本地凭据已删除。词元侧的调用键仍有效，可到 token.finddatatech.cloud 吊销。"));
  };

  const state = stateOf(conn);
  const needsBind = state === "disconnected" || state === "stale";

  return (
    <div className={className || "rounded-md border border-border p-3"} data-testid="ciyuan-account-card">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Icon name="sparkles" size={16} className="text-muted-foreground" />
          {t("settings.ciyuanAccount.title", "萬星·词元 账号")}
        </div>
        <span data-testid="ciyuan-account-state" data-state={state} className="text-xs text-muted-foreground">
          {state === "connected"
            ? t("settings.ciyuanAccount.connected", "已连接")
            : state === "stale"
              ? t("settings.ciyuanAccount.stale", "需重连")
              : state === "disconnected"
                ? t("settings.ciyuanAccount.notConnected", "未连接")
                : t("settings.lines.unknown", "…")}
        </span>
      </div>
      <div className="mt-1 text-xs text-muted-foreground">
        {t("settings.ciyuanAccount.hint", "绑定你的词元账号：模型、搜索、语音按车道用同一把钥匙，额度随你的套餐。")}
      </div>

      {conn && (conn.connected || conn.stale) && (
        <div className="mt-2 flex flex-col gap-1 text-xs text-muted-foreground" data-testid="ciyuan-account-details">
          {conn.source === "account" && (
            <div>
              {t("settings.ciyuanAccount.keyLine", "调用键")} <span className="font-mono">{conn.keyName ?? "—"}</span>
              {conn.mintedAt ? ` · ${new Date(conn.mintedAt).toLocaleDateString()}` : ""}
              {conn.ciyuanEmailMasked ? ` · ${conn.ciyuanEmailMasked}` : ""}
            </div>
          )}
          {conn.source === "pasted-key" && <div>{t("settings.ciyuanAccount.pastedSource", "来源：手动粘贴的调用键")}</div>}
          <div data-testid="ciyuan-account-lane-note">
            {conn.modelLaneForm === "cell"
              ? t("settings.ciyuanAccount.laneCell", "模型车道按你的词元额度计费；断开后回到部署密钥。")
              : t("settings.ciyuanAccount.laneShared", "本部署为单进程形态：账号仅用于运维工具，模型车道仍走部署密钥。")}
          </div>
        </div>
      )}

      {needsBind && (
        <form
          className="mt-2 flex flex-col gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            void connect();
          }}
        >
          <div className="flex flex-wrap items-center gap-1.5">
            <Input
              type="email"
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder={t("settings.ciyuanAccount.emailPlaceholder", "词元登录邮箱")}
              className="h-7 w-48 text-xs"
              data-testid="ciyuan-account-email"
            />
            <Input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={t("settings.ciyuanAccount.passwordPlaceholder", "词元密码")}
              className="h-7 w-40 text-xs"
              data-testid="ciyuan-account-password"
            />
            <Button type="submit" size="sm" disabled={busy !== null || !email.trim() || !password} data-testid="ciyuan-account-connect">
              {busy === "connect"
                ? t("settings.ciyuanAccount.connecting", "绑定中…")
                : state === "stale"
                  ? t("settings.ciyuanAccount.rebind", "重新绑定")
                  : t("settings.ciyuanAccount.bind", "绑定账号")}
            </Button>
          </div>
          <div className="text-[11px] text-muted-foreground">
            {t("settings.ciyuanAccount.passwordNote", "密码只用于这一次登录换取调用键，不会保存。")}
          </div>
        </form>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {conn && (conn.connected || conn.stale) && (
          <>
            <Button variant="outline" size="sm" disabled={busy !== null} onClick={test} data-testid="ciyuan-account-test">
              {busy === "test" ? t("settings.ciyuanAccount.testing", "测试中…") : t("settings.ciyuanAccount.test", "测试连接")}
            </Button>
            <Button variant="outline" size="sm" disabled={busy !== null} onClick={disconnect} data-testid="ciyuan-account-disconnect">
              {t("common.disconnect", "断开")}
            </Button>
          </>
        )}
        {needsBind &&
          (showPaste ? (
            <div className="flex items-center gap-1.5">
              <Input
                value={pasteKey}
                onChange={(e) => setPasteKey(e.target.value)}
                placeholder="sk-…"
                className="h-7 w-44 font-mono text-xs"
                data-testid="ciyuan-account-paste-input"
              />
              <Button size="sm" variant="outline" disabled={busy !== null || !pasteKey.trim()} onClick={paste} data-testid="ciyuan-account-paste">
                {t("settings.lines.save", "保存")}
              </Button>
            </div>
          ) : (
            <button
              type="button"
              className="text-xs text-muted-foreground underline-offset-2 hover:underline"
              onClick={() => setShowPaste(true)}
              data-testid="ciyuan-account-paste-toggle"
            >
              {t("settings.ciyuanAccount.pasteInstead", "已有调用键？直接粘贴")}
            </button>
          ))}
      </div>

      {conn?.probe && (
        <div className="mt-1 text-xs text-muted-foreground" data-testid="ciyuan-account-probe">
          {t("settings.ciyuanAccount.probe", "探测")}: {conn.probe.detail}
        </div>
      )}
      {error && <div className="mt-2 text-xs text-destructive" data-testid="ciyuan-account-error">{error}</div>}
      {notice && <div className="mt-2 text-xs text-muted-foreground" data-testid="ciyuan-account-notice">{notice}</div>}
      {!compact && (
        <div className="mt-1 text-xs text-muted-foreground">
          {t("settings.ciyuanAccount.footnote", "调用键 401 时标记为需重连，重新绑定即铸新键；绑定的账号优先于手动粘贴的键。")}
        </div>
      )}
    </div>
  );
}
