// TasksPage.tsx — scheduled-task management surface (spec: scheduled-tasks-ui).
//
// List + creation form + per-job actions, all fed live by the cron store
// (cron_* events; commands go out over the same WS as chat). The creation
// form's schedule presets (daily / weekly / custom cron) build cron
// expressions client-side; the server re-validates and answers cron_error on
// a bad expression.

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { useChatStore, useCronStore, type ClientMessage, type CronJob } from "@platform/core";
import { describeJobSchedule, formatInJobTz, weekdayLabel } from "@/lib/cron-text";

export interface TasksPageProps {
  send: (msg: ClientMessage) => void;
}

type Freq = "daily" | "weekly" | "custom";
type Mode = "recurring" | "once";

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
}: {
  job: CronJob;
  send: TasksPageProps["send"];
  onOpenSession: (id: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const last = job.history.at(-1);
  const badge = badgeKey(job);
  const rerunnable = job.state === "failed" || job.state === "interrupted";

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
            {(job.target?.ref ?? job.preset) ? <span>{t("tasks.fields.agent")}: {job.target?.ref ?? job.preset}</span> : null}
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
            onClick={() =>
              send(job.paused ? { type: "cron_resume", jobId: job.id } : { type: "cron_pause", jobId: job.id })
            }
            data-testid="cron-job-toggle"
          >
            {job.paused ? t("tasks.actions.resume") : t("tasks.actions.pause")}
          </button>
          <button
            className="rounded-md border border-destructive/40 px-2.5 py-1 text-xs text-destructive hover:bg-destructive/10"
            onClick={() => {
              if (window.confirm(t("tasks.actions.deleteConfirm"))) {
                send({ type: "cron_remove", jobId: job.id });
              }
            }}
            data-testid="cron-job-delete"
          >
            {t("tasks.actions.delete")}
          </button>
        </div>
      </div>
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
  const [prompt, setPrompt] = useState("");
  const [name, setName] = useState("");
  const [agent, setAgent] = useState<string>("");
  const [tz, setTz] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [localError, setLocalError] = useState<string | null>(null);

  const usablePresets = useMemo(() => presets.filter((p) => !p.broken), [presets]);
  const effectiveAgent = agent || currentPreset || usablePresets[0]?.id || "";

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
    if (mode === "recurring") {
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
    } else {
      if (!when) {
        setLocalError(t("tasks.form.errors.when"));
        return;
      }
      iso = new Date(when).toISOString();
    }
    send({
      type: "cron_add",
      cron: expr,
      when: iso,
      prompt: prompt.trim(),
      preset: effectiveAgent || null,
      tz: tz.trim() || null,
      sessionTitle: name.trim() || null,
    });
    setPendingSubmit(Date.now());
    setPrompt("");
    setName("");
  };

  const errorText = localError ?? (lastError?.action === "cron_add" ? lastError.message : null);

  return (
    <div className="flex h-full flex-col bg-background" data-testid="cron-page">
      <div className="border-b border-border px-6 py-4">
        <div className="flex items-center justify-between">
          <h1 className="text-lg font-semibold">{t("tasks.title")}</h1>
          <button
            className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            onClick={() => setFormOpen((v) => !v)}
            data-testid="cron-new-toggle"
          >
            {formOpen ? t("tasks.form.close") : t("tasks.form.title")}
          </button>
        </div>
      </div>

      <div className="flex-1 space-y-4 overflow-auto p-6">
        {formOpen && (
          <div className="rounded-md border border-border bg-card p-4" data-testid="cron-form">
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
                  {(["daily", "weekly", "custom"] as Freq[]).map((f) => (
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
                {freq === "custom" ? (
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
              </div>
            ) : (
              <input
                type="datetime-local"
                className="mt-3 w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                value={when}
                onChange={(e) => setWhen(e.target.value)}
                data-testid="cron-when"
              />
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
              {t("tasks.form.submit")}
            </button>
          </div>
        )}

        {jobs.length === 0 && !formOpen ? (
          <div className="flex h-40 items-center justify-center text-sm text-muted-foreground" data-testid="cron-empty">
            {t("tasks.empty")}
          </div>
        ) : (
          jobs.map((job) => <TaskCard key={job.id} job={job} send={send} onOpenSession={openSession} />)
        )}
      </div>
    </div>
  );
}
