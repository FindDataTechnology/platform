import { ChevronRight, Eye, ListChecks, Loader2, Wrench } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { useChatStore, type Block } from "@platform/core";
import { usePreviewStore } from "@/hooks/usePreviewStore";
import { CronToolCard } from "@/components/CronToolCard";
import { TaskCard } from "@/components/TaskCard";
import { QuestionCard } from "@/components/QuestionCard";
import { baseName, fileUrl, findFilePath, resolveRef } from "@/lib/file-preview";
import { memo, useId } from "react";

interface Props {
  block: Extract<Block, { kind: "tool" }>;
  onToggle: () => void;
}

function stringify(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

// A `todo_write` call carries the whole plan as its arguments; the counts for
// the summary line come from THAT snapshot (not the live store — a historical
// block must report what it actually wrote). Null when the payload has no list,
// in which case the line falls back to the bare tool name.
function planCounts(args: unknown): { done: number; total: number } | null {
  const list = (args as { todos?: unknown } | null)?.todos;
  if (!Array.isArray(list)) return null;
  return {
    total: list.length,
    done: list.filter((item) => (item as { status?: unknown })?.status === "completed").length,
  };
}

function ToolBlockBase({ block, onToggle }: Props) {
  const { t } = useTranslation();
  const { name, args, state, result, partial, open } = block;
  const bodyId = useId();
  const openPreview = usePreviewStore((s) => s.open);
  // Subscribed (not read by getState) so a later workspace switch re-resolves
  // the file reference against the root the server would now serve from.
  const workspace = useChatStore((s) => s.currentWorkspace);

  // Agent-created scheduled tasks render as job cards, not raw tool output
  // (spec: agent-scheduling-tools). Only the creation call is card-worthy;
  // list/pause/delete keep the generic block.
  if (name.endsWith("__cron_create")) {
    return <CronToolCard block={block} />;
  }

  // Delegated tasks render as live task cards (spec: agent-delegation-tools);
  // progress/result keep the generic block.
  if (name.endsWith("__delegate_task")) {
    return <TaskCard block={block} />;
  }

  // A user question renders as the interactive card while pending and a
  // static summary once resolved (spec: web-chat-ui, add-user-questions).
  if (name === "ask_user_question") {
    return <QuestionCard block={block} />;
  }

  // Any file the call named — written, or just read — is offerable. A path that
  // does not resolve to a served root simply yields no action.
  const fileRef = state === "done" ? resolveRef(findFilePath(args, result) ?? "", workspace) : null;
  const accent =
    state === "running"
      ? "border-l-primary"
      : state === "error"
        ? "border-l-destructive"
        : "border-l-success";
  const statusKey =
    state === "running" ? "turn.statusRunning" : state === "error" ? "turn.statusError" : "turn.statusDone";
  // The plan's own tool owns a line of its own: its content is rendered as the
  // plan surface, so a generic block repeating the whole list as raw JSON would
  // be noise (the arguments stay reachable through the expand path).
  const isPlanUpdate = name === "todo_write";
  const counts = isPlanUpdate ? planCounts(args) : null;

  return (
    <div
      className={cn("overflow-hidden rounded-md border border-border border-l-2 bg-muted/40", accent)}
      data-testid="tool-block"
      data-tool-name={name}
      data-tool-state={state}
      data-open={open ? "true" : "false"}
    >
      <button
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={bodyId}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-xs hover:bg-muted"
      >
        <ChevronRight className={cn("h-3 w-3 transition-transform", open && "rotate-90")} aria-hidden="true" />
        {isPlanUpdate ? (
          <>
            <ListChecks className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="min-w-0 truncate font-medium text-foreground">
              {counts ? t("chat.plan.updated", { done: counts.done, total: counts.total }) : name}
            </span>
          </>
        ) : (
          <>
            <Wrench className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="min-w-0 truncate font-mono font-semibold text-foreground">{name}</span>
          </>
        )}
        <span
          className={cn(
            "ml-auto flex items-center gap-1 text-[11px] italic",
            state === "running" && "text-primary",
            state === "error" && "text-destructive",
            state === "done" && "text-success",
          )}
        >
          {state === "running" && <Loader2 className="h-3 w-3 animate-spin" />}
          {t(statusKey)}
        </span>
      </button>
      {open && (
        <div id={bodyId} className="max-h-72 space-y-2 overflow-y-auto border-t border-border px-3 py-2 text-[11px]">
          {fileRef && (
            <button
              type="button"
              data-testid="tool-preview"
              onClick={() =>
                openPreview({ name: baseName(fileRef.rel), url: fileUrl(fileRef.root, fileRef.rel), ref: fileRef })
              }
              className="inline-flex items-center gap-1 rounded-sm border border-border bg-background px-2 py-0.5 font-medium text-foreground hover:bg-muted"
            >
              <Eye className="h-3 w-3" aria-hidden="true" />
              {t("preview.openInDrawer")}
            </button>
          )}
          {args !== undefined && args !== null && (
            <Section label={t("turn.input")} body={stringify(args)} />
          )}
          {state === "running" && partial !== undefined && (
            <Section label={t("turn.partial")} body={stringify(partial)} />
          )}
          {state !== "running" && result !== undefined && (
            <Section
              label={state === "error" ? t("turn.outputError") : t("turn.output")}
              body={stringify(result)}
              error={state === "error"}
            />
          )}
        </div>
      )}
    </div>
  );
}

function Section({ label, body, error }: { label: string; body: string; error?: boolean }) {
  return (
    <div>
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <pre
        className={cn(
          "whitespace-pre-wrap break-words rounded-sm bg-background px-2 py-1 font-mono",
          error && "text-destructive",
        )}
      >
        {body}
      </pre>
    </div>
  );
}

// Memoized: the store mutates turn objects in place and clones only the
// turns array, so a streaming delta re-renders just the tail turn's
// component instead of reconciling the whole transcript.
export const ToolBlock = memo(ToolBlockBase);
