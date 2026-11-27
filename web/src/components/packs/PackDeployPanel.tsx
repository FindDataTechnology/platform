// ── 部署面板（pack-detail-as-page 6.0）─────────────────────────────────────────
//
// 从 PackDetailDialog 原样迁出的一段：计费读数、每岗密钥粘贴、节奏/模型/预算覆盖、
// 部署行与暂停、绑定授予结果。它是「装进自己的 cell 并让岗位真的跑起来」的全部，
// 也是 5 条 pack-deploy-config e2e 驱动的东西——所以迁移时行为一字不动，只换了容器。
//
// 只在能装进 cell 的宿主渲染：facet 匿名壳没有安装面，探测与按钮都不该存在。
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import * as api from "@/lib/packs-api";
import type { DeployBindingReport, PackDeployment, PackDetail } from "@/lib/packs-api";
import { Button } from "@/components/ui/button";
import { RhythmEditor, rhythmEntryValid, type RhythmEntry } from "./RhythmEditor";

// The 万星 console deep link (agent-service-config): the deployment's slug and
// the console origin. The slug rule mirrors the serving side's slugFor
// (fd-wanxing wanxing-facade core.js) — a minimal copy, keep the two in
// lockstep (the same discipline the console's setPaused copy follows).
const wanxingConsoleBase = () => import.meta.env.VITE_WANXING_CONSOLE_URL || "https://wanxing.finddatatech.cloud";
const wanxingSlugFor = (agentPath: string) =>
  String(agentPath).replace(/^\/+/, "").replace(/[^A-Za-z0-9._-]+/g, "-").toLowerCase();

// Budget draft rule (add-deploy-form-model-budget D2) — a client mirror of
// the platform's budgetMinutesError: positive whole minutes, cap 120.
const BUDGET_MAX_MINUTES = 120;
function budgetDraftValid(text: string): boolean {
  if (!/^\d+$/.test(text)) return false;
  const n = Number(text);
  return n > 0 && n <= BUDGET_MAX_MINUTES;
}

// Deployment-scoped connector bindings (add-deployment-binding-grant). The
// deploy answer names what it granted and what it could not; the reason codes
// are the platform's `mintBindingToken` refusals, and each one has a different
// fix, so they are not collapsed into "failed".
function hasBindingReport(report: DeployBindingReport): boolean {
  return report.granted.length > 0 || report.failed.length > 0 || (report.revoked ?? 0) > 0;
}

function uniqueKeys(rows: { bindingKey: string }[]): string {
  return [...new Set(rows.map((r) => r.bindingKey))].join(", ");
}

const BINDING_REASON_KEYS = new Set(["no_account", "empty_scope", "connector_not_configured"]);

function bindingReasonLabel(code: string, t: (key: string, options?: Record<string, unknown>) => string): string {
  return BINDING_REASON_KEYS.has(code)
    ? t(`packs.detail.bindingReason.${code}`)
    : t("packs.detail.bindingReason.other", { code });
}

export function PackDeployPanel({ pack }: { pack: PackDetail }) {
  const { t } = useTranslation();
  const m = pack.manifest;
  const packId = pack.id;
  const servingAgents = (m?.agents ?? []).filter((a) => a.serving);

  const [deployments, setDeployments] = useState<PackDeployment[]>([]);
  const [deploying, setDeploying] = useState(false);
  const [deployNote, setDeployNote] = useState<string | null>(null);
  const [bindingReport, setBindingReport] = useState<DeployBindingReport | null>(null);
  const [overrides, setOverrides] = useState<Record<string, RhythmEntry[]>>({});
  const [modelDrafts, setModelDrafts] = useState<Record<string, string>>({});
  const [budgetDrafts, setBudgetDrafts] = useState<Record<string, string>>({});
  const [pauseBusy, setPauseBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [billing, setBilling] = useState<api.MyBillingState | null>(null);
  const [bindings, setBindings] = useState<Record<string, boolean> | null>(null);
  const [keyDrafts, setKeyDrafts] = useState<Record<string, string>>({});
  // Serving capability (add-selfhost-funnel-guidance, F3.1): a self-hosted
  // instance without agent serving renders the official-market guidance panel
  // — the raw "not configured" error never surfaces.
  const [servingReady, setServingReady] = useState<boolean | null>(null);

  useEffect(() => {
    let live = true;
    api.getPackDeployments(packId).then((d) => live && setDeployments(d.deployments ?? [])).catch(() => live && setDeployments([]));
    api.myBillingState().then((b) => live && setBilling(b)).catch(() => live && setBilling(null));
    api.getBillingBindings(packId).then((b) => live && setBindings(b)).catch(() => live && setBindings(null));
    api.getServingStatus().then((d) => live && setServingReady(Boolean(d.configured))).catch(() => live && setServingReady(true));
    return () => {
      live = false;
    };
  }, [packId]);

  // Any invalid budget draft freezes the deploy submit (add-deploy-form-
  // model-budget D2): a scalar typo meets its error in the form, never
  // server-side. Empty drafts are fine (empty = the dimension rides no map).
  const anyBudgetInvalid = servingAgents.some((a) => {
    const d = (budgetDrafts[a.id] ?? "").trim();
    return d.length > 0 && !budgetDraftValid(d);
  });

  const deploy = useCallback(async () => {
    setDeploying(true);
    setError(null);
    setDeployNote(null);
    try {
      const rhythms: Record<string, RhythmEntry[]> = {};
      for (const [agentId, entries] of Object.entries(overrides)) {
        const valid = (entries ?? []).filter(rhythmEntryValid);
        if (valid.length > 0) rhythms[agentId] = valid;
      }
      // Pasted keys (revise-billing-key-acquisition): non-empty drafts only —
      // omitted agents keep their existing binding (absent=keep).
      const billingKeys: Record<string, string> = {};
      for (const a of servingAgents) {
        const draft = (keyDrafts[a.id] ?? "").trim();
        if (draft) billingKeys[a.id] = draft;
      }
      const models: Record<string, string> = {};
      for (const a of servingAgents) {
        const draft = (modelDrafts[a.id] ?? "").trim();
        if (draft) models[a.id] = draft;
      }
      // Budget drafts: a single scalar where silently dropping an invalid
      // value would second-guess the deployer — the submit button is already
      // disabled while any draft is invalid, and this is the race-proof gate.
      const budgets: Record<string, number> = {};
      for (const a of servingAgents) {
        const draft = (budgetDrafts[a.id] ?? "").trim();
        if (!draft) continue;
        if (!budgetDraftValid(draft)) {
          setError(t("packs.detail.budgetInvalid", { defaultValue: "turn budget must be whole minutes, 1–120" }));
          return;
        }
        budgets[a.id] = Number(draft);
      }
      const out = await api.deployPack(
        packId,
        pack.version,
        Object.keys(rhythms).length > 0 ? rhythms : undefined,
        Object.keys(billingKeys).length > 0 ? billingKeys : undefined,
        Object.keys(models).length > 0 ? models : undefined,
        Object.keys(budgets).length > 0 ? budgets : undefined,
      );
      const d = await api.getPackDeployments(packId);
      setDeployments(d.deployments ?? []);
      setKeyDrafts({});
      setModelDrafts({});
      setBudgetDrafts({});
      api.getBillingBindings(packId).then(setBindings).catch(() => {});
      setBindingReport(out.deploymentBindings ?? null);
      setDeployNote(t("packs.detail.deployEffective", { minutes: Math.ceil(out.effectiveWithinSecs / 60) }));
    } catch (err) {
      const e = err as Error & { body?: { code?: string; reason?: string } };
      const code = e.body?.code;
      if (code === "BILLING_KEY_INVALID") {
        setError(t(`packs.detail.keyInvalid.${e.body?.reason ?? "liveness"}`, { defaultValue: e.message }));
      } else if (code === "BILLING_KEY_REQUIRED") {
        setError(t("packs.detail.keyRequired", { defaultValue: e.message }));
      } else if (code === "MODEL_LANE_REJECTED") {
        setError(t("packs.detail.modelLaneRejected", { reason: e.message, defaultValue: e.message }));
      } else if (code === "MODEL_NOT_IN_ROSTER") {
        setError(t("packs.detail.modelNotInRoster", { reason: e.message, defaultValue: e.message }));
      } else if (/model lanes cannot be validated/.test(e.message)) {
        // The unlinked-billing-plane refusal for a filled model. MUST be
        // matched BEFORE the serving-not-configured branch below: its text
        // ("billing plane not configured — …") also matches that branch's
        // /not configured/i, which would swap the whole deploy form for the
        // self-host guidance panel and bury the actual reason.
        setError(t("packs.detail.modelLanesUnavailable", { defaultValue: e.message }));
      } else if (servingReady === false || /not configured/i.test(e.message)) {
        setServingReady(false); // race-proof: the probe lost to a click
      } else {
        setError(e.message);
      }
      // A 402 no-account answer may race the open-time readout: refresh.
      if (code === "NO_SUB2API_ACCOUNT" || code === "INSUFFICIENT_BALANCE") {
        api.myBillingState().then(setBilling).catch(() => {});
      }
    } finally {
      setDeploying(false);
    }
  }, [budgetDrafts, keyDrafts, modelDrafts, overrides, pack.version, packId, servingAgents, servingReady, t]);

  const togglePause = async (agentId: string, paused: boolean) => {
    setPauseBusy(agentId);
    setError(null);
    try {
      await api.pauseDeployment(packId, agentId, paused);
      const d = await api.getPackDeployments(packId);
      setDeployments(d.deployments ?? []);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPauseBusy(null);
    }
  };

  if (servingAgents.length === 0) return null;

  if (servingReady === false) {
    return (
      <section className="border border-dashed border-border rounded-md p-3" data-testid="pack-deploy-guidance">
        <h4 className="font-medium mb-2">{t("packs.detail.selfhostTitle")}</h4>
        <p className="text-xs text-muted-foreground leading-5">{t("packs.detail.selfhostBody")}</p>
        <div className="mt-2 flex flex-wrap gap-2">
          <Button
            size="sm"
            onClick={() => window.open("https://facet.finddatatech.cloud", "_blank", "noopener")}
            data-testid="pack-deploy-guidance-market"
          >
            {t("packs.detail.selfhostMarketBtn")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              window.open(
                "https://github.com/FindDataTechnology/platform/blob/main/docs/creating-packs.md",
                "_blank",
                "noopener",
              )
            }
            data-testid="pack-deploy-guidance-creating"
          >
            {t("packs.detail.selfhostCreatingBtn")}
          </Button>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">{t("packs.detail.selfhostNote")}</p>
      </section>
    );
  }

  return (
    <section className="border border-border rounded-md p-3" data-testid="pack-deploy-section">
      <h4 className="font-medium mb-2">{t("packs.detail.deployTitle")}</h4>
      <p className="text-xs text-muted-foreground leading-5 mb-3" data-testid="pack-deploy-summary">
        {t("packs.detail.deploySummary")}
      </p>
      {error && <p className="mb-2 text-xs text-destructive" data-testid="pack-deploy-error">{error}</p>}
      {billing?.linked && billing.accountState === "none" && (
        <div className="text-xs mb-2 rounded-md px-2 py-2 bg-status-waiting/10 text-status-waiting" data-testid="pack-billing-no-account">
          <p>{t("packs.detail.noAccountHintNew")}</p>
          <p className="mt-1 text-muted-foreground">{t("packs.detail.noAccountHintExisting")}</p>
          <Button
            size="sm"
            variant="outline"
            className="mt-2 h-7 px-2 text-xs"
            onClick={() => billing.panelUrl && window.open(billing.panelUrl, "_blank", "noopener")}
            data-testid="pack-billing-connect"
          >
            {t("packs.detail.connectPanel")}
          </Button>
        </div>
      )}
      {billing?.linked && billing.accountState === "ok" && (
        <div
          data-testid="pack-billing-readout"
          className={`text-xs mb-2 rounded-md px-2 py-1 ${billing.balance != null && billing.balance <= 1 ? "bg-status-waiting/10 text-status-waiting" : "text-muted-foreground"}`}
        >
          {billing.balance != null
            ? t("packs.detail.balance", { balance: billing.balance.toFixed(2) })
            : t("packs.detail.balanceUnknown")}
          {billing.balance != null && billing.balance <= 1 && (
            <span className="block">{t("packs.detail.balanceLow")}</span>
          )}
        </div>
      )}
      {billing?.linked && billing.accountState === "ok" && (
        <div className="mb-2 space-y-2">
          <p className="text-xs text-muted-foreground leading-5">{t("packs.detail.keySubtitle")}</p>
          {servingAgents.map((a) => (
            <div key={a.id} data-testid={`pack-billing-key-${a.id}`}>
              <div className="flex items-center gap-2">
                <p className="text-xs text-muted-foreground">{t("packs.detail.keyPasteLabel", { id: a.id })}</p>
                {bindings?.[a.id] && (
                  <span
                    className="rounded-md border border-primary/40 bg-primary/10 px-1.5 py-0.5 text-[10px] font-mono text-primary"
                    data-testid={`pack-billing-bound-${a.id}`}
                  >
                    {t("packs.detail.keyBoundBadge")}
                  </span>
                )}
              </div>
              <input
                type="text"
                className="mt-1 w-full rounded-md border border-border bg-transparent px-2 py-1 font-mono text-xs"
                placeholder={t("packs.detail.keyPastePlaceholder")}
                value={keyDrafts[a.id] ?? ""}
                onChange={(e) => setKeyDrafts((d) => ({ ...d, [a.id]: e.target.value }))}
                autoComplete="off"
                spellCheck={false}
                data-testid={`pack-billing-key-input-${a.id}`}
              />
            </div>
          ))}
        </div>
      )}
      <p className="text-xs text-muted-foreground leading-5 mb-2">{t("packs.detail.rhythmSubtitle")}</p>
      <p className="text-xs text-muted-foreground leading-5 mb-2">{t("packs.detail.modelSubtitle")}</p>
      <p className="text-xs text-muted-foreground leading-5 mb-2">{t("packs.detail.budgetSubtitle")}</p>
      {servingAgents.map((a) => (
        <div key={a.id} className="mb-2" data-testid={`pack-deploy-override-${a.id}`}>
          <p className="text-xs text-muted-foreground">{t("packs.detail.rhythmOverride", { id: a.id })}</p>
          <RhythmEditor
            value={overrides[a.id] ?? []}
            onChange={(entries) => setOverrides((o) => ({ ...o, [a.id]: entries }))}
            testIdPrefix={`pack-deploy-override-editor-${a.id}`}
          />
          <p className="text-xs text-muted-foreground mt-1.5">{t("packs.detail.modelOverride", { id: a.id })}</p>
          <input
            type="text"
            className="mt-1 w-full rounded-md border border-border bg-transparent px-2 py-1 font-mono text-xs"
            placeholder={a.serving?.model || t("packs.detail.modelPlaceholder")}
            value={modelDrafts[a.id] ?? ""}
            onChange={(e) => setModelDrafts((d) => ({ ...d, [a.id]: e.target.value }))}
            autoComplete="off"
            spellCheck={false}
            data-testid={`pack-deploy-model-${a.id}`}
            list={`pack-deploy-model-wl-${a.id}`}
          />
          {a.serving?.modelWhitelist?.length ? (
            <>
              <datalist id={`pack-deploy-model-wl-${a.id}`}>
                {a.serving.modelWhitelist.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
              <p className="text-xs text-muted-foreground" data-testid={`pack-deploy-model-wl-${a.id}`}>
                {t("packs.detail.modelHintWhitelist", { list: a.serving.modelWhitelist.join(" · ") })}
              </p>
            </>
          ) : (
            <p className="text-xs text-muted-foreground" data-testid={`pack-deploy-model-wl-${a.id}`}>
              {t("packs.detail.modelHintNoWhitelist")}
            </p>
          )}
          <p className="text-xs text-muted-foreground mt-1.5">{t("packs.detail.budgetOverride", { id: a.id })}</p>
          <input
            type="text"
            inputMode="numeric"
            className="mt-1 w-full rounded-md border border-border bg-transparent px-2 py-1 font-mono text-xs"
            placeholder={
              a.serving?.budget?.turnMinutes != null
                ? String(a.serving.budget.turnMinutes)
                : t("packs.detail.budgetPlaceholder")
            }
            value={budgetDrafts[a.id] ?? ""}
            onChange={(e) => setBudgetDrafts((d) => ({ ...d, [a.id]: e.target.value }))}
            autoComplete="off"
            spellCheck={false}
            data-testid={`pack-deploy-budget-${a.id}`}
          />
          {(budgetDrafts[a.id] ?? "").trim().length > 0 && !budgetDraftValid((budgetDrafts[a.id] ?? "").trim()) && (
            <p className="text-xs text-status-waiting" data-testid={`pack-deploy-budget-invalid-${a.id}`}>
              {t("packs.detail.budgetInvalid")}
            </p>
          )}
        </div>
      ))}
      {deployments.length > 0 && (
        <ul className="space-y-1 mb-2">
          {deployments.map((d) => (
            <li key={d.agentId} className="flex items-center gap-2 text-xs" data-testid="pack-deployment-row">
              <span className="rounded-md bg-muted px-1.5 py-0.5 font-mono">{d.agentId}</span>
              <span className="text-muted-foreground">v{d.version}</span>
              <span className={d.paused ? "text-status-waiting" : "text-primary"} data-testid={`pack-deployment-state-${d.agentId}`}>
                {d.paused ? t("packs.detail.paused") : t("packs.detail.deployOnline")}
              </span>
              <Button
                size="sm"
                variant="ghost"
                className="ml-auto h-6 px-2 text-xs"
                disabled={pauseBusy === d.agentId}
                onClick={() => void togglePause(d.agentId, !d.paused)}
                data-testid={`pack-deployment-pause-${d.agentId}`}
              >
                {d.paused ? t("packs.detail.resumeBtn") : t("packs.detail.pauseBtn")}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-6 px-2 text-xs"
                onClick={() =>
                  window.open(`${wanxingConsoleBase()}/#/console/${wanxingSlugFor(d.agentPath)}`, "_blank", "noopener")
                }
                data-testid={`pack-deployment-config-${d.agentId}`}
              >
                {t("packs.detail.gotoConfig")}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {deployNote && <p className="text-xs text-primary mb-2">{deployNote}</p>}
      {bindingReport && hasBindingReport(bindingReport) && (
        <div className="mb-2 space-y-0.5 text-xs" data-testid="pack-deploy-bindings">
          {bindingReport.granted.length > 0 && (
            <p className="text-primary">
              {t("packs.detail.bindingsReady", {
                count: bindingReport.granted.length,
                keys: uniqueKeys(bindingReport.granted),
              })}
            </p>
          )}
          {bindingReport.failed.length > 0 && (
            <p className="text-status-waiting">
              {t("packs.detail.bindingsFailed", {
                count: bindingReport.failed.length,
                keys: uniqueKeys(bindingReport.failed),
              })}{" "}
              <span className="text-muted-foreground">
                {bindingReport.failed.map((f) => bindingReasonLabel(f.code, t)).filter((s, i, a) => a.indexOf(s) === i).join(" · ")}
              </span>
            </p>
          )}
          {(bindingReport.revoked ?? 0) > 0 && (
            <p className="text-muted-foreground">
              {t("packs.detail.bindingsRevoked", { count: bindingReport.revoked })}
            </p>
          )}
        </div>
      )}
      <Button
        variant="outline"
        onClick={() => void deploy()}
        disabled={deploying || anyBudgetInvalid}
        data-testid="pack-deploy-btn"
      >
        {deploying ? t("common.loading") : t("packs.detail.deployBtn")}
      </Button>
      <p className="text-xs text-muted-foreground mt-1.5" data-testid="pack-deploy-outcome">
        {t("packs.detail.deployOutcome")}
      </p>
    </section>
  );
}