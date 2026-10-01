// TaskCard.tsx — delegation task card (spec: agent-delegation-tools). A
// delegate_task tool invocation renders as a card with live task state — NOT
// raw tool output — the CronToolCard pattern: the task id is parsed from the
// tool result's "- id:" line and the LIVE record comes from the cron store
// (task lifecycle changes arrive as cron_status broadcasts; manual-trigger
// tasks ride the same surface). If the store has no record yet, the card
// still shows the invocation's own facts (target persona from the args).

import { Loader2, Users } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { useCronStore, type Block, type CronJob } from "@platform/core";
import { wsSend } from "@/hooks/useWebSocket";

const TASK_ID_FROM_RESULT = /- id:\s*(\S+)/;

function tokensText(tokens?: CronJob["history"][number]["tokens"]): string | null {
  if (!tokens) return null;
  const t = typeof tokens.total === "number" ? tokens.total : undefined;
  if (t == null) return null;
  return `${t}`;
}

export function TaskCard({ block }: { block: Extract<Block, { kind: "tool" }> }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const jobs = useCronStore((s) => s.jobs);
  const { args, state, result } = block;

  const resultText = typeof result === "string" ? result : "";
  const taskId = TASK_ID_FROM_RESULT.exec(resultText)?.[1] ?? null;
  const task = taskId ? jobs.find((j) => j.id === taskId) ?? null : null;
  const persona = task?.target?.ref ?? ((args as { persona?: string } | undefined)?.persona ?? null);
  const prompt = task?.prompt ?? ((args as { prompt?: string } | undefined)?.prompt ?? "");
  const badge = task
    ? task.state === "queued" || task.state === "running" || task.state === "failed" || task.state === "interrupted"
      ? task.state
      : task.state === "done"
        ? "done"
        : task.status
    : "queued";
  const tokens = tokensText(task?.history?.at(-1)?.tokens);

  return (
    <div
      className="rounded-md border border-border border-l-2 border-l-primary bg-muted/40 px-3 py-2"
      data-testid="task-card"
      data-tool-name={block.name}
      data-tool-state={state}
      data-task-id={taskId ?? undefined}
      data-task-state={task?.state ?? ""}
    >
      <div className="flex items-center gap-2 text-xs">
        {state === "running" || task?.state === "running" ? (
          <Loader2 className="h-3 w-3 shrink-0 animate-spin text-primary" aria-hidden="true" />
        ) : (
          <Users className="h-3 w-3 shrink-0 text-primary" aria-hidden="true" />
        )}
        <span className="font-medium text-foreground">{t("tasks.card.title")}</span>
        {persona ? (
          <span className="min-w-0 truncate text-muted-foreground" data-testid="task-card-persona">
            {persona}
          </span>
        ) : null}
        <span className="ml-auto shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-[11px] text-primary" data-testid="task-card-state">
          {t(`tasks.status.${badge}`)}
        </span>
      </div>

      {state === "done" && (
        <>
          <p className="mt-1.5 line-clamp-2 text-xs text-foreground/80" data-testid="task-card-prompt">
            {prompt}
          </p>
          {task?.error && state === "done" ? (
            <p className="mt-1 text-[11px] text-destructive" data-testid="task-card-error">
              {task.error}
            </p>
          ) : null}
          <div className="mt-1.5 flex items-center gap-3 text-[11px] text-muted-foreground">
            {task?.sessionId ? (
              <button
                className="rounded-md border border-border px-1.5 py-0.5 hover:bg-muted"
                onClick={() => {
                  wsSend({ type: "switch_session", id: task.sessionId! });
                  navigate(`/chat/${task.sessionId}`);
                }}
                data-testid="task-card-open"
              >
                {t("tasks.actions.output")}
              </button>
            ) : null}
            {tokens ? <span data-testid="task-card-tokens">{t("tasks.card.tokens", { count: tokens })}</span> : null}
          </div>
        </>
      )}
    </div>
  );
}
