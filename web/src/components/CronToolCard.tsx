// CronToolCard.tsx — job card for agent-created scheduled tasks
// (spec: agent-scheduling-tools). A cron_create tool invocation renders as a
// card with live job state and pause/delete affordances, NOT raw tool output.
//
// The MCP tool's result is a text blob in our own stable format; the job id is
// parsed from its "- id: <id>" line and the LIVE record comes from the cron
// store (job status changes arrive as cron_status broadcasts). If the store
// has no record yet, the card still shows the invocation's own facts.

import { CalendarClock, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useCronStore, type Block, type CronJob } from "@platform/core";
import { describeJobSchedule } from "@/lib/cron-text";
import { wsSend } from "@/hooks/useWebSocket";

const JOB_ID_FROM_RESULT = /- id:\s*(\S+)/;

function jobFromArgs(args: unknown): Partial<CronJob> {
  const a = (args ?? {}) as { cron?: string; when?: string; prompt?: string; tz?: string | null };
  return {
    type: a.cron ? "recurring" : "once",
    cron: a.cron ?? null,
    when: a.when ?? null,
    prompt: a.prompt ?? "",
    tz: a.tz ?? null,
  };
}

export function CronToolCard({ block }: { block: Extract<Block, { kind: "tool" }> }) {
  const { t, i18n } = useTranslation();
  const jobs = useCronStore((s) => s.jobs);
  const { args, state, result } = block;

  const resultText = typeof result === "string" ? result : "";
  const jobId = JOB_ID_FROM_RESULT.exec(resultText)?.[1] ?? null;
  const job = jobId ? jobs.find((j) => j.id === jobId) ?? null : null;
  const shape = job ?? jobFromArgs(args);

  return (
    <div
      className="rounded-md border border-border border-l-2 border-l-primary bg-muted/40 px-3 py-2"
      data-testid="cron-tool-card"
      data-tool-name={block.name}
      data-tool-state={state}
      data-job-id={jobId ?? undefined}
    >
      <div className="flex items-center gap-2 text-xs">
        {state === "running" ? (
          <Loader2 className="h-3 w-3 shrink-0 animate-spin text-primary" aria-hidden="true" />
        ) : (
          <CalendarClock className="h-3 w-3 shrink-0 text-primary" aria-hidden="true" />
        )}
        <span className="font-medium text-foreground">{t("tasks.tool.title")}</span>
        <span className="min-w-0 truncate text-muted-foreground" data-testid="cron-tool-card-schedule">
          {shape.type ? describeJobSchedule(t, shape as CronJob, i18n.language) : ""}
        </span>
      </div>

      {state === "done" && (
        <>
          <p className="mt-1.5 line-clamp-2 text-xs text-foreground/80">{shape.prompt}</p>
          {job ? (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[11px] text-primary">
                {job.paused ? t("tasks.status.paused") : t(`tasks.status.${job.status}`)}
              </span>
              {job.preset ? <span className="text-[11px] text-muted-foreground">{job.preset}</span> : null}
              <span className="ml-auto flex gap-1.5">
                <button
                  className="rounded-md border border-border px-2 py-0.5 text-[11px] hover:bg-muted"
                  onClick={() =>
                    wsSend(job.paused ? { type: "cron_resume", jobId: job.id } : { type: "cron_pause", jobId: job.id })
                  }
                  data-testid="cron-tool-card-toggle"
                >
                  {job.paused ? t("tasks.actions.resume") : t("tasks.actions.pause")}
                </button>
                <button
                  className="rounded-md border border-destructive/40 px-2 py-0.5 text-[11px] text-destructive hover:bg-destructive/10"
                  onClick={() => {
                    if (window.confirm(t("tasks.actions.deleteConfirm"))) {
                      wsSend({ type: "cron_remove", jobId: job.id });
                    }
                  }}
                  data-testid="cron-tool-card-delete"
                >
                  {t("tasks.actions.delete")}
                </button>
              </span>
            </div>
          ) : jobId ? (
            <p className="mt-1.5 text-[11px] italic text-muted-foreground">{t("tasks.tool.notFound")}</p>
          ) : (
            <p className="mt-1.5 text-[11px] italic text-muted-foreground">{t("tasks.tool.created")}</p>
          )}
        </>
      )}
    </div>
  );
}
