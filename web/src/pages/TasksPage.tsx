// TasksPage.tsx — scheduled-task management surface (spec: scheduled-tasks-ui).
//
// List + creation form + per-job actions, all fed live by the cron store
// (cron_* events; commands go out over the same WS as chat). The creation
// form's schedule presets (daily / weekly / custom cron) build cron
// expressions client-side; the server re-validates and answers cron_error on
// a bad expression.

import { useEffect, useMemo, useState } from "react";
import { showToast } from "@/components/ui/toast";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { useChatStore, useCronStore, type ClientMessage, type CronJob } from "@platform/core";
import { describeJobSchedule, formatInJobTz, weekdayLabel } from "@/lib/cron-text";
import { parseSchedule, zhWeekdayName, type ParsedSchedule } from "@/lib/scheduleParse";
import { useProjectsStore } from "@/hooks/useProjectsStore";
import { IS_DESKTOP } from "@/lib/environment";

export interface TasksPageProps {
  send: (msg: ClientMessage) => void;
}

type Freq = "daily" | "weekly" | "custom" | "interval";
type Mode = "recurring" | "once";
type IntervalUnit = "minute" | "hour" | "day" | "week";

// ISO → the value shape a <input type="datetime-local"> expects (local wall
// clock, no seconds/zone). Used only to prefill the edit form.
function toLocalInput(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Automation templates (add-projects-automation-flow): one-click prefills of
// name + prompt + schedule. Copy is locale content; the schedule values here
// are the product's own defaults.
const TEMPLATES: { key: string; freq: Freq; time?: string; weekdays?: number[]; cron?: string }[] = [
  { key: "briefing", freq: "daily", time: "09:00" },
  { key: "weekly", freq: "weekly", weekdays: [5], time: "17:00" },
  { key: "inspection", freq: "custom", cron: "5 * * * *" },
];

const STATUS_STYLES: Record<string, string> = {
  scheduled: "bg-success/15 text-success",
  running: "bg-primary/15 text-primary",
  paused: "bg-muted text-muted-foreground",
  completed: "bg-muted text-muted-foreground",
  expired: "bg-warning/15 text-warning",
  error: "bg-destructive/15 text-destructive",
  // Execution lifecycle (task-engine): live or needs-attention states win the
  // badge over the schedule status; "done" falls back to the schedule badge.
  queued: "bg-primary/15 text-primary",
  failed: "bg-destructive/15 text-destructive",
  interrupted: "bg-warning/15 text-warning",
};

// Badge precedence: paused is an explicit user action; a live or failed
// execution outranks the schedule status; otherwise the schedule status
// (scheduled/completed/expired) speaks.
function badgeKey(job: CronJob): string {
  if (job.paused) return "paused";
  if (job.state === "queued" || job.state === "running" || job.state === "failed" || job.state === "interrupted") {
    return job.state;
  }
  return job.status;
}

function TaskCard({
  job,
  send,
  onOpenSession,
  onEdit,
}: {
  job: CronJob;
  send: TasksPageProps["send"];
  onOpenSession: (id: string) => void;
  onEdit: (job: CronJob) => void;
}) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const last = job.history.at(-1);
  const badge = badgeKey(job);
  const rerunnable = job.state === "failed" || job.state === "interrupted";
  // Run history expands per task (add-cron-automation-parity 3.3): pure read of
  // the existing history entries — no new backend enumeration. A load failure
  // is not possible here (the entries ride the job payload), so the expansion
  // never blocks the inline card.
  const [historyOpen, setHistoryOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  return (
    <div
      className="rounded-md border border-border bg-card p-4"
      data-testid="cron-job"
      data-job-id={job.id}
      data-job-status={job.status}
      data-job-state={job.state ?? ""}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_STYLES[badge]}`}>
              {t(`tasks.status.${badge}`)}
            </span>
            <span
              className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground"
              data-testid="cron-job-trigger"
            >
              {t(`tasks.trigger.${job.trigger ?? "schedule"}`)}
            </span>
            <span className="text-sm font-medium" data-testid="cron-job-schedule">
              {describeJobSchedule(t, job, locale)}
            </span>
          </div>
          <p className="mt-2 line-clamp-2 text-sm text-foreground" data-testid="cron-job-prompt">
            {job.prompt}
          </p>
          {(job.state === "failed" || job.state === "interrupted") && job.error ? (
            <p className="mt-1 text-xs text-destructive" data-testid="cron-job-error">
              {job.error}
            </p>
          ) : null}
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            {job.clusterId ? (
              <span
                data-testid="cron-job-cluster"
                className="inline-flex items-center gap-1 rounded-full border border-primary/40 bg-primary/10 px-2 py-0.5 font-medium text-primary"
              >
                {t("tasks.fields.cluster", { name: job.clusterName || job.clusterId, count: job.agentCount ?? "?" })}
              </span>
            ) : (job.target?.ref ?? job.preset) ? (
              <span>{t("tasks.fields.agent")}: {job.target?.ref ?? job.preset}</span>
            ) : null}
            {job.clusterId && job.sessionId && (job.targetAgents?.length ?? 0) > 0 && (
              <span className="inline-flex flex-wrap items-center gap-1" data-testid="cron-job-cluster-members">
                {(job.targetAgents ?? []).map((agentId) => (
                  <button
                    key={agentId}
                    type="button"
                    onClick={() =>
                      onOpenSession(
                        `${job.sessionId}--${agentId.toLowerCase().replace(/[^a-z0-9-]+/g, "-").slice(0, 64)}`,
                      )
                    }
                    className="rounded-sm border border-border px-1.5 py-px hover:bg-muted"
                    title={`${job.sessionId}--${agentId}`}
                  >
                    {agentId}
                  </button>
                ))}
              </span>
            )}
            {job.nextRun ? (
              <span>
                {t("tasks.fields.nextRun")}: {formatInJobTz(job.nextRun, job.tz, locale)}
              </span>
            ) : null}
            <span>
              {t("tasks.fields.lastRun")}:{" "}
              {last
                ? last.success === null
                  ? t("tasks.fields.missedRuns", { count: last.missed ?? 0 })
                  : last.success
                    ? t("tasks.fields.lastOk")
                    : `${t("tasks.fields.lastFailed")}${last.error ? ` — ${last.error}` : ""}`
                : t("tasks.fields.never")}
            </span>
            {job.missed > 0 ? <span>{t("tasks.fields.missedTotal", { count: job.missed })}</span> : null}
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
          {job.sessionId ? (
            <button
              className="rounded-md border border-border px-2.5 py-1 text-xs hover:bg-muted"
              onClick={() => onOpenSession(job.sessionId!)}
              data-testid="cron-job-open-session"
            >
              {t("tasks.actions.output")}
            </button>
          ) : null}
          <button
            className="rounded-md border border-border px-2.5 py-1 text-xs hover:bg-muted"
            onClick={() => send({ type: "cron_run", jobId: job.id })}
            data-testid={rerunnable ? "cron-job-rerun" : "cron-job-run"}
          >
            {rerunnable ? t("tasks.actions.rerun") : t("tasks.actions.runNow")}
          </button>
          <button
            className="rounded-md border border-border px-2.5 py-1 text-xs hover:bg-muted"
            onClick={() => onEdit(job)}
            data-testid="cron-job-edit"
          >
            {t("tasks.actions.edit")}
          </button>
          <button
            className="rounded-md border border-border px-2.5 py-1 text-xs hover:bg-muted"
            onClick={() =>
              send(job.paused ? { type: "cron_resume", jobId: job.id } : { type: "cron_pause", jobId: job.id })
            }
            data-testid="cron-job-toggle"
          >
            {job.paused ? t("tasks.actions.resume") : t("tasks.actions.pause")}
          </button>
          <button
            className="rounded-md border border-destructive/40 px-2.5 py-1 text-xs text-destructive hover:bg-destructive/10"
            onClick={() => setDeleteOpen(true)}
            data-testid="cron-job-delete"
          >
            {t("tasks.actions.delete")}
          </button>
          <ConfirmDialog
            open={deleteOpen}
            onOpenChange={setDeleteOpen}
            title={t("tasks.actions.delete")}
            description={t("tasks.actions.deleteConfirm")}
            confirmLabel={t("tasks.actions.delete")}
            cancelLabel={t("common.cancel")}
            variant="danger"
            onConfirm={() => {
              send({ type: "cron_remove", jobId: job.id });
              showToast({ severity: "success", title: t("tasks.actions.delete") });
            }}
          />
        </div>
      </div>

      {/* Run history (add-cron-automation-parity 3.3): occurrence time, outcome,
          duration and token spend from the existing history entries. The
          most recent run stays inline above; this is the full trail. */}
      {job.history.length > 0 ? (
        <div className="mt-3 border-t border-border pt-2">
          <button
            type="button"
            onClick={() => setHistoryOpen((v) => !v)}
            className="text-xs text-muted-foreground hover:text-foreground"
            data-testid="cron-job-history-toggle"
          >
            {historyOpen ? "▾ " : "▸ "}
            {t("tasks.history.title", { count: job.history.length })}
            {job.maxRuns != null ? ` · ${t("tasks.history.progress", { runs: job.runs ?? 0, cap: job.maxRuns })}` : ""}
          </button>
          {historyOpen ? (
            <ul className="mt-2 space-y-1" data-testid="cron-job-history">
              {[...job.history].reverse().map((h) => {
                const outcome = h.state ?? (h.success === true ? "done" : h.success === false ? "failed" : "missed");
                const tone =
                  outcome === "done"
                    ? "text-emerald-600"
                    : outcome === "failed"
                      ? "text-destructive"
                      : "text-amber-600";
                return (
                  <li
                    key={`${h.time}-${h.duration ?? 0}-${outcome}`}
                    className="flex flex-wrap items-center gap-x-3 text-xs text-muted-foreground"
                    data-testid="cron-history-row"
                  >
                    <span className={`font-medium ${tone}`}>{t(`tasks.history.state.${outcome}`, { defaultValue: outcome })}</span>
                    <span>{formatInJobTz(h.time, job.tz, locale)}</span>
                    {typeof h.duration === "number" ? <span>{(h.duration / 1000).toFixed(1)}s</span> : null}
                    {h.tokens?.total != null ? <span>{h.tokens.total} tok</span> : null}
                    {h.catchUp ? <span className="rounded-sm bg-amber-500/15 px-1 text-amber-700">补跑</span> : null}
                    {h.missed ? <span>{t("tasks.history.missed", { count: h.missed })}</span> : null}
                    {h.error ? <span className="truncate text-destructive">{h.error}</span> : null}
                  </li>
                );
              })}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function TasksPage({ send }: TasksPageProps) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const navigate = useNavigate();
  const jobs = useCronStore((s) => s.jobs);
  const lastError = useCronStore((s) => s.lastError);
  const clearError = useCronStore((s) => s.clearError);
  const presets = useChatStore((s) => s.presets);
  const currentPreset = useChatStore((s) => s.currentPreset);

  const [formOpen, setFormOpen] = useState(false);
  const [pendingSubmit, setPendingSubmit] = useState(0);
  const lastAdded = useCronStore((s) => s.lastAdded);
  const [mode, setMode] = useState<Mode>("recurring");
  const [freq, setFreq] = useState<Freq>("daily");
  const [time, setTime] = useState("09:00");
  const [weekdays, setWeekdays] = useState<number[]>([1]);
  const [cronExpr, setCronExpr] = useState("");
  const [when, setWhen] = useState("");
  // add-cron-automation-parity: the interval builder, the relative one-shot,
  // and the finite-run cap. Defaults keep every existing flow byte-identical:
  // interval empty, once-relative off, maxRuns blank.
  const [intervalNumber, setIntervalNumber] = useState("1");
  const [intervalUnit, setIntervalUnit] = useState<IntervalUnit>("hour");
  const [onceRelative, setOnceRelative] = useState(false);
  const [delayMinutes, setDelayMinutes] = useState("30");
  const [maxRuns, setMaxRuns] = useState("");
  const [prompt, setPrompt] = useState("");
  const [name, setName] = useState("");
  const [agent, setAgent] = useState<string>("");
  const [tz, setTz] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [localError, setLocalError] = useState<string | null>(null);
  // Natural-language schedule input (add-projects-automation-flow): debounced
  // client-side parse with a live preview; apply fills the fields, a miss
  // points at the manual controls and changes nothing.
  const [nlText, setNlText] = useState("");
  const [nlParsed, setNlParsed] = useState<ParsedSchedule | null>(null);
  useEffect(() => {
    const id = setTimeout(() => setNlParsed(parseSchedule(nlText, zhWeekdayName)), 300);
    return () => clearTimeout(id);
  }, [nlText]);

  const applyParsed = (parsed: ParsedSchedule) => {
    if (parsed.freq === "daily") {
      setMode("recurring");
      setFreq("daily");
      setTime(parsed.time || "09:00");
    } else if (parsed.freq === "weekly") {
      setMode("recurring");
      setFreq("weekly");
      setTime(parsed.time || "09:00");
      setWeekdays(parsed.weekdays || []);
    } else if (parsed.freq === "weekdays") {
      setMode("recurring");
      setFreq("weekly");
      setTime(parsed.time || "09:00");
      setWeekdays([1, 2, 3, 4, 5]);
    } else {
      setMode("recurring");
      setFreq("custom");
      setCronExpr(parsed.cron);
    }
  };

  const applyTemplate = (tpl: (typeof TEMPLATES)[number]) => {
    setName(t(`tasks.templates.${tpl.key}.name`));
    setPrompt(t(`tasks.templates.${tpl.key}.prompt`));
    setMode("recurring");
    setFreq(tpl.freq);
    if (tpl.time) setTime(tpl.time);
    if (tpl.weekdays) setWeekdays(tpl.weekdays);
    if (tpl.cron) setCronExpr(tpl.cron);
  };

  const usablePresets = useMemo(() => presets.filter((p) => !p.broken), [presets]);
  const effectiveAgent = agent || currentPreset || usablePresets[0]?.id || "";

  // In-place edit (add-cron-automation-parity 3.3 / spec: edit reschedules in
  // place). Reopen the form prefilled from the job; submitting then goes out as
  // cron_update — the job id, its history and paused state survive. A blank
  // editingId means a create.
  const [editingId, setEditingId] = useState<string | null>(null);
  const startEdit = (job: CronJob) => {
    setLocalError(null);
    setEditingId(job.id);
    setFormOpen(true);
    setName(job.sessionTitle ?? "");
    setPrompt(job.prompt);
    setTz(job.tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
    setAgent(job.preset ?? "");
    setMaxRuns(job.maxRuns != null ? String(job.maxRuns) : "");
    if (job.interval) {
      setMode("recurring");
      setFreq("interval");
      setIntervalNumber(String(job.interval.number));
      setIntervalUnit(job.interval.unit as IntervalUnit);
    } else if (job.type === "recurring" && job.cron) {
      // A cron form reopens on the custom branch — the exact expression is the
      // one thing the presets cannot reconstruct.
      setMode("recurring");
      setFreq("custom");
      setCronExpr(job.cron);
    } else {
      setMode("once");
      setOnceRelative(false);
      setWhen(job.when ? toLocalInput(job.when) : "");
    }
  };
  const cancelEdit = () => {
    setEditingId(null);
    setFormOpen(false);
  };

  const openSession = (sessionId: string) => {
    send({ type: "switch_session", id: sessionId });
    navigate(`/chat/${sessionId}`);
  };

  // The form closes only on ACCEPTED submissions (cron_added broadcast): a
  // rejected one (invalid cron) must stay open so its error is visible.
  useEffect(() => {
    if (pendingSubmit && lastAdded && lastAdded.at >= pendingSubmit) {
      setFormOpen(false);
      setPendingSubmit(0);
    }
  }, [lastAdded, pendingSubmit]);

  const submit = () => {
    setLocalError(null);
    clearError();
    if (!prompt.trim()) {
      setLocalError(t("tasks.form.errors.prompt"));
      return;
    }
    let expr: string | undefined;
    let iso: string | undefined;
    let interval: { number: number; unit: IntervalUnit } | undefined;
    let delay: number | undefined;
    const cap = maxRuns.trim() ? Number.parseInt(maxRuns.trim(), 10) : undefined;
    if (mode === "recurring") {
      if (cap !== undefined && (!Number.isInteger(cap) || cap < 1)) {
        setLocalError(t("tasks.form.errors.maxRuns"));
        return;
      }
      if (freq === "interval") {
        // Interval builder (add-cron-automation-parity): a cron-impossible step
        // like "every 40 days" is expressible only here; the rule is the truth.
        const n = Number.parseInt(intervalNumber, 10);
        if (!Number.isInteger(n) || n < 1 || n > 200) {
          setLocalError(t("tasks.form.errors.intervalNumber"));
          return;
        }
        interval = { number: n, unit: intervalUnit };
      } else {
        const [h, m] = time.split(":");
        if (freq === "daily") expr = `${m || "0"} ${h || "0"} * * *`;
        else if (freq === "weekly") {
          const days = [...weekdays].sort().join(",");
          if (!weekdays.length) {
            setLocalError(t("tasks.form.errors.weekday"));
            return;
          }
          expr = `${m || "0"} ${h || "0"} * * ${days}`;
        } else {
          if (!cronExpr.trim()) {
            setLocalError(t("tasks.form.errors.cron"));
            return;
          }
          expr = cronExpr.trim();
        }
      }
    } else if (onceRelative) {
      // Relative one-shot: submit the DELAY, never a wall time — the server
      // anchors it to its own clock (a past client-computed time would roll a
      // year forward).
      const d = Number.parseInt(delayMinutes, 10);
      if (!Number.isInteger(d) || d < 1) {
        setLocalError(t("tasks.form.errors.delayMinutes"));
        return;
      }
      delay = d;
    } else {
      if (!when) {
        setLocalError(t("tasks.form.errors.when"));
        return;
      }
      iso = new Date(when).toISOString();
    }
    // Editing routes to cron_update (id/history/paused preserved); a create
    // goes out as cron_add with the same schedule fields.
    if (editingId) {
      send({
        type: "cron_update",
        jobId: editingId,
        ...(interval ? { interval } : {}),
        ...(expr ? { cron: expr } : {}),
        ...(iso ? { when: iso } : {}),
        ...(delay !== undefined ? { delayMinutes: delay } : {}),
        ...(cap !== undefined ? { maxRuns: cap } : {}),
        prompt: prompt.trim(),
        tz: tz.trim() || null,
        ...(name.trim() ? { sessionTitle: name.trim() } : {}),
      });
      setPendingSubmit(Date.now());
      setEditingId(null);
      return;
    }
    send({
      type: "cron_add",
      cron: expr,
      when: iso,
      prompt: prompt.trim(),
      preset: effectiveAgent || null,
      tz: tz.trim() || null,
      sessionTitle: name.trim() || null,
      ...(interval ? { interval } : {}),
      ...(delay !== undefined ? { delayMinutes: delay } : {}),
      ...(cap !== undefined ? { maxRuns: cap } : {}),
      ...(projectFilter !== "all" && projectFilter !== "default" ? { projectId: projectFilter } : {}),
    });
    setPendingSubmit(Date.now());
    setPrompt("");
    setName("");
    setMaxRuns("");
  };

  const errorText = localError ?? (lastError?.action === "cron_add" ? lastError.message : null);

  // Project filter (add-web-project-container 3.3) — display-only.
  const projects = useProjectsStore((s) => s.projects);
  useEffect(() => {
    if (!IS_DESKTOP) void useProjectsStore.getState().load();
  }, []);
  const [projectFilter, setProjectFilter] = useState<string>("all");
  const visibleJobs = useMemo(() => {
    if (projectFilter === "all") return jobs;
    if (projectFilter === "default") return jobs.filter((j) => !j.projectId);
    return jobs.filter((j) => j.projectId === projectFilter);
  }, [jobs, projectFilter]);

  return (
    <div className="flex h-full flex-col bg-background" data-testid="cron-page">
      <div className="border-b border-border px-6 py-4">
        <div className="flex items-center justify-between">
          <h1 className="text-lg font-semibold">{t("tasks.title")}</h1>
          <div className="flex items-center gap-2">
            {/* Project filter (add-web-project-container 3.3): "all" is the
                default and filters nothing — the list reads exactly as before
                this change. Display-only; every action still addresses jobs by
                id. Desktop has no project concept, so the control is web-only. */}
            {!IS_DESKTOP ? (
              <select
                value={projectFilter}
                onChange={(e) => setProjectFilter(e.target.value)}
                className="rounded-md border border-input bg-background px-2 py-1.5 text-xs"
                data-testid="cron-project-filter"
                aria-label={t("tasks.projectFilter")}
              >
                <option value="all">{t("tasks.projectAll")}</option>
                <option value="default">{t("sidebar.defaultProject")}</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            ) : null}
            <button
              className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
              onClick={() => {
                // Opening the form fresh cancels any in-flight edit.
                if (formOpen) setEditingId(null);
                setFormOpen((v) => !v);
              }}
              data-testid="cron-new-toggle"
            >
              {formOpen ? t("tasks.form.close") : t("tasks.form.title")}
            </button>
          </div>
        </div>
      </div>

      <div className="flex-1 space-y-4 overflow-auto p-6">
        {formOpen && (
          <div className="rounded-md border border-border bg-card p-4" data-testid="cron-form">
            {/* Templates: one-click prefills (spec: scheduled-tasks-ui). */}
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <span className="text-xs text-muted-foreground">{t("tasks.templates.label")}</span>
              {TEMPLATES.map((tpl) => (
                <button
                  key={tpl.key}
                  type="button"
                  onClick={() => applyTemplate(tpl)}
                  data-testid={`cron-template-${tpl.key}`}
                  className="rounded-full border border-border px-2.5 py-0.5 text-xs text-muted-foreground hover:border-primary/40 hover:text-foreground"
                >
                  {t(`tasks.templates.${tpl.key}.name`)}
                </button>
              ))}
            </div>
            {/* Natural-language schedule: parse → preview → apply; a miss
                leaves every field untouched (spec: scheduled-tasks-ui). */}
            <div className="mb-3">
              <input
                type="text"
                value={nlText}
                onChange={(e) => setNlText(e.target.value)}
                placeholder={t("tasks.nl.placeholder")}
                aria-label={t("tasks.nl.label")}
                data-testid="cron-nl-input"
                className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm"
              />
              {nlText.trim() && (nlParsed ? (
                <div className="mt-1.5 flex flex-wrap items-center gap-2" data-testid="cron-nl-preview">
                  <span className="text-xs text-muted-foreground">
                    {t("tasks.nl.preview", { summary: nlParsed.summary, cron: nlParsed.cron })}
                  </span>
                  <button
                    type="button"
                    onClick={() => applyParsed(nlParsed)}
                    data-testid="cron-nl-apply"
                    className="rounded-md border border-primary/40 px-2 py-0.5 text-xs text-primary hover:bg-primary/10"
                  >
                    {t("tasks.nl.apply")}
                  </button>
                </div>
              ) : (
                <p className="mt-1.5 text-xs text-muted-foreground" data-testid="cron-nl-fallback">
                  {t("tasks.nl.fallback")}
                </p>
              ))}
            </div>
            <div className="flex gap-2">
              {(["recurring", "once"] as Mode[]).map((m) => (
                <button
                  key={m}
                  className={`rounded-md px-3 py-1 text-sm ${mode === m ? "bg-primary/15 text-primary" : "text-muted-foreground hover:bg-muted"}`}
                  onClick={() => setMode(m)}
                  data-testid={`cron-mode-${m}`}
                >
                  {t(`tasks.form.mode.${m === "recurring" ? "recurring" : "once"}`)}
                </button>
              ))}
            </div>

            {mode === "recurring" ? (
              <div className="mt-3 space-y-3">
                <div className="flex flex-wrap items-center gap-2">
                  {(["daily", "weekly", "custom", "interval"] as Freq[]).map((f) => (
                    <button
                      key={f}
                      className={`rounded-md px-3 py-1 text-sm ${freq === f ? "bg-primary/15 text-primary" : "text-muted-foreground hover:bg-muted"}`}
                      onClick={() => setFreq(f)}
                      data-testid={`cron-freq-${f}`}
                    >
                      {t(`tasks.form.freq.${f}`)}
                    </button>
                  ))}
                </div>
                {freq === "weekly" && (
                  <div className="flex gap-1">
                    {[0, 1, 2, 3, 4, 5, 6].map((d) => (
                      <button
                        key={d}
                        className={`rounded-md border px-2 py-1 text-xs ${
                          weekdays.includes(d) ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground"
                        }`}
                        onClick={() =>
                          setWeekdays((ws) => (ws.includes(d) ? ws.filter((x) => x !== d) : [...ws, d]))
                        }
                      >
                        {weekdayLabel(d, locale)}
                      </button>
                    ))}
                  </div>
                )}
                {freq === "interval" ? (
                  <div className="flex flex-wrap items-center gap-2" data-testid="cron-interval-builder">
                    <span className="text-xs text-muted-foreground">{t("tasks.form.every")}</span>
                    <input
                      type="number"
                      min={1}
                      max={200}
                      className="w-16 rounded-md border border-border bg-background px-2 py-1.5 text-sm"
                      value={intervalNumber}
                      onChange={(e) => setIntervalNumber(e.target.value)}
                      data-testid="cron-interval-number"
                    />
                    <select
                      className="rounded-md border border-border bg-background px-2 py-1.5 text-sm"
                      value={intervalUnit}
                      onChange={(e) => setIntervalUnit(e.target.value as IntervalUnit)}
                      data-testid="cron-interval-unit"
                    >
                      {(["minute", "hour", "day", "week"] as IntervalUnit[]).map((u) => (
                        <option key={u} value={u}>
                          {t(`tasks.form.unit.${u}`)}
                        </option>
                      ))}
                    </select>
                  </div>
                ) : freq === "custom" ? (
                  <input
                    className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                    placeholder={t("tasks.form.cronPlaceholder")}
                    value={cronExpr}
                    onChange={(e) => setCronExpr(e.target.value)}
                    data-testid="cron-expr"
                  />
                ) : (
                  <input
                    type="time"
                    className="rounded-md border border-border bg-background px-3 py-2 text-sm"
                    value={time}
                    onChange={(e) => setTime(e.target.value)}
                    data-testid="cron-time"
                  />
                )}
                {/* Finite-run cap (add-cron-automation-parity): blank = unbounded. */}
                <div className="flex items-center gap-2">
                  <label htmlFor="cron-max-runs" className="text-xs text-muted-foreground">
                    {t("tasks.form.maxRuns")}
                  </label>
                  <input
                    id="cron-max-runs"
                    type="number"
                    min={1}
                    placeholder={t("tasks.form.maxRunsPlaceholder")}
                    className="w-24 rounded-md border border-border bg-background px-2 py-1 text-sm"
                    value={maxRuns}
                    onChange={(e) => setMaxRuns(e.target.value)}
                    data-testid="cron-max-runs"
                  />
                </div>
              </div>
            ) : (
              <div className="mt-3 space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  {[
                    { key: false, label: t("tasks.form.onceAbsolute") },
                    { key: true, label: t("tasks.form.onceRelative") },
                  ].map((opt) => (
                    <button
                      key={String(opt.key)}
                      type="button"
                      className={`rounded-md px-3 py-1 text-sm ${onceRelative === opt.key ? "bg-primary/15 text-primary" : "text-muted-foreground hover:bg-muted"}`}
                      onClick={() => setOnceRelative(opt.key)}
                      data-testid={`cron-once-${opt.key ? "relative" : "absolute"}`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
                {onceRelative ? (
                  <div className="flex flex-wrap items-center gap-2">
                    {/* Submits the DELAY; the server anchors it. Never a wall time. */}
                    <input
                      type="number"
                      min={1}
                      className="w-24 rounded-md border border-border bg-background px-2 py-1.5 text-sm"
                      value={delayMinutes}
                      onChange={(e) => setDelayMinutes(e.target.value)}
                      data-testid="cron-delay-minutes"
                    />
                    <span className="text-xs text-muted-foreground">{t("tasks.form.minutesAfterNow")}</span>
                  </div>
                ) : (
                  <input
                    type="datetime-local"
                    className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                    value={when}
                    onChange={(e) => setWhen(e.target.value)}
                    data-testid="cron-when"
                  />
                )}
              </div>
            )}

            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <input
                className="rounded-md border border-border bg-background px-3 py-2 text-sm"
                placeholder={t("tasks.form.namePlaceholder")}
                value={name}
                onChange={(e) => setName(e.target.value)}
                data-testid="cron-name"
              />
              <select
                className="rounded-md border border-border bg-background px-3 py-2 text-sm"
                value={effectiveAgent}
                onChange={(e) => setAgent(e.target.value)}
                data-testid="cron-agent"
              >
                {usablePresets.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
            <textarea
              className="mt-3 w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
              rows={3}
              placeholder={t("tasks.form.promptPlaceholder")}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              data-testid="cron-prompt"
            />
            <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
              <label htmlFor="cron-tz">{t("tasks.form.tz")}</label>
              <input
                id="cron-tz"
                className="rounded-md border border-border bg-background px-2 py-1 text-xs"
                value={tz}
                onChange={(e) => setTz(e.target.value)}
                data-testid="cron-tz"
              />
            </div>

            {errorText && (
              <div className="mt-3 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive" data-testid="cron-form-error">
                {errorText}
              </div>
            )}
            <button
              className="mt-3 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
              onClick={submit}
              data-testid="cron-submit"
            >
              {editingId ? t("tasks.actions.edit") : t("tasks.form.submit")}
            </button>
            {editingId ? (
              <button
                type="button"
                className="mt-3 ml-2 rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted"
                onClick={cancelEdit}
                data-testid="cron-edit-cancel"
              >
                {t("tasks.form.close")}
              </button>
            ) : null}
          </div>
        )}

        {jobs.length === 0 && !formOpen ? (
          <div className="flex h-40 flex-col items-center justify-center gap-3 text-sm text-muted-foreground" data-testid="cron-empty">
            {t("tasks.empty")}
            <div className="flex flex-wrap items-center justify-center gap-2">
              <span className="text-xs">{t("tasks.templates.label")}</span>
              {TEMPLATES.map((tpl) => (
                <button
                  key={tpl.key}
                  type="button"
                  onClick={() => {
                    applyTemplate(tpl);
                    setFormOpen(true);
                  }}
                  data-testid={`cron-empty-template-${tpl.key}`}
                  className="rounded-full border border-border px-2.5 py-0.5 text-xs hover:border-primary/40 hover:text-foreground"
                >
                  {t(`tasks.templates.${tpl.key}.name`)}
                </button>
              ))}
            </div>
          </div>
        ) : (
          visibleJobs.map((job) => (
            <TaskCard key={job.id} job={job} send={send} onOpenSession={openSession} onEdit={startEdit} />
          ))
        )}
      </div>
    </div>
  );
}
