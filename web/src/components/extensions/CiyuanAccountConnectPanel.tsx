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
      // 写路径（连接/探测/断开/粘贴）的响应不带额度段——它只在 GET /connection 上读，
      // 免得未绑定也去打上游。所以成功后必须再读一次，否则刚绑完的这一刻
      // 额度/峰谷/吞吐三行都不出现，要等下次进页面才看得见。
      void refresh();
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
  // 额度软读只在 GET /connection 上带；缺数据一律显示「无数据」，绝不渲染成 $0.00
  // （openspec/changes/ciyuan-consumer-surface/specs/ciyuan-line-metering）。
  const ent = conn?.entitlement ?? null;
  const noData = t("settings.ciyuanAccount.noData", "无数据");
  const usd = (v: number) => `$${v.toFixed(2)}`;

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
          {/* 来源必须可辨：三种来源是对客户的**不同承诺**，不能合并成一句「已绑定」。
              粘贴 = 我们从未见过你的密码；代铸 = 密码已立即丢弃。
              这两句话的分量不同，客户有权知道自己属于哪一种。 */}
          {conn.source === "pasted-key" && (
            <div data-testid="ciyuan-account-source" data-source="pasted-key">
              {t("settings.ciyuanAccount.pastedSource", "来源：你自建的调用键（我们在整个过程中没有接触过你的密码）")}
            </div>
          )}
          {conn.source === "account" && (
            <div data-testid="ciyuan-account-source" data-source="account">
              {t("settings.ciyuanAccount.mintedSource", "来源：由平台代为创建（密码在绑定后立即丢弃，未落库、未记日志）")}
            </div>
          )}
          <div data-testid="ciyuan-account-lane-note" data-lane-form={conn.modelLaneForm ?? "shared"}>
            {/* 三态，不是二态：cell 与 single-tenant 都能让模型走自己的额度，差别在
                断了之后 —— cell 回落部署 key，single-tenant 没有可回落的（那正是它
                被买的意义）。shared 是「绑了也不影响计费」的诚实说明。 */}
            {conn.modelLaneForm === "cell"
              ? t("settings.ciyuanAccount.laneCell", "模型车道按你的词元额度计费；断开后回到部署密钥。")
              : conn.modelLaneForm === "single-tenant"
                ? t("settings.ciyuanAccount.laneSingleTenant", "本部署为专属单租户实例：模型车道按你自己的词元额度计费。没有可回落的平台密钥——词元不可达时对话不可用，并如实说明原因。")
                : t("settings.ciyuanAccount.laneShared", "本部署为单进程形态：账号仅用于运维工具，模型车道仍走部署密钥。")}
          </div>
          {ent && (
            <div className="mt-1 flex flex-col gap-0.5" data-testid="ciyuan-account-entitlement" data-unavailable={ent.unavailableReason ?? "none"}>
              <div>
                {t("settings.ciyuanAccount.balance", "余额")}{" "}
                <span className="font-mono" data-testid="ciyuan-account-balance">
                  {ent.limits ? usd(ent.limits.balanceUsd) : noData}
                </span>
                {ent.limits?.keyQuotaUsd != null && (
                  <span className="ml-2" data-testid="ciyuan-account-quota">
                    {t("settings.ciyuanAccount.keyQuota", "调用键额度")}{" "}
                    <span className="font-mono">
                      {usd(ent.limits.keyQuotaUsedUsd ?? 0)} / {usd(ent.limits.keyQuotaUsd)}
                    </span>
                  </span>
                )}
                {ent.limits?.quotaUnlimited && (
                  <span className="ml-2">{t("settings.ciyuanAccount.quotaUnlimited", "调用键额度不限")}</span>
                )}
              </div>
              {ent.lanes && (
                <div data-testid="ciyuan-account-lanes">
                  {t("settings.ciyuanAccount.lanes", "车道")}{" "}
                  {Object.entries(ent.lanes)
                    .map(([lane, available]) =>
                      `${lane}=${available === true ? t("settings.ciyuanAccount.laneOn", "可用") : available === false ? t("settings.ciyuanAccount.laneOff", "不可用") : t("settings.ciyuanAccount.laneUnknown", "未知")}`,
                    )
                    .join(" · ")}
                </div>
              )}
              {ent.pricing && (
                <div data-testid="ciyuan-account-pricing" data-state={ent.offpeak?.state ?? "unknown"}>
                  {t("settings.ciyuanAccount.pricing", "峰谷价")}{" "}
                  <span className="font-mono">
                    {ent.offpeak?.state === "offpeak"
                      ? `${t("settings.ciyuanAccount.pricingOffpeak", "当前处于低谷")} ×${(ent.offpeak.multiplier ?? 1).toFixed(2)}`
                      : ent.offpeak?.state === "peak"
                        ? `${t("settings.ciyuanAccount.pricingPeak", "当前为高峰")} ×${(ent.offpeak.multiplier ?? 1).toFixed(2)}`
                        : noData}
                  </span>
                  {ent.offpeak?.state !== "unknown" && ent.offpeak?.until && (
                    <span className="ml-1">
                      {t("settings.ciyuanAccount.until", "直到")} {new Date(ent.offpeak.until).toLocaleString()}
                    </span>
                  )}
                </div>
              )}
              {ent.capacity && (
                <div data-testid="ciyuan-account-capacity">
                  {t("settings.ciyuanAccount.capacity", "观测吞吐")}{" "}
                  <span className="font-mono">{ent.capacity.model}</span>{" "}
                  {/* 样本不足 ⇒ 无数据，绝不渲染成 0 rps */}
                  {ent.capacity.sustainableRps == null
                    ? noData
                    : `${ent.capacity.sustainableRps.toFixed(2)} rps`}
                  {ent.capacity.errorRatio != null && ` · ${(ent.capacity.errorRatio * 100).toFixed(1)}%`}
                  {` (${ent.capacity.sampleActiveMinutes}min${ent.capacity.confidence ? `, ${ent.capacity.confidence}` : ""})`}
                </div>
              )}
              <div className="text-[10px] opacity-70" data-testid="ciyuan-account-read-at">
                {ent.readAt
                  ? `${t("settings.ciyuanAccount.readAt", "读取于")} ${new Date(ent.readAt).toLocaleString()}`
                  : t("settings.ciyuanAccount.noDataHint", "未取到词元额度（不影响调用，余额硬顶在词元侧）")}
              </div>
            </div>
          )}
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
