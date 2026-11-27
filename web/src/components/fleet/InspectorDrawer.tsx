// Inspector drawer (agent-fleet-cockpit v2 face 3) — the cockpit's one place
// for a post's detail AND its management actions. Five tabs: 概况 (status
// evidence, KPI slots, model chain, last turn), 配置 (cadence + model edits
// through the EXISTING member write path — incl. the dense-cadence confirm),
// 回合 (paged turn timeline), 产出 (latest + paged report timeline), 审批
// (the post's decisions, approve/reject through the existing decision ops).
// The tree cards and the standalone decisions dialog retire their action
// entry points — everything lands here. Actions arrive as callbacks the page
// owns (same fetch paths as before); this drawer never invents a write.
//
// The edge inspector (click an edge on the canvas, outside design mode)
// lives here too: kind, endpoints, declared constraints, and the 24h traffic
// split from the cockpit aggregate.

import { useCallback, useEffect, useMemo, useState } from "react";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useFleetStore } from "@/store/fleet-store";
import type { CanvasTraffic } from "@/components/fleet/FleetCanvas";
import { BotPlatformIcon } from "@/components/bots/BotPlatformIcons";
import { useChatStore } from "@platform/core";
import { fetchVoiceCatalog, type VoiceCatalog } from "@/lib/voice";

// ── shapes (mirrors of the page's MemberView slices, kept local) ────────────

export interface InspectorMember {
  id: string;
  fleetId: string;
  title: string;
  parentId: string | null;
  target: { kind: string; id: string; label: string };
  kpiSlots: { key: string; label: string; unit?: string; target?: number }[];
  cadence: { cron: string; tz: string | null; promptTemplate: string; enabled: boolean } | null;
  model: string | null;
  fallbackModel: string | null;
  /** Declared thinking depth (add-agent-config-dims); null = inherit. */
  effort: string | null;
  /** Declared per-turn context budget; null = unlimited. */
  contextBudget: number | null;
  /** Run concurrency read face (fleet-run-concurrency 3.1): four numbers, plus
   *  live held/queued. `declared` is the operator's own value (null = inherit);
   *  `effective` is what capacity allows; `limitedBy` names what capped it. */
  concurrency?: {
    declared: number | null;
    source: string;
    workbench: string;
    ceiling: number | { unknown: true; reason: string } | null;
    effective: number | null;
    limitedBy: string | null;
    held: number | null;
    queued: number | null;
    unreadable?: string[];
  } | null;
  effectiveModel: string | null;
  modelNotice: string | null;
  status: string;
  statusReason: string;
  // Downtime loss (P2, 2026-10-26): rounds a platform restart swallowed, and
  // whether a make-up run is in flight right now.
  missedRounds?: number;
  catchUpPending?: boolean;
  // Failure attribution (fix-fleet-failure-visibility): why a post reads
  // `failing` — streak length, newest failure kind, and when the run started.
  failureStreak?: number;
  failingSince?: string | null;
  lastErrorKind?: string | null;
  evidence: { lastRunAt: string | null; nextRunAt: string | null; staleWindowMs: number | null; latestReportAt: number | null; hitWindow: string | null };
  latestReport: { at: number; summary: string; source: string; sessionId: string | null; slots: { key: string; label: string; unit: string | null; value: string | number; trend: { direction: string; deltaValue: number | null } | null }[] } | null;
  lastTurn: {
    status: string;
    errorKind: string | null;
    error: string | null;
    endedAt: number;
    sessionId: string | null;
    detail?: { kind?: string; steps?: number; lastTool?: string | null; lastToolWaitedMs?: number; degradedTo?: string | null } | null;
  } | null;
  consecutiveFailures: number;
  /** The post's materialized task — null on taskless (passive) posts, where 立即交付 honestly doesn't render. */
  taskId?: string | null;
  /** Bot sidecar (fleet-ops-canvas): bot-kind posts carry their channel's
      runtime story read-only; absent columns surface as null. */
  bot?: { type: string; enabled: boolean; lastInboundAt: string | null; lastOutboundAt: string | null; lastError: string | null } | null;
  /**
   * 逐岗记忆章程（establish-agent-role-and-fitness-plane 3.2）：**真正生效的
   * 那一份**（与 catalogEntryPersona 注入 persona 的同源）。null = 未声明，
   * 不是空章程——两者在界面上必须分开显示。
   */
  memoryCharter?: string | null;
  /** 输入策略（既有字段，此前未在此抽屉展示）。 */
  inputPolicy?: Record<string, unknown> | null;
  /** 播报音色（add-room-voice-and-catalog）：`{model, voice}` 目录条目，null = 未声明。
   *  召唤进房间时随邀请带进座席；本抽屉是它的人工声明面。 */
  voice?: { model: string; voice: string } | null;
  effectiveInputPolicy?: Record<string, unknown> | null;
  /** 角色行（5.1）：null = 这个岗还没建过角色（不是「角色器官为空」）。 */
  role?: InspectorRole | null;
}

/** 角色四件事（9.1）：章程 / 记忆层 / 胜任力 / 目标。 */
export interface InspectorRole {
  // 字段名与 **API 返回的形状一致**（genome / organs）——类型是数据边界的描述，
  // 不是文案。界面层用终词（「所属包」「目标」）在渲染处翻译，两者不混。
  // 我第一版把这里的字段改名成 package/declared，结果 API 原样透传、界面读不到
  // （TS 在 data 边界不做检查）——浏览器验收当场抓到。
  genome: { packId: string; version: number | null } | null;
  organs: { objective?: { metricKey?: string; label?: string } | null } | null;
  status: string | null;
  statusBasis: string | null;
}

export interface InspectorDecision {
  id: string;
  question: string;
  options: { value: string; label: string }[];
  severity: string;
  state: string;
  submittedAt: number;
}

interface TurnRow {
  id: number;
  source: string;
  status: string;
  errorKind: string | null;
  error: string | null;
  model: string | null;
  startedAt: number;
  endedAt: number;
  sessionId: string | null;
  // 失败诊断（fleet-failure-diagnosis）：服务端把 error_kind 翻成人话 + 一条动作。
  diagnosis?: {
    covered: boolean;
    kind: string | null;
    verdict: string | null;
    evidence: Record<string, unknown>;
    action: { op: string; hint: string } | null;
  } | null;
}

interface ReportRow {
  id: string;
  at: number;
  summary: string;
  metrics: Record<string, { value: string | number; delta?: string }>;
  blockers: string[];
  sessionId: string | null;
}

const TABS = ["overview", "config", "turns", "reports", "decisions"] as const;
type Tab = (typeof TABS)[number];

function fmtTime(v: string | number | null, locale: string): string {
  if (v == null) return "—";
  const ms = typeof v === "number" ? v : Date.parse(v);
  if (!Number.isFinite(ms)) return "—";
  return new Date(ms).toLocaleString(locale, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function MemberInspector({
  member,
  initialTab = "overview",
  onClose,
  onSwap,
  onAction,
  onDecision,
  navigate,
}: {
  member: InspectorMember;
  /** The entry point can pick the landing tab (the decision banner opens 审批). */
  initialTab?: Tab;
  onClose: () => void;
  onSwap: () => void;
  onAction: (path: string, method: "POST" | "DELETE" | "PATCH", body?: Record<string, unknown>) => Promise<void> | void;
  onDecision: (item: InspectorDecision, op: "approve" | "reject", choice?: string) => Promise<void> | void;
  navigate: (to: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const [tab, setTab] = useState<Tab>(initialTab);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [turns, setTurns] = useState<TurnRow[]>([]);
  const [turnsBefore, setTurnsBefore] = useState<number | null>(null);
  const [reports, setReports] = useState<ReportRow[]>([]);
  const [reportsBefore, setReportsBefore] = useState<string | null>(null);
  const [decisions, setDecisions] = useState<InspectorDecision[]>([]);
  const base = `/api/fleets/${encodeURIComponent(member.fleetId)}/members/${encodeURIComponent(member.id)}`;

  // Config form state (配置 tab) — seeded from the member, PATCHed whole.
  const [cron, setCron] = useState(member.cadence?.cron ?? "");
  const [promptTemplate, setPromptTemplate] = useState(member.cadence?.promptTemplate ?? "");
  const [model, setModel] = useState(member.model ?? "");
  const [fallbackModel, setFallbackModel] = useState(member.fallbackModel ?? "");
  const [effort, setEffort] = useState(member.effort ?? "");
  const [contextBudget, setContextBudget] = useState(member.contextBudget != null ? String(member.contextBudget) : "");
  // 并行份数与工作台（fleet-run-concurrency 5.1）：空串 = 未声明（继承）。
  const [concurrency, setConcurrency] = useState(member.concurrency?.declared != null ? String(member.concurrency.declared) : "");
  const [workbench, setWorkbench] = useState(member.concurrency?.workbench ?? "off");
  const [denseConfirmed, setDenseConfirmed] = useState(false);
  const [configError, setConfigError] = useState<string | null>(null);
  // 播报音色（add-room-voice-and-catalog）：空串 = 未声明（回落部署默认）。
  const [voice, setVoice] = useState(member.voice ? `${member.voice.model}|${member.voice.voice}` : "");
  const [voiceCatalog, setVoiceCatalog] = useState<VoiceCatalog | null>(null);
  // Effort levels of the member's effective model (add-agent-config-dims D6):
  // the dropdown renders ONLY when the model that would run declares levels;
  // an unknown model (roster drift) hides the control instead of lying.
  const modelRoster = useChatStore((st) => st.models);
  useEffect(() => {
    // The catalog is a file served by the cell; an unreadable one hides the
    // picker rather than blocking the rest of the drawer.
    void fetchVoiceCatalog().then(setVoiceCatalog).catch(() => setVoiceCatalog(null));
  }, []);

  const effortLevels = useMemo(
    () => modelRoster.find((m) => m.id === (member.effectiveModel ?? member.model))?.reasoningEfforts ?? [],
    [modelRoster, member.effectiveModel, member.model],
  );

  const loadTurns = useCallback(
    async (before: number | null) => {
      const q = before != null ? `&before=${before}` : "";
      const r = await fetch(`${base}/turns?limit=10${q}`);
      if (!r.ok) return;
      const body = await r.json();
      setTurns((prev) => (before == null ? body.turns : [...prev, ...body.turns]));
      setTurnsBefore(body.nextBefore ?? null);
    },
    [base],
  );

  const loadReports = useCallback(
    async (before: string | null) => {
      const q = before != null ? `&before=${encodeURIComponent(before)}` : "";
      const r = await fetch(`${base}/reports?limit=10${q}`);
      if (!r.ok) return;
      const body = await r.json();
      setReports((prev) => (before == null ? body.reports : [...prev, ...body.reports]));
      setReportsBefore(body.nextBefore ?? null);
    },
    [base],
  );

  const loadDecisions = useCallback(async () => {
    const r = await fetch(`/api/fleets/${encodeURIComponent(member.fleetId)}/decisions?state=all`);
    if (!r.ok) return;
    const body = await r.json();
    setDecisions((body.decisions ?? []).filter((d: InspectorDecision & { memberId: string }) => d.memberId === member.id));
  }, [member.fleetId, member.id]);

  useEffect(() => {
    setTurns([]);
    setTurnsBefore(null);
    setReports([]);
    setReportsBefore(null);
    setDecisions([]);
    void loadTurns(null);
    void loadReports(null);
    void loadDecisions();
  }, [loadTurns, loadReports, loadDecisions]);

  // Drawer self-refresh (add-cockpit-ops-loop): while open, any fleet event
  // (a turn of this post ending among them) re-pulls the data tabs — the
  // overview rides the page's member prop via the throttled refetch.
  const fleetVersion = useFleetStore((s) => s.version);
  const [runNote, setRunNote] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  useEffect(() => {
    if (fleetVersion === 0) return;
    void loadTurns(null);
    void loadReports(null);
    void loadDecisions();
  }, [fleetVersion, loadTurns, loadReports, loadDecisions]);

  const runNow = async () => {
    if (!member.taskId) return;
    setRunning(true);
    setRunNote(null);
    try {
      const r = await fetch(`/api/cron/${encodeURIComponent(member.taskId)}/run`, { method: "POST" });
      const body = await r.json().catch(() => ({}));
      setRunNote(
        r.ok
          ? body.already
            ? t("fleets.inspector.alreadyRunning")
            : t("fleets.inspector.runStarted")
          : (body.error ?? `${r.status}`),
      );
    } catch (e) {
      setRunNote(String((e as Error).message ?? e));
    } finally {
      setRunning(false);
    }
  };

  const saveConfig = async () => {
    setConfigError(null);
    const cadence = cron.trim()
      ? { cron: cron.trim(), tz: member.cadence?.tz ?? null, promptTemplate: promptTemplate.trim(), enabled: member.cadence?.enabled ?? true }
      : null;
    // The dense-cadence confirm gate mirrors the composer's (server enforces
    // too; this is the honest UI half).
    if (cadence) {
      const min = cadence.cron.split(" ")[0] ?? "";
      const everyMinute = /^\*$/.test(min.trim());
      if (everyMinute && !denseConfirmed) {
        setConfigError(t("fleets.dense.confirm"));
        return;
      }
    }
    const budgetNum = contextBudget.trim() === "" ? null : Number(contextBudget.trim());
    if (contextBudget.trim() !== "" && (!Number.isInteger(budgetNum) || (budgetNum ?? 0) <= 0)) {
      setConfigError(t("fleets.inspector.contextBudgetInvalid"));
      return;
    }
    // 并行份数与工作台（fleet-run-concurrency 5.1）：与 effort/contextBudget 同一条
    // 纪律——空串 = 清除声明。off + 份数>1 在保存前就被拦下（与服务端同一条闸，
    // 不靠服务端兜底：那种错误只有到了服务端才暴露，用户看到的是一个 400）。
    const concNum = concurrency.trim() === "" ? null : Number(concurrency.trim());
    if (concurrency.trim() !== "" && (!Number.isInteger(concNum) || (concNum ?? 0) < 1)) {
      setConfigError(t("fleets.inspector.concurrencyInvalid"));
      return;
    }
    const effConc = concNum ?? (member.concurrency?.declared ?? 1);
    const effWb = workbench || (member.concurrency?.workbench ?? "off");
    if (effConc > 1 && effWb === "off") {
      setConfigError(t("fleets.inspector.parallelNeedsWorkbench"));
      return;
    }
    await onAction(base, "PATCH", {
      ...(cadence ? { cadence } : {}),
      model: model.trim() || null,
      fallbackModel: fallbackModel.trim() || null,
      ...(effortLevels.length ? { effort: effort || null } : {}),
      contextBudget: budgetNum,
      concurrency: concNum,
      workbench,
      // An empty selection clears the declaration (null = inherit). The server
      // validates the pair against the catalog and rejects an unknown one.
      voice: voice ? { model: voice.split("|")[0], voice: voice.split("|")[1] } : null,
    });
  };

  const tabLabels: Record<Tab, string> = {
    overview: t("fleets.inspector.tab.overview"),
    config: t("fleets.inspector.tab.config"),
    turns: t("fleets.inspector.tab.turns"),
    reports: t("fleets.inspector.tab.reports"),
    decisions: t("fleets.inspector.tab.decisions"),
  };

  return (
    <div className="fixed inset-y-0 right-0 z-40 flex w-[400px] max-w-[92vw] flex-col border-l border-border bg-card shadow-xl" data-testid={`inspector-${member.id}`}>
      <div className="flex items-center gap-2 border-b border-border p-3">
        <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">{t(`fleets.status.${member.status}`)}</span>
        <span className="truncate text-sm font-medium">{member.title}</span>
        <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
          {member.target.kind === "bot" && member.bot ? <BotPlatformIcon type={member.bot.type} className="mr-1 inline-block h-3 w-3 align-[-2px]" /> : null}
          {t(`fleets.kind.${member.target.kind}`)}
        </span>
        <button type="button" className="ml-auto rounded-md border border-border px-2 py-0.5 text-xs hover:bg-muted" onClick={onClose} data-testid="inspector-close">
          ✕
        </button>
      </div>
      <div className="flex gap-1 border-b border-border px-2 py-1.5 text-xs">
        {TABS.map((k) => (
          <button
            key={k}
            type="button"
            data-testid={`inspector-tab-${k}`}
            className={`rounded-md px-2 py-1 ${tab === k ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted"}`}
            onClick={() => setTab(k)}
          >
            {tabLabels[k]}
          </button>
        ))}
      </div>
      <div className="flex-1 overflow-y-auto p-3 text-xs">
        {tab === "overview" ? (
          <div className="flex flex-col gap-3" data-testid="inspector-overview">
            {/* 角色四件事（establish-agent-role-and-fitness-plane 9.1）：章程 /
                记忆层 / 胜任力 / 目标。每一项缺失都显示「未声明」而不是空——
                「没写」与「写了但为空」对 owner 是两个不同的事实。 */}
            <div data-testid="inspector-role">
              <p className="font-medium">{t("fleets.inspector.roleTitle")}</p>
              <p className="mt-1 text-muted-foreground" data-testid="inspector-role-charter">
                {t("fleets.inspector.roleCharter")}: {member.memoryCharter ?? t("fleets.inspector.roleUnset")}
              </p>
              <p className="text-muted-foreground" data-testid="inspector-role-objective">
                {t("fleets.inspector.roleObjective")}:{" "}
                {member.role?.organs?.objective?.label ?? member.role?.organs?.objective?.metricKey ?? t("fleets.inspector.roleUnset")}
              </p>
              <p className="text-muted-foreground" data-testid="inspector-role-status">
                {t("fleets.inspector.roleStatus")}: {member.role?.status ?? t("fleets.inspector.roleUnset")}
                {member.role?.statusBasis ? ` · ${member.role.statusBasis}` : ""}
              </p>
              {member.role?.genome ? (
                <p className="text-muted-foreground">
                  {t("fleets.inspector.rolePackage")}: {member.role.genome.packId}
                  {member.role.genome.version != null ? ` @ v${member.role.genome.version}` : ""}
                </p>
              ) : null}
            </div>
            <div>
              <p className="font-medium">{t("fleets.inspector.statusBasis")}</p>
              <p className="mt-1 text-muted-foreground">{member.statusReason || "—"}</p>
              <p className="mt-1 text-muted-foreground">
                {t("fleets.evidence.lastRun")}: {fmtTime(member.evidence.lastRunAt, locale)} · {t("fleets.evidence.nextRun")}: {fmtTime(member.evidence.nextRunAt, locale)}
              </p>
              {member.evidence.staleWindowMs ? (
                <p className="text-muted-foreground">
                  {t("fleets.evidence.staleWindow")}: {Math.round(member.evidence.staleWindowMs / 3_600_000)}h
                </p>
              ) : null}
              {(member.missedRounds ?? 0) > 0 ? (
                <p className="text-warning" data-testid="inspector-missed">
                  {t("fleets.evidence.missedRounds")}: {member.missedRounds}{" "}
                  {t("fleets.evidence.missedUnit")}
                  {member.catchUpPending ? ` · ${t("fleets.evidence.catchUpPending")}` : ""}
                </p>
              ) : null}
            </div>
            {member.target.kind === "persona" ? (
              <div>
                <p className="font-medium">{t("fleets.inspector.modelChain")}</p>
                <p className="mt-1 text-muted-foreground">
                  {t("fleets.inspector.declared")}: {member.model || "—"} · {t("fleets.inspector.fallback")}: {member.fallbackModel || "—"}
                </p>
                <p className="text-muted-foreground">
                  {t("fleets.inspector.effective")}:{" "}
                  <span className={member.modelNotice ? "text-warning" : ""} title={member.modelNotice ?? undefined}>
                    {member.effectiveModel || "—"}
                  </span>
                  {member.modelNotice ? ` (${member.modelNotice})` : ""}
                </p>
              </div>
            ) : null}
            {member.target.kind === "bot" && member.bot ? (
              <div data-testid="inspector-bot-summary">
                <p className="font-medium">{t("fleets.inspector.botChannel")}</p>
                <p className="mt-1 text-muted-foreground">
                  {t(`botsPage.types.${member.bot.type}`, member.bot.type)} ·{" "}
                  <span className={member.bot.enabled ? "text-success" : "text-muted-foreground"}>
                    {member.bot.enabled ? t("botsPage.enabled") : t("botsPage.disabled", "disabled")}
                  </span>
                </p>
                <p className="text-muted-foreground">
                  {t("fleets.inspector.botInbound")}: {fmtTime(member.bot.lastInboundAt, locale)} · {t("fleets.inspector.botOutbound")}: {fmtTime(member.bot.lastOutboundAt, locale)}
                </p>
                {member.bot.lastError ? (
                  <p className="text-destructive" title={member.bot.lastError}>
                    {t("fleets.inspector.botLastError")}: {member.bot.lastError}
                  </p>
                ) : null}
                <a className="mt-0.5 inline-block text-primary underline-offset-2 hover:underline" href="/bots" data-testid="inspector-bot-link">
                  {t("fleets.inspector.botOpenPage")}
                </a>
              </div>
            ) : null}
            {member.lastTurn ? (
              <div>
                <p className="font-medium">{t("fleets.inspector.lastTurn")}</p>
                <p className={`mt-1 ${member.lastTurn.status === "ok" ? "text-success" : member.lastTurn.status === "skipped" ? "text-warning" : "text-destructive"}`}>
                  {member.lastTurn.status}
                  {member.lastTurn.errorKind ? ` · ${member.lastTurn.errorKind}` : ""}
                  {member.consecutiveFailures >= 3 ? ` · ${t("fleets.turn.consecutive")} ×${member.consecutiveFailures}` : ""}
                </p>
                {/* Timeout attribution (fix-fleet-turn-attribution D1): the row
                    says WHAT to do next — stalled = fix the tool, budget =
                    raise the budget or shorten the work. */}
                {member.lastTurn.status === "failed" && member.lastTurn.detail?.kind ? (
                  <p className="mt-1 text-muted-foreground" data-testid="inspector-turn-detail">
                    {member.lastTurn.detail.kind === "stalled"
                      ? t("fleets.turnDetail.stalled", {
                          tool: member.lastTurn.detail.lastTool ?? "—",
                          wait: Math.round((member.lastTurn.detail.lastToolWaitedMs ?? 0) / 1000),
                        })
                      : t("fleets.turnDetail.budget", { n: member.lastTurn.detail.steps ?? 0 })}
                    {member.lastTurn.detail.degradedTo
                      ? ` · ${t("fleets.turnDetail.degradedTo")}: ${member.lastTurn.detail.degradedTo}`
                      : ""}
                  </p>
                ) : null}
                {member.lastTurn.status === "skipped" ? (
                  <p className="mt-1 text-muted-foreground" data-testid="inspector-skipped">
                    {t("fleets.turnDetail.skipped")}
                  </p>
                ) : null}
                {/* A downgraded post must say WHY in the same breath as the
                    colour (fix-fleet-failure-visibility): streak, cause, since. */}
                {member.status === "failing" ? (
                  <p className="mt-1 text-warning" data-testid="inspector-failing">
                    {t("fleets.failure.streak", { n: member.failureStreak ?? member.consecutiveFailures ?? 0 })}
                    {member.lastErrorKind ? ` · ${t("fleets.failure.lastKind")}: ${member.lastErrorKind}` : ""}
                    {member.failingSince ? ` · ${t("fleets.failure.since")}: ${fmtTime(member.failingSince, locale)}` : ""}
                  </p>
                ) : null}
                {member.lastTurn.sessionId ? (
                  <button type="button" className="mt-1 rounded-md border border-border px-1.5 py-px hover:bg-muted" onClick={() => navigate(`/chat/${encodeURIComponent(member.lastTurn!.sessionId!)}`)}>
                    {t("fleets.report.openSession")}
                  </button>
                ) : null}
              </div>
            ) : (
              <p className="text-muted-foreground">{t("fleets.turn.neverRun")}</p>
            )}
            {member.kpiSlots.length > 0 ? (
              <div>
                <p className="font-medium">{t("fleets.inspector.slots")}</p>
                <div className="mt-1 flex flex-wrap gap-1">
                  {member.kpiSlots.map((s) => {
                    const latest = member.latestReport?.slots.find((x) => x.key === s.key);
                    // Slot values are free-form — an agent may report prose
                    // into one; the chip stays one line, full text on hover.
                    const full = `${s.label}: ${latest ? `${latest.value}${latest.unit ?? ""}` : "—"}${s.target != null ? ` / ${s.target}` : ""}`;
                    const raw = latest ? `${latest.value}${latest.unit ?? ""}` : "—";
                    const short = raw.length > 24 ? `${raw.slice(0, 23)}…` : raw;
                    return (
                      <span key={s.key} className="max-w-full min-w-0 rounded-full bg-muted px-2 py-0.5" title={full}>
                        <span className="shrink-0">{s.label}: </span>
                        <span className="font-medium">{short}</span>
                        {s.target != null ? ` / ${s.target}` : ""}
                      </span>
                    );
                  })}
                </div>
              </div>
            ) : null}
          </div>
        ) : null}

        {tab === "config" ? (
          <div className="flex flex-col gap-3" data-testid="inspector-config">
            <div className="flex flex-col gap-1">
              <Label htmlFor="ins-cron">{t("fleets.inspector.cadence")}</Label>
              <Input id="ins-cron" value={cron} onChange={(e) => setCron(e.target.value)} placeholder="0 9 * * *" data-testid="inspector-cron" />
              <Input value={promptTemplate} onChange={(e) => setPromptTemplate(e.target.value)} placeholder={t("fleets.inspector.promptTemplate")} data-testid="inspector-prompt" />
              {member.cadence ? (
                <Button variant="outline" size="sm" className="w-fit" onClick={() => void onAction(`${base}/${member.cadence!.enabled ? "pause" : "resume"}`, "POST")}>
                  {member.cadence.enabled ? t("fleets.member.pause") : t("fleets.member.resume")}
                </Button>
              ) : null}
              {member.taskId ? (
                <Button variant="outline" size="sm" className="w-fit" disabled={running} onClick={() => void runNow()} data-testid="inspector-run-now">
                  {t("fleets.inspector.runNow")}
                </Button>
              ) : null}
            </div>
            {runNote ? <p className="text-muted-foreground" data-testid="inspector-run-note">{runNote}</p> : null}
            {member.target.kind === "persona" ? (
              <div className="flex flex-col gap-1">
                <Label htmlFor="ins-model">{t("fleets.inspector.declared")}</Label>
                <Input id="ins-model" value={model} onChange={(e) => setModel(e.target.value)} data-testid="inspector-model" />
                <Label htmlFor="ins-fallback">{t("fleets.inspector.fallback")}</Label>
                <Input id="ins-fallback" value={fallbackModel} onChange={(e) => setFallbackModel(e.target.value)} />
                {effortLevels.length ? (
                  <div className="flex flex-col gap-1">
                    <Label htmlFor="ins-effort">{t("fleets.inspector.effort")}</Label>
                    <select
                      id="ins-effort"
                      value={effort}
                      onChange={(e) => setEffort(e.target.value)}
                      data-testid="inspector-effort"
                      className="h-10 rounded-md border border-input bg-background px-3 text-sm text-foreground"
                    >
                      <option value="">{t("fleets.inspector.effortInherit")}</option>
                      {effortLevels.map((l) => (
                        <option key={l} value={l}>
                          {l}
                        </option>
                      ))}
                    </select>
                  </div>
                ) : null}
                <Label htmlFor="ins-budget">{t("fleets.inspector.contextBudget")}</Label>
                <Input
                  id="ins-budget"
                  type="number"
                  min={1024}
                  value={contextBudget}
                  placeholder={t("fleets.inspector.contextBudgetUnlimited")}
                  onChange={(e) => setContextBudget(e.target.value)}
                  data-testid="inspector-context-budget"
                />
                <p className="text-muted-foreground">
                  {t("fleets.inspector.effective")}: {member.effectiveModel || "—"}
                </p>
                {/* 并行份数与工作台（fleet-run-concurrency 5.1）。生效值小于声明值时
                    必须点名压顶原因：只显示一个较小的数，读者分不出「上限就是这么多」
                    与「配了更多但此刻只放得下这么多」，而两者处置相反。 */}
                <Label htmlFor="ins-concurrency">{t("fleets.inspector.concurrency")}</Label>
                <Input
                  id="ins-concurrency"
                  type="number"
                  min={1}
                  value={concurrency}
                  placeholder={t("fleets.inspector.concurrencyInherit")}
                  onChange={(e) => setConcurrency(e.target.value)}
                  data-testid="inspector-concurrency"
                />
                <div className="flex flex-col gap-1">
                  <Label htmlFor="ins-workbench">{t("fleets.inspector.workbench")}</Label>
                  <select
                    id="ins-workbench"
                    value={workbench}
                    onChange={(e) => setWorkbench(e.target.value)}
                    data-testid="inspector-workbench"
                    className="h-10 rounded-md border border-input bg-background px-3 text-sm text-foreground"
                  >
                    <option value="off">{t("fleets.inspector.workbenchOff")}</option>
                    <option value="auto">{t("fleets.inspector.workbenchAuto")}</option>
                  </select>
                </div>
                {member.concurrency?.effective != null ? (
                  <p className="text-muted-foreground" data-testid="inspector-concurrency-effective">
                    {t("fleets.inspector.concurrencyEffective")}: {member.concurrency.effective}
                    {member.concurrency.limitedBy
                      ? ` · ${t("fleets.inspector.concurrencyLimited")} ${member.concurrency.limitedBy}`
                      : ""}
                    {member.concurrency.held != null
                      ? ` · ${t("fleets.inspector.concurrencyHeld")} ${member.concurrency.held}/${member.concurrency.effective}`
                      : ""}
                  </p>
                ) : null}
              </div>
            ) : null}
            {/* 播报音色（add-room-voice-and-catalog）：打分岗共用同一编队音色面，
                所以这一段放在 persona 块之外——每个岗都能声明自己的声音。 */}
            <div className="flex flex-col gap-1">
              <Label htmlFor="ins-voice">{t("fleets.inspector.voice")}</Label>
              <select
                id="ins-voice"
                value={voice}
                onChange={(e) => setVoice(e.target.value)}
                data-testid="inspector-voice"
                className="h-10 rounded-md border border-input bg-background px-3 text-sm text-foreground"
              >
                <option value="">{t("fleets.inspector.voiceInherit")}</option>
                {(voiceCatalog?.entries ?? []).map((e) => (
                  <option key={`${e.model}|${e.voice}`} value={`${e.model}|${e.voice}`}>
                    {e.label} · {e.protocol}
                  </option>
                ))}
              </select>
            </div>
            <label className="flex items-center gap-1.5 text-muted-foreground">
              <input type="checkbox" checked={denseConfirmed} onChange={(e) => setDenseConfirmed(e.target.checked)} data-testid="inspector-dense" />
              {t("fleets.dense.confirm")}
            </label>
            {configError ? <p className="text-destructive">{configError}</p> : null}
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={() => void saveConfig()} data-testid="inspector-save">
                {t("common.save")}
              </Button>
              <Button variant="outline" size="sm" onClick={onSwap}>
                {t("fleets.swap")}
              </Button>
              <Button variant="outline" size="sm" onClick={() => setRemoveOpen(true)}>
                {t("fleets.member.remove")}
              </Button>
              <ConfirmDialog
                open={removeOpen}
                onOpenChange={setRemoveOpen}
                title={t("fleets.member.remove")}
                description={t("fleets.member.confirmRemove")}
                confirmLabel={t("fleets.member.remove")}
                cancelLabel={t("common.cancel")}
                variant="danger"
                onConfirm={() => void onAction(base, "DELETE")}
              />
            </div>
          </div>
        ) : null}

        {tab === "turns" ? (
          <div className="flex flex-col gap-1.5" data-testid="inspector-turns">
            {turns.length === 0 ? <p className="text-muted-foreground">{t("fleets.turn.neverRun")}</p> : null}
            {turns.map((tu) => (
              <div key={tu.id} className="flex items-center gap-2 rounded-md border border-border px-2 py-1" data-testid={`inspector-turn-${tu.id}`}>
                <span className={tu.status === "ok" ? "text-success" : tu.status === "failed" ? "text-destructive" : tu.status === "skipped" ? "text-muted-foreground" : "text-warning"}>{tu.status}</span>
                <span className="text-muted-foreground">{t(`fleets.runs.source.${tu.source}`)}</span>
                <span className="ml-auto text-muted-foreground">{fmtTime(tu.endedAt, locale)}</span>
                {tu.sessionId ? (
                  <button type="button" className="rounded-sm border border-border px-1 hover:bg-muted" onClick={() => navigate(`/chat/${encodeURIComponent(tu.sessionId!)}`)}>
                    ↗
                  </button>
                ) : null}
                {tu.diagnosis ? (
                  <span className="w-full" data-testid={`turn-diagnosis-${tu.id}`}>
                    {tu.diagnosis.covered && tu.diagnosis.action ? (
                      <>
                        <span className="block text-destructive">{t(`fleets.diagnosis.${tu.diagnosis.kind}`)}</span>
                        <span className="block text-muted-foreground">{t(`fleets.diagnosis.action.${tu.diagnosis.action.op}`)}</span>
                      </>
                    ) : (
                      <span className="block text-muted-foreground">
                        {t("fleets.diagnosis.uncovered")}
                        {tu.diagnosis.evidence?.errorKind ? ` · ${String(tu.diagnosis.evidence.errorKind)}` : ""}
                      </span>
                    )}
                  </span>
                ) : tu.errorKind ? (
                  <span className="w-full truncate text-muted-foreground" title={tu.error ?? undefined}>{tu.errorKind}</span>
                ) : null}
              </div>
            ))}
            {turnsBefore != null ? (
              <Button variant="outline" size="sm" onClick={() => void loadTurns(turnsBefore)} data-testid="inspector-turns-more">
                {t("common.more")}
              </Button>
            ) : null}
          </div>
        ) : null}

        {tab === "reports" ? (
          <div className="flex flex-col gap-1.5" data-testid="inspector-reports">
            {member.latestReport ? (
              <div className="rounded-md border border-border p-2" data-testid="inspector-latest">
                <p className="line-clamp-3">{member.latestReport.summary}</p>
                <p className="mt-1 text-muted-foreground">{fmtTime(member.latestReport.at, locale)}</p>
              </div>
            ) : null}
            {reports.map((row) => (
              <div key={row.id} className="rounded-md border border-border px-2 py-1" data-testid={`inspector-report-${row.id}`}>
                <p className="line-clamp-2">{row.summary}</p>
                <p className="mt-0.5 text-muted-foreground">{fmtTime(row.at, locale)}</p>
              </div>
            ))}
            {reportsBefore != null ? (
              <Button variant="outline" size="sm" onClick={() => void loadReports(reportsBefore)}>
                {t("common.more")}
              </Button>
            ) : null}
          </div>
        ) : null}

        {tab === "decisions" ? (
          <div className="flex flex-col gap-2" data-testid="inspector-decisions">
            {decisions.length === 0 ? <p className="text-muted-foreground">{t("fleets.inspector.noDecisions")}</p> : null}
            {decisions.map((d) => (
              <div key={d.id} className="rounded-md border border-border p-2">
                <p className="line-clamp-2">
                  [{d.severity}] {d.question}
                </p>
                <p className="mt-0.5 text-muted-foreground">
                  {t(`fleets.decisions.state.${d.state}`) ?? d.state} · {fmtTime(d.submittedAt, locale)}
                </p>
                {d.state === "open" ? (
                  <div className="mt-1 flex flex-wrap gap-1">
                    {d.options.map((o) => (
                      <Button key={o.value} size="sm" variant="outline" onClick={() => void onDecision(d, "approve", o.value)}>
                        {o.label}
                      </Button>
                    ))}
                    <Button size="sm" variant="outline" onClick={() => void onDecision(d, "reject")}>
                      {t("fleets.decisions.reject")}
                    </Button>
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function EdgeInspector({
  edge,
  memberTitles,
  constraints,
  traffic,
  onClose,
}: {
  edge: { kind: string; from?: string; to?: string; targets?: string[]; aggregate?: { kind: string; judge?: string }; cron?: string; rounds?: number };
  memberTitles: Map<string, string>;
  constraints: { maxChainDepth?: number; spanMax?: number; budgetPerEdgeMin?: number } | null;
  traffic: CanvasTraffic[];
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const title = (id?: string) => memberTitles.get(id ?? "") ?? id ?? "?";
  const hit = useMemo(
    () => traffic.find((tr) => tr.from === edge.from && (tr.to === edge.to || (edge.targets ?? []).includes(tr.to)) && tr.kind === edge.kind) ?? null,
    [traffic, edge],
  );
  return (
    <div className="fixed inset-y-0 right-0 z-40 flex w-[340px] max-w-[92vw] flex-col border-l border-border bg-card p-3 text-xs shadow-xl" data-testid="edge-inspector">
      <div className="flex items-center gap-2">
        <span className="rounded-full bg-muted px-2 py-0.5">{t(`fleets.orch.edge.${edge.kind}`)}</span>
        <span className="font-medium">
          {title(edge.from)} → {edge.targets?.length ? edge.targets.map(title).join(", ") : title(edge.to)}
        </span>
        <button type="button" className="ml-auto rounded-md border border-border px-2 py-0.5 hover:bg-muted" onClick={onClose} data-testid="edge-inspector-close">
          ✕
        </button>
      </div>
      <div className="mt-3 flex flex-col gap-2">
        {edge.cron ? <p className="text-muted-foreground">cron: {edge.cron}</p> : null}
        {edge.aggregate ? (
          <p className="text-muted-foreground">
            {t("fleets.orch.phrase.aggregate")}: {edge.aggregate.kind}
            {edge.aggregate.judge ? ` · ${t("fleets.orch.phrase.judge")}: ${title(edge.aggregate.judge)}` : ""}
          </p>
        ) : null}
        {edge.rounds ? <p className="text-muted-foreground">rounds: {edge.rounds}</p> : null}
        <p className="text-muted-foreground">
          {t("fleets.orch.chainDepth")}: {constraints?.maxChainDepth ?? 8}
          {constraints?.budgetPerEdgeMin ? ` · ${t("fleets.orch.budget")}: ${constraints.budgetPerEdgeMin}min` : ""}
        </p>
        <div className="rounded-md border border-border p-2">
          <p className="font-medium">{t("fleets.inspector.edgeTraffic")}</p>
          {hit ? (
            <p className="mt-1 text-muted-foreground" data-testid="edge-inspector-traffic">
              24h: {hit.turns} · ok {hit.ok} · failed {hit.failed}
            </p>
          ) : (
            <p className="mt-1 text-muted-foreground" data-testid="edge-inspector-traffic">
              {t("fleets.inspector.noTraffic")}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

export default MemberInspector;
