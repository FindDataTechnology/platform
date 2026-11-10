// PackDetailDialog — inspect a pack in full before subscribing: every skill's
// complete body, MCP references (with required groups), agent personas, and
// author identity (spec: pack-marketplace). Subscribe is one action that
// records the subscription on the market and materializes the snapshot in
// this cell; the cell fetches the manifest server-side from the pack id +
// version (pack-install-server-side-manifest).

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import * as api from "@/lib/packs-api";
import type { DeployBindingReport, PackDetail, PackDeployment, PackReport } from "@/lib/packs-api";
import { useExtensionsStore } from "@/hooks/useExtensionsStore";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/states-kit";
import { Button } from "@/components/ui/button";
import { Badge } from "./Badge";
import { AgentSpecSheet } from "./AgentSpecSheet";
import { FacadeMattersPanel } from "./FacadeMattersPanel";
import { RhythmEditor, rhythmEntryValid } from "./RhythmEditor";
import { PackVersionList } from "./PackVersionList";
import { FleetTemplateWizard } from "./FleetTemplateWizard";
import { promptsFor, type PackGuide } from "@/lib/packGuides";
import type { RhythmEntry } from "./RhythmEditor";

interface Props {
  packId: string | null;
  onOpenChange: (open: boolean) => void;
  // packId rides the callback (simplify-chat-and-agents-ia): the install
  // report's next-steps CTA needs the pack id to deep-link a multi-role pack
  // into a cluster bind.
  onSubscribed: (report: PackReport, name: string, packId: string) => void;
  onGotoMine?: () => void;
  // Signed-out signal (polish-facet-interactions): hosts whose viewers can be
  // anonymous (the facet shell) wire this — gated actions (subscribe, goto-
  // mine) flip the action bar to a login-guidance row instead of firing or
  // surfacing a raw error. Hosts without it (壹座 — every viewer holds a
  // session) keep the authenticated-error fallback below.
  onRequireLogin?: () => void;
  // Fork deep link origin (add-agent-fork-lineage D5): hosts on the 壹座
  // origin omit it (relative /studio); facet passes the 壹座 origin so the
  // link CROSSES domains — the fork write itself happens only in the
  // user's 壹座 cell (facet stays write-free for authoring).
  studioOrigin?: string;
  // Whether this host can install/deploy packs into a cell (overhaul-market-
  // catalog-presentation P0). False (the facet shell) skips the deployments/
  // billing probes — requests that can never carry data on that host. The
  // market read itself (locale-aware detail) still loads.
  installSurface?: boolean;
  // Example prompts are actionable (overhaul-market-catalog-presentation P2
  // 3.5). 壹座 wires the parked-draft channel (setComposerDraft + navigate to
  // /chat — the DocumentsPage "start conversation" precedent); the facet shell
  // wires nothing (it holds no chat session) and the dialog falls back to
  // copy-to-clipboard with a visible "copied" confirmation.
  onUsePrompt?: (prompt: string) => void;
}

// The 万星 console deep link (agent-service-config): the deployment's slug and
// the console origin. The slug rule mirrors the serving side's slugFor
// (fd-wanxing wanxing-facade core.js) — a minimal copy, keep the two in
// lockstep (the same discipline the console's setPaused copy follows).
const wanxingConsoleBase = () => import.meta.env.VITE_WANXING_CONSOLE_URL || "https://wanxing.finddatatech.cloud";

// Authentication failures get a localized guidance line, never raw English
// (polish-facet-interactions): exact-match the platform's well-known
// "Authentication required" body; anything else passes through untouched.
function authErrorMessage(t: (k: string) => string, err: Error): string {
  if (err.message === "Authentication required") return t("packs.detail.authRequired");
  return err.message;
}
const wanxingSlugFor = (agentPath: string) =>
  String(agentPath).replace(/^\/+/, "").replace(/[^A-Za-z0-9._-]+/g, "-").toLowerCase();

// Budget draft rule (add-deploy-form-model-budget D2) — a client mirror of
// the platform's budgetMinutesError (lib/pack-manifest.js: positive whole
// minutes, cap 120 = BUDGET_MAX_MINUTES). Same discipline as RhythmEditor
// mirroring lib/rhythm.js: the server stays the enforcement point; this only
// refuses the submit so a typo never meets its error server-side first.
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

export function PackDetailDialog({
  packId,
  onOpenChange,
  onSubscribed,
  onGotoMine,
  onRequireLogin,
  studioOrigin,
  installSurface = true,
  onUsePrompt,
}: Props) {
  const { t, i18n } = useTranslation();
  // Tool-face disclosure (pack-tool-declaration-gate D4): the declared count
  // rides the version manifest; the per-server total comes from the catalog's
  // tool_list snapshot (the same source the draft editor's picker uses) — no
  // live probe, so an unreachable server cannot break this page.
  const { marketCatalog, refreshMarketCatalog } = useExtensionsStore();
  useEffect(() => {
    if (packId) void refreshMarketCatalog();
  }, [packId, refreshMarketCatalog]);
  // The action bar's login-guidance row (polish-facet-interactions): flipped
  // when a signed-out viewer activates a gated action and the host wired
  // onRequireLogin; cleared when the dialog reopens for another pack.
  const [loginHint, setLoginHint] = useState(false);
  // Which example prompt's clipboard copy just landed (facet fallback, P2 3.5):
  // index into the examples list; null hides the confirmation. Reset per pack.
  const [copiedExample, setCopiedExample] = useState<number | null>(null);
  // Script confirm gate (add-packaged-skills 5.1): set when the install
  // answered 400 code=script-confirm-required — the names + script files it
  // carries render the one-time acknowledgment; confirming retries with
  // confirm=true. Server-enforced, this dialog is only the explanation.
  const [scriptGate, setScriptGate] = useState<{ name: string; scriptFiles: string[] }[] | null>(null);
  const [pack, setPack] = useState<PackDetail | null>(null);
  const [subscribing, setSubscribing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 装作路径（add-fleet-owner-surface）：模板 pack (manifest.fleet) 的
  // 参数向导开闸 — 只在壹座宿主开放（facet 匿名壳不装本机）。
  const [showFleetWizard, setShowFleetWizard] = useState(false);
  const [deployments, setDeployments] = useState<PackDeployment[]>([]);
  const [deploying, setDeploying] = useState(false);
  const [deployNote, setDeployNote] = useState<string | null>(null);
  // Connector bindings the deploy actually carried (add-deployment-binding-
  // grant): the server reports granted/failed/revoked and the surface owes the
  // deployer that truth — a binding that quietly failed to mint leaves an
  // agent that looks deployed but cannot reach the system it was built for.
  const [bindingReport, setBindingReport] = useState<DeployBindingReport | null>(null);
  // Deployer rhythm overrides (add-agent-residency D7): agentId → entries.
  const [overrides, setOverrides] = useState<Record<string, RhythmEntry[]>>({});
  // Deploy-time model/budget drafts (add-deploy-form-model-budget): agentId →
  // trimmed input. Empty = the dimension rides no map (standing precedence:
  // preserved override → declaration → platform default); the form never
  // sends null (clearing is the serving config surface's act).
  const [modelDrafts, setModelDrafts] = useState<Record<string, string>>({});
  const [budgetDrafts, setBudgetDrafts] = useState<Record<string, string>>({});
  const [pauseBusy, setPauseBusy] = useState<string | null>(null);
  // Billing readout (add-agent-platform-ops D3; revised by
  // revise-billing-key-acquisition): linked + accountState drives the deploy
  // surface — "none" shows the SSO connect guidance, "ok" shows the balance
  // and the per-agent key paste inputs; unlinked shows no readout, no gate.
  const [billing, setBilling] = useState<api.MyBillingState | null>(null);
  // Serving agentId → whether a key is already bound (booleans only).
  const [bindings, setBindings] = useState<Record<string, boolean> | null>(null);
  // Paste inputs, serving agentId → drafted key (never echoed back).
  const [keyDrafts, setKeyDrafts] = useState<Record<string, string>>({});
  // Optional agents toggle for cluster view (agent-cluster-platform)
  const [showOptionalAgents, setShowOptionalAgents] = useState(false);

  // Data loading (overhaul-market-catalog-presentation P0 1.3): two triggers,
  // two behaviors —
  //   packId change → full reset (skeleton, fresh state), the pre-change act;
  //   language change → SILENT refetch of the locale-dependent read only: the
  //   open dialog keeps showing the previous language until the new payload
  //   lands, and a failed refetch keeps the old content with a non-blocking
  //   hint instead of the destructive error box.
  // The install-plane probes (deployments/billing) are locale-independent, so
  // they run on packId change only, and never on hosts without an install
  // surface (the facet shell — 1.7).
  const language = i18n.language;
  const [localeStale, setLocaleStale] = useState(false);
  const prevPackIdRef = useRef<string | null>(packId);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `language` is the TRIGGER, not an input — getPack appends the locale itself (localeQuery reads i18n.language), so the refetch cannot be expressed through the body
  useEffect(() => {
    const packChanged = prevPackIdRef.current !== packId;
    prevPackIdRef.current = packId;
    if (packChanged) {
      setPack(null);
      setError(null);
      setDeployments([]);
      setDeployNote(null);
      setBindings(null);
      setKeyDrafts({});
      setModelDrafts({});
      setBudgetDrafts({});
      setLoginHint(false);
      setScriptGate(null);
      setShowOptionalAgents(false);
      setCopiedExample(null);
    }
    setLocaleStale(false);
    if (!packId) return;
    api
      .getPack(packId)
      .then((p) => {
        setPack(p);
        setLocaleStale(false);
      })
      .catch((err) => {
        if (packChanged) setError((err as Error).message);
        else setLocaleStale(true);
      });
    if (!installSurface) return;
    api
      .getPackDeployments(packId)
      .then((d) => setDeployments(d.deployments ?? []))
      .catch(() => setDeployments([])); // deployments route absent = nothing deployed
    api
      .myBillingState()
      .then(setBilling)
      .catch(() => setBilling(null));
    api
      .getBillingBindings(packId)
      .then(setBindings)
      .catch(() => setBindings(null)); // bindings route absent = pre-revise gateway
  }, [packId, language, installSurface]);

  const subscribe = async (confirmScripts = false) => {
    if (!packId || !pack) return;
    if (onRequireLogin) {
      // Host-wired signed-out path (facet shell): no call is made — the bar
      // flips to the login guidance row (spec: anonymous subscribe attempts
      // get a login guidance bar). Only the row's sign-in action invokes the
      // host's navigation.
      setLoginHint(true);
      return;
    }
    setSubscribing(true);
    setError(null);
    try {
      // 装前闸镜像（add-market-revenue-share）：付费条目先成交再订阅。闸的
      // 本义在市场侧（未成交→402）；客户端只在顺路上先买单，失败如实呈现。
      if (pack.pricing && pack.purchased !== true) {
        await api.purchasePack(packId, true);
      }
      const sub = await api.subscribePack(packId);
      // Only the reference crosses the wire: the cell fetches the manifest
      // server-side (pack-install-server-side-manifest). A script-bearing
      // pack installs only with the explicit confirm (server-enforced).
      const { report } = await api.installPack(sub.packId, sub.version, confirmScripts);
      // Close this dialog BEFORE the report mounts: both are fixed overlays,
      // and a dialog left open above the report intercepts every click on
      // the report's actions (the report's own z-index cannot win a
      // still-mounted Radix portal). The report carries the result.
      onOpenChange(false);
      onSubscribed(report, pack.name, packId);
    } catch (err) {
      const e = err as Error & { body?: { code?: string; details?: { name: string; scriptFiles: string[] }[] } };
      // 购买/装闸的失败如实分类（add-market-revenue-share）：错误体里的
      // code 是市场面的分类, 直接给用户下一步出路, 不静默吞错。
      if (e.body?.code === "insufficient-balance") {
        setError(t("packs.detail.purchase.insufficient"));
        return;
      }
      if (e.body?.code === "billing-account-required") {
        setError(t("packs.detail.purchase.noBilling"));
        return;
      }
      if (e.body?.code === "settlement-failed") {
        setError(t("packs.detail.purchase.settlementFailed"));
        return;
      }
      if (e.body?.code === "market-purchase-required") {
        setError(t("packs.detail.purchase.required"));
        return;
      }
      if (e.body?.code === "script-confirm-required") {
        // Map the server's refusal to the one-time acknowledgment; the retry
        // carries confirm=true (task 5.1).
        setScriptGate(Array.isArray(e.body.details) ? e.body.details : []);
        return;
      }
      setError(authErrorMessage(t, e));
    } finally {
      setSubscribing(false);
    }
  };

  const servingAgents = (pack?.manifest?.agents ?? []).filter((a) => a.serving);

  // Any invalid budget draft freezes the deploy submit (add-deploy-form-
  // model-budget D2): a scalar typo meets its error in the form, never
  // server-side. Empty drafts are fine (empty = the dimension rides no map).
  const anyBudgetInvalid = servingAgents.some((a) => {
    const d = (budgetDrafts[a.id] ?? "").trim();
    return d.length > 0 && !budgetDraftValid(d);
  });

  // Serving capability (add-selfhost-funnel-guidance, F3.1): a self-hosted
  // instance without agent serving renders the official-market guidance
  // panel — the raw "not configured" error never surfaces.
  const [servingReady, setServingReady] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    api
      .getServingStatus()
      .then((d) => live && setServingReady(Boolean(d.configured)))
      .catch(() => live && setServingReady(true)); // probe failure ≠ not configured
    return () => {
      live = false;
    };
  }, []);

  const deploy = async () => {
    if (!packId || !pack) return;
    setDeploying(true);
    setError(null);
    setDeployNote(null);
    try {
      // Only VALID filled override entries ride the deploy request; untouched
      // agents (and the empty map) mean "manifest default".
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
      // Model drafts (add-deploy-form-model-budget): non-empty trimmed only.
      // No client lane check — lanes belong to the bound/pasted key and are
      // unknowable here; the server's gates refuse with a code the catch
      // below localizes.
      const models: Record<string, string> = {};
      for (const a of servingAgents) {
        const draft = (modelDrafts[a.id] ?? "").trim();
        if (draft) models[a.id] = draft;
      }
      // Budget drafts: a single scalar where silently dropping an invalid
      // value would second-guess the deployer — the submit button is already
      // disabled while any draft is invalid (budgetDraftValid), and this is
      // the race-proof second gate.
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
        // The server's reason names the agent and the gate (whitelist/lanes);
        // the prefix is the only localized half (add-deploy-form-model-budget D3).
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
  };

  const togglePause = async (agentId: string, paused: boolean) => {
    if (!packId) return;
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

  const m = pack?.manifest;
  // Guide resolution (move-pack-guides-to-manifest 3.3 终态): the creator's
  // own manifest.guide is the ONLY source — the client content module retired
  // (empty record); no content renders no card at all.
  const manifestGuide = (m as { guide?: { steps: { title: string; body: string }[]; examples?: { title: string; text: string }[] } } | undefined)?.guide;
  const guide: PackGuide | null = manifestGuide
    ? { name: pack?.name ?? "", steps: manifestGuide.steps as PackGuide["steps"] }
    : null;
  // ② 你会得到 (specs/pack-display-format 缺省降级链): the v2 outcomes win;
  // otherwise three step TITLES from the guide compose the promise list; no
  // source at all → the section is omitted (never an empty shell).
  const outcomes: { title: string; detail?: string }[] =
    Array.isArray((m as { outcomes?: { title: string; detail?: string }[] } | undefined)?.outcomes) && (m as { outcomes?: { title: string; detail?: string }[] } | undefined)!.outcomes!.length > 0
      ? ((m as { outcomes?: { title: string; detail?: string }[] } | undefined)!.outcomes ?? [])
      : (manifestGuide?.steps ?? []).slice(0, 3).map((st) => ({ title: st.title }));
  // Example questions (P3 4.5): the v2 `manifest.examples` (title+prompt) is
  // the primary source; then guide.examples (P2 3.5 channel); then the retired
  // client module. All normalize to { title, text } for the actionable row.
  const v2Examples = Array.isArray((m as { examples?: { title: string; prompt: string }[] } | undefined)?.examples)
    ? ((m as { examples?: { title: string; prompt: string }[] } | undefined)!.examples ?? []).map((e) => ({ title: e.title, text: e.prompt }))
    : [];
  const examples =
    v2Examples.length > 0
      ? v2Examples
      : manifestGuide?.examples && manifestGuide.examples.length > 0
        ? manifestGuide.examples
        : promptsFor(packId) ?? [];

  return (
    <Dialog open={!!packId} onOpenChange={onOpenChange}>
      <DialogContent
        className="relative flex max-h-[85vh] max-w-2xl flex-col overflow-hidden p-0"
        data-testid="pack-detail"
      >
        {/* Close control at the dialog's top-right — the conventional spot.
            A sibling of the scroll pane, so it never scrolls away. */}
        <button
          type="button"
          aria-label={t("packs.detail.close")}
          className="absolute right-3 top-3 z-20 rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          onClick={() => onOpenChange(false)}
          data-testid="pack-detail-close"
        >
          ✕
        </button>
        <div className="flex-1 overflow-y-auto p-6">
        {!pack && !error && (
          <div className="space-y-3" data-testid="pack-detail-loading">
            <Skeleton className="h-6 w-1/3" />
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-5/6" />
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-3 w-2/3" />
          </div>
        )}
        <DialogHeader>
          <DialogTitle>
            {pack?.name ?? (error ? t("packs.detail.notFound") : "")}
            {pack?.badge && (
              <span data-testid="pack-type-badge" className="ml-2 rounded-full bg-muted px-2 py-0.5 text-xs font-normal text-muted-foreground align-middle">
                {t(`packs.badge.${pack.badge}`)}
              </span>
            )}
            {pack?.visibility === "private" && (
              <span data-testid="pack-private-badge" className="ml-2 rounded-sm border border-status-waiting/50 bg-status-waiting/10 px-1.5 py-0.5 text-xs text-status-waiting align-middle">
                {t("packs.detail.private")}
              </span>
            )}
            {/* Adopted provenance (add-official-adopted-agents): 官方精选·已审校
                是**来源轴**，与类型徽章（结构）和官方性（roster）并列不相交。
                只有服务端投影判定为 official-adopted 时才出现（community 态
                不下发键，旧 payload 逐字节不变）。 */}
            {pack?.provenance?.source === "official-adopted" && (
              <span
                data-testid="pack-adopted-badge"
                className="ml-2 rounded-full border border-primary/40 bg-primary/10 px-2 py-0.5 text-xs font-normal text-primary align-middle"
              >
                {t("packs.market.officialAdoptedBadge")}
              </span>
            )}
          </DialogTitle>
          <DialogDescription>
            {pack ? `${pack.authorEmail} · v${pack.version}` : ""}
            {/* 署名与价格（add-vendor-supply-open / add-market-revenue-share）:
                投影字段存在才渲染 — 免费且无归属的条目与落地前逐字节一致。 */}
            {pack?.vendor && (
              <span className="ml-2 text-primary" data-testid="pack-vendor-badge">
                · {t("packs.detail.vendorBy", { name: pack.vendor.name })}
              </span>
            )}
            {pack?.pricing && (
              <span className="ml-2 font-medium" data-testid="pack-pricing-badge">
                · ${pack.pricing.priceUsd.toFixed(2)}
                {pack.pricing.kind === "period"
                  ? t("packs.detail.perPeriod", { days: pack.pricing.periodDays })
                  : t("packs.detail.oneOff")}
                {pack.purchased === true && <span className="ml-1 text-primary">· {t("packs.detail.purchased")}</span>}
              </span>
            )}
          </DialogDescription>
        </DialogHeader>

        {error && (
          <div className="bg-destructive/10 text-destructive px-4 py-3 rounded-md">{error}</div>
        )}
        {/* Silent-refetch failure (P0 1.3): the previously loaded content stays
            visible; this hint says the language didn't switch. Non-blocking. */}
        {localeStale && !error && (
          <p
            data-testid="pack-detail-locale-stale"
            className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning"
          >
            {t("packs.market.staleLocale")}
          </p>
        )}

        {pack && m && (
          <div className="space-y-4 text-sm">
            <div className="flex items-start justify-between gap-2">
              <p className="text-muted-foreground">{pack.description}</p>
              {/* Raw download surface (add-facet-platform 4.4): the anonymous
                  skill-md route and the version manifest stay linkable from
                  the SPA — editors and scripts consume exactly these. */}
              <a
                href={`/api/packs/${pack.id}/versions/${pack.version}`}
                target="_blank"
                rel="noreferrer"
                className="shrink-0 text-xs text-primary hover:underline"
                data-testid="pack-manifest-link"
              >
                {t("packs.detail.manifestJson")}
              </a>
            </div>
            {!!pack.tags?.length && (
              <div className="flex gap-1.5 flex-wrap">
                {pack.tags.map((tag) => (
                  <Badge key={tag}>{tag}</Badge>
                ))}
              </div>
            )}

            {/* Adopted provenance detail (add-official-adopted-agents): the
                audit trail the curation review produced — upstream source,
                license, and the pinned revision the snapshot was taken at.
                Rendered only for official-adopted reads. The pinned revision
                is shown so "how stale is this" is answerable at a glance
                (same honesty posture as a facade's 语料截至). */}
            {pack.provenance?.source === "official-adopted" && pack.provenance.adopted && (
              <div
                className="rounded-md border border-border bg-muted/40 px-3 py-2 space-y-1"
                data-testid="pack-adopted-provenance"
              >
                <p className="text-xs font-medium text-foreground">
                  {t("packs.detail.adoptedHint")}
                </p>
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                  <a
                    href={pack.provenance.adopted.upstreamUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-primary hover:underline"
                    data-testid="pack-adopted-upstream"
                  >
                    {t("packs.detail.adoptedUpstream", { name: pack.provenance.adopted.upstreamName })}
                  </a>
                  <span data-testid="pack-adopted-license">
                    {t("packs.detail.adoptedLicense", { license: pack.provenance.adopted.license })}
                  </span>
                  <span data-testid="pack-adopted-revision" title={pack.provenance.adopted.revision}>
                    {t("packs.detail.adoptedRevision", {
                      sha: String(pack.provenance.adopted.revision).slice(0, 8),
                    })}
                  </span>
                </div>
              </div>
            )}

            {outcomes.length > 0 && (
              <section className="rounded-md border border-border p-3" data-testid="pack-detail-outcomes">
                <h4 className="mb-2 font-medium">{t("packs.detail.outcomes")}</h4>
                <ul className="space-y-1">
                  {outcomes.slice(0, 5).map((o) => (
                    <li key={o.title} className="text-xs leading-5">
                      <span className="font-medium text-foreground">{o.title}</span>
                      {o.detail ? <span className="text-muted-foreground"> — {o.detail}</span> : null}
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {/* Usage guide (add-onboarding-tutorial): three steps from the
                client content module — informational only, purely absent when
                the module has no entry for this pack id. Guide bodies render
                in the requested locale: the market answers in the UI locale
                (zh main track when nothing covers it), so no client-side
                fallback happens here. Chrome labels are i18n as always. */}
            {guide && (
              <section
                className="rounded-md border border-primary/30 bg-primary/5 p-3"
                data-testid="pack-guide-card"
              >
                <h4 className="mb-2 font-medium">{t("packs.guide.title")}</h4>
                <ol className="space-y-2" data-testid="pack-guide-steps">
                  {guide.steps.map((s, i) => (
                    <li key={s.title} className="text-xs">
                      <span className="font-medium text-foreground">
                        {t("packs.guide.step", { n: i + 1 })} · {s.title}
                      </span>
                      <p className="mt-0.5 leading-5 text-muted-foreground">{s.body}</p>
                    </li>
                  ))}
                </ol>
                <p className="mt-2 text-xs text-muted-foreground">{t("packs.guide.hint")}</p>
              </section>
            )}
            {examples.length > 0 && (
              <div className="rounded-md border border-border p-3" data-testid="pack-guide-examples">
                <p className="text-xs font-medium text-muted-foreground">{t("packs.guide.examples")}</p>
                <ul className="mt-1 space-y-0.5">
                  {examples.slice(0, 4).map((ex, i) => (
                    <li key={ex.title}>
                      <button
                        type="button"
                        data-testid={`pack-guide-example-${i}`}
                        className="text-left text-xs leading-5 text-primary hover:underline"
                        title={ex.text}
                        onClick={() => {
                          if (onUsePrompt) {
                            onUsePrompt(ex.text);
                            return;
                          }
                          // Facet shell (no chat session): copy the prompt —
                          // the confirmation appears only on a real write,
                          // a failed clipboard never claims success.
                          navigator.clipboard
                            ?.writeText(ex.text)
                            .then(() => setCopiedExample(i))
                            .catch(() => {});
                        }}
                      >
                        · {ex.title}
                      </button>
                      {copiedExample === i && (
                        <span className="ml-1.5 text-[10px] text-warning" data-testid="pack-guide-example-copied">
                          {t("packs.guide.copied")}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}


            {/* Three-bucket spec sheet (add-agent-spec-sheet): 角色/技能/工具
                render as ONE shared component — the bucket layout lives there,
                not here; this surface only supplies data. testIdPrefix="pack"
                keeps the pre-sheet e2e anchors (pack-skill-*, pack-mcp-tool-
                face-*, pack-agent-serving-*) byte-identical. The guide card
                above stays the dialog's own for now — its client-side
                fallback retires with move-pack-guides-to-manifest; the sheet
                itself takes document-sourced guides only. */}
            <AgentSpecSheet
              variant="full"
              testIdPrefix="pack"
              badge={pack.badge ?? null}
              facade={pack.facade === true}
              official={pack.official === true}
              adopted={pack.adopted === true}
              roles={(m.agents ?? []).map((a) => ({
                id: a.id,
                name: a.name,
                persona: a.persona,
                serving: a.serving != null,
                rhythm: a.serving?.rhythm,
              }))}
              skills={m.skills ?? []}
              mcp={(m.mcpServers ?? []).map((r) => ({
                ...r,
                totalTools:
                  marketCatalog?.mcpServers?.find((s) => s.name === r.registryName)?.toolList?.length ?? null,
              }))}
              skillHref={(name) => `/api/packs/${pack.id}/versions/${pack.version}/skills/${encodeURIComponent(name)}.md`}
              lineage={(pack.manifest?.provenance as { forkOf?: { packId: string; version: number } } | undefined)?.forkOf ?? null}
            />

            {/* Facade panel (add-principal-facade): the pack declares itself a
                principal's conversational front door. Attribution is the
                platform's author stamp (never the manifest's self-narrative);
                the corpus as-of is the viewed version's publish time (corpus
                rides the immutable version — refresh = new version + redeploy);
                the chat entry exists only when the reception role is deployed
                (slug mirrors the serving side's slugFor). */}
            {pack.manifest?.facade && (
              <section
                className="border border-primary/20 bg-primary/5 rounded-md p-4"
                data-testid="pack-facade-info"
              >
                <div className="flex items-center gap-2 mb-2">
                  <h4 className="font-medium text-primary">{t("packs.detail.facade.title")}</h4>
                  <Badge>{t("packs.detail.facade.stanceHosted")}</Badge>
                </div>
                <div className="space-y-1 text-sm" data-testid="pack-facade-attribution">
                  <p className="text-muted-foreground">
                    {t("packs.detail.facade.attribution", { owner: pack.authorEmail })}
                  </p>
                  <p className="text-muted-foreground" data-testid="pack-facade-asof">
                    {t("packs.detail.facade.asOf", {
                      date: new Date(pack.publishedAt).toLocaleDateString(),
                    })}
                  </p>
                </div>
                {(() => {
                  const reception = pack.manifest.facade!.reception;
                  const dep = deployments.find((d) => d.agentId === reception);
                  if (!dep) {
                    return (
                      <p className="mt-2 text-xs text-muted-foreground" data-testid="pack-facade-not-deployed">
                        {t("packs.detail.facade.notDeployed")}
                      </p>
                    );
                  }
                  const chatUrl = `${wanxingConsoleBase()}/#/chat/${wanxingSlugFor(dep.agentPath)}`;
                  return (
                    <a
                      href={chatUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="mt-2 inline-flex items-center gap-1 text-sm text-primary underline"
                      data-testid="pack-facade-chat-entry"
                    >
                      {t("packs.detail.facade.chatEntry")}
                    </a>
                  );
                })()}
              </section>
            )}

            {/* The principal's matter queue (add-matter-threads): renders only
                when the caller owns matters on this pack — strangers see
                nothing (the server filters existence away). */}
            {pack.manifest?.facade && <FacadeMattersPanel packId={pack.id} />}

            {/* Cluster Info (agent-cluster-platform): when the pack declares cluster metadata,
                show a dedicated section with cluster name, description, and agent composition. */}
            {pack.manifest?.cluster && (
              <section className="border border-primary/20 bg-primary/5 rounded-md p-4" data-testid="pack-cluster-info">
                <h4 className="font-medium text-primary mb-1">{t("packs.detail.cluster.title")}</h4>
                <div className="flex items-center gap-2 mb-2">
                  <h3 className="text-lg font-semibold text-foreground">{pack.manifest.cluster.name}</h3>
                  <Badge data-testid="pack-cluster-agent-count">
                    {t("packs.detail.cluster.agentCount", { count: m?.agents?.length ?? 0 })}
                  </Badge>
                </div>
                <p className="text-sm text-muted-foreground mb-3">{pack.manifest.cluster.description}</p>
                
                {/* Agent composition list */}
                <div className="mb-3">
                  <p className="text-xs font-medium text-muted-foreground mb-2">{t("packs.detail.cluster.agents")}</p>
                  <div className="space-y-1">
                    {/* Default agents */}
                    {(pack.manifest.cluster.defaultAgents ?? []).map((agentId) => {
                      const agent = m?.agents?.find((a) => a.id === agentId);
                      if (!agent) return null;
                      return (
                        <div key={agentId} className="flex items-center gap-2 text-xs" data-testid={`pack-cluster-default-agent-${agentId}`}>
                          <span className="w-1.5 h-1.5 rounded-full bg-primary"></span>
                          <span className="font-medium text-foreground">{agent.name}</span>
                          <span className="text-muted-foreground">({agentId})</span>
                        </div>
                      );
                    })}
                    
                    {/* Optional agents toggle */}
                    {(pack.manifest.cluster.optionalAgents ?? []).length > 0 && (
                      <>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-6 text-xs pl-2"
                          data-testid="pack-cluster-toggle-optional"
                          onClick={() => setShowOptionalAgents(!showOptionalAgents)}
                        >
                          {showOptionalAgents ? t("packs.detail.cluster.hideOptional") : t("packs.detail.cluster.showOptional")}
                        </Button>
                        
                        {/* Optional agents (collapsible) */}
                        {showOptionalAgents && (
                          <div className="ml-3 space-y-1 pt-1 border-l border-border pl-2">
                            {(pack.manifest.cluster.optionalAgents ?? []).map((agentId) => {
                              const agent = m?.agents?.find((a) => a.id === agentId);
                              if (!agent) return null;
                              return (
                                <div key={agentId} className="flex items-center gap-2 text-xs" data-testid={`pack-cluster-optional-agent-${agentId}`}>
                                  <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground"></span>
                                  <span className="text-foreground">{agent.name}</span>
                                  <span className="text-muted-foreground">({agentId})</span>
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </>
                    )}
                  </div>
                </div>
              </section>
            )}

            {servingAgents.length > 0 && servingReady === false && (
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
            )}

            {servingAgents.length > 0 && (servingReady === null || servingReady) && (
              <section className="border border-border rounded-md p-3" data-testid="pack-deploy-section">
                <h4 className="font-medium mb-2">{t("packs.detail.deployTitle")}</h4>
                <p className="text-xs text-muted-foreground leading-5 mb-3" data-testid="pack-deploy-summary">
                  {t("packs.detail.deploySummary")}
                </p>
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
                          <p className="text-xs text-muted-foreground">
                            {t("packs.detail.keyPasteLabel", { id: a.id })}
                          </p>
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
            )}

            {/* ⑥ 边界与诚实声明 (overhaul-market-catalog-presentation P2): the
                version's honest statement (notes) gets its own fixed position —
                today it is buried in the skill bodies, half a screen away from
                the decision it qualifies. P4 adds the locale-coverage mark
                to this section. */}
            {((m.notes ?? "").trim() !== "" || pack.coverage) && (
              <section
                className="rounded-md border border-border bg-muted/30 p-3"
                data-testid="pack-detail-boundary"
              >
                <h4 className="mb-1 font-medium">{t("packs.detail.boundary")}</h4>
                {(m.notes ?? "").trim() !== "" && (
                  <p className="text-xs leading-5 text-muted-foreground" data-testid="pack-detail-boundary-notes">
                    {m.notes}
                  </p>
                )}
                {/* 覆盖度仪表 (P3 4.11): informs, never gates — subscribe and
                    install stay fully enabled whatever the number reads. The
                    server computes it (one module, the gate's own denominator);
                    the client never re-derives coverage from raw i18n. */}
                {pack.coverage && (
                  <div className={(m.notes ?? "").trim() !== "" ? "mt-2 border-t border-border/40 pt-2" : ""}>
                    {pack.coverage.missing.length === 0 ? (
                      <p className="text-xs text-muted-foreground" data-testid="pack-detail-coverage">
                        {t("packs.detail.coverageFull", { locale: pack.coverage.locale })}
                      </p>
                    ) : (
                      <>
                        <p className="text-xs text-muted-foreground" data-testid="pack-detail-coverage">
                          {t("packs.detail.coverage", {
                            locale: pack.coverage.locale,
                            covered: pack.coverage.covered,
                            total: pack.coverage.total,
                          })}
                        </p>
                        <p className="mt-1 text-xs font-medium text-muted-foreground">{t("packs.detail.coverageMissing")}</p>
                        <ul
                          className="mt-0.5 space-y-0.5 font-mono text-[10px] leading-4 text-muted-foreground"
                          data-testid="pack-detail-coverage-missing"
                        >
                          {pack.coverage.missing.map((path) => (
                            <li key={path}>{path}</li>
                          ))}
                        </ul>
                      </>
                    )}
                  </div>
                )}
              </section>
            )}

            {/* ⑦ 版本时间线（add-facet-version-history 懒披露契约不变：默认
                payload 不带版本列表、打开才取、只读检视无安装动作）。位置从
                规格书之前移到内容尾部——七段式阅读顺序。 */}
            <PackVersionList packId={pack.id} />
          </div>
        )}
        </div>

        {/* Action bar (polish-facet-interactions): a real flex child pinned to
            the dialog's bottom edge — the scroll pane ends above it, so it is
            always visible and nothing can show through behind it. The host-
            selected goto-mine affordance renders only when wired (the facet
            shell routes it through the login guidance when signed out). */}
        <div
          className="shrink-0 border-t border-border bg-background px-6 py-3"
          data-testid="pack-action-bar"
        >
          {loginHint && (
            <div
              className="mb-2 flex flex-wrap items-center justify-between gap-2 rounded-md border border-primary/30 bg-primary/5 px-3 py-2"
              data-testid="pack-login-guidance"
            >
              <span className="text-xs text-muted-foreground">{t("packs.detail.loginHint")}</span>
              {onRequireLogin && (
                <Button size="sm" className="h-7 px-3 text-xs" onClick={onRequireLogin} data-testid="pack-login-go">
                  {t("packs.detail.loginGo")}
                </Button>
              )}
            </div>
          )}
          {showFleetWizard && pack && (
            <div className="mb-2">
              <FleetTemplateWizard
                pack={pack}
                onCancel={() => setShowFleetWizard(false)}
                onDone={() => setShowFleetWizard(false)}
              />
            </div>
          )}
          <div className="flex items-center gap-2">
            {pack && (
              <Button
                variant="outline"
                onClick={() => window.open(`${studioOrigin ?? ""}/studio?fork=${encodeURIComponent(pack.id)}`, "_self")}
                data-testid="pack-fork"
                title={t("packs.detail.forkHint")}
              >
                {t("packs.detail.fork")}
              </Button>
            )}
            <Button onClick={() => void subscribe()} disabled={subscribing} data-testid="pack-subscribe">
              {subscribing
                ? t("common.loading")
                : pack?.pricing && pack.purchased !== true
                  ? t("packs.detail.buyPack", { price: pack.pricing.priceUsd.toFixed(2) })
                  : t("packs.detail.subscribe")}
            </Button>
            {/* 装作路径（add-fleet-owner-surface）：模板 pack 一键装作 — 付费
                闸仍在向导内复验; 只在壹座宿主开放(facet 匿名壳无安装面)。 */}
            {pack?.manifest?.fleet && !onRequireLogin && !showFleetWizard && (
              <Button variant="outline" onClick={() => setShowFleetWizard(true)} data-testid="pack-fleet-wizard-open">
                {t("packs.detail.fleetWizardBtn")}
              </Button>
            )}
            {onGotoMine &&
              (onRequireLogin ? (
                // Facet shell: no installed-packs surface for an anonymous
                // viewer — the button joins the login guidance row instead
                // of being a silent no-op.
                <Button variant="ghost" onClick={() => setLoginHint(true)}>
                  {t("packs.detail.gotoMine")}
                </Button>
              ) : (
                <Button variant="ghost" onClick={onGotoMine}>
                  {t("packs.detail.gotoMine")}
                </Button>
              ))}
          </div>
        </div>

        {/* Script confirm gate (add-packaged-skills 5.1): the one-time
            acknowledgment for script-bearing packs, mounted only after the
            server refused with script-confirm-required. Confirming retries
            the install with confirm=true; the gate is server-enforced. */}
        <Dialog open={scriptGate !== null} onOpenChange={(open) => !open && setScriptGate(null)}>
          <DialogContent className="max-w-md" data-testid="pack-script-confirm">
            <DialogHeader>
              <DialogTitle>{t("packs.detail.scriptGateTitle")}</DialogTitle>
              <DialogDescription>{t("packs.detail.scriptGateBody")}</DialogDescription>
            </DialogHeader>
            <ul className="max-h-48 space-y-1 overflow-y-auto text-sm">
              {scriptGate?.map((b) => (
                <li key={b.name}>
                  <span className="font-mono text-xs text-foreground">{b.name}</span>
                  <ul className="ml-4 list-disc">
                    {b.scriptFiles.map((f) => (
                      <li key={f} className="text-xs text-status-waiting">{f}</li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setScriptGate(null)}>
                {t("common.cancel")}
              </Button>
              <Button onClick={() => void subscribe(true)} disabled={subscribing} data-testid="pack-script-confirm-ok">
                {subscribing ? t("common.loading") : t("packs.detail.scriptGateConfirm")}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </DialogContent>
    </Dialog>
  );
}
