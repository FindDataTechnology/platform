import { ChevronRight, Loader2, Sparkles, TriangleAlert } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import {
  groupHasError,
  isGroupOpen,
  useChatStore,
  type ActivityGroup as ActivityGroupModel,
  type AssistantTurn,
  type Block,
} from "@platform/core";
import type { ReactNode } from "react";
import { memo, useId } from "react";

interface Props {
  turn: AssistantTurn;
  group: ActivityGroupModel;
  // Renders one inner block by its ABSOLUTE block index — the per-block
  // toggle path (`toggleBlock`) stays indexed over the turn's flat list.
  renderBlock: (block: Block, index: number) => ReactNode;
}

// The header's plain-language line: never a tool name. Live streaming shows
// the step counter; a finished group summarizes duration + step count; a
// failure names the outcome, not the tool. Steps count executions
// (tool/skill/command) — thinking is reported as duration, not a step.
function headerInfo(turn: AssistantTurn, group: ActivityGroupModel) {
  const executions = group.blocks.filter((b) => b.kind !== "thinking").length;
  const runningIndex = group.blocks.findIndex((b) => b.kind === "tool" && b.state === "running");
  if (turn.streaming) {
    if (executions === 0) return { live: true, key: "turn.activityThinking" } as const;
    const step = runningIndex >= 0 ? group.blocks.slice(0, runningIndex).filter((b) => b.kind !== "thinking").length + 1 : executions + 1;
    return { live: true, key: "turn.activityRunning", step } as const;
  }
  const seconds =
    turn.activityStartedAt && turn.activityEndedAt
      ? Math.max(1, Math.round((turn.activityEndedAt - turn.activityStartedAt) / 1000))
      : null;
  if (groupHasError(group)) {
    return { live: false, key: "turn.activityErrored", count: executions } as const;
  }
  if (seconds && executions > 0) {
    return { live: false, key: "turn.activityDoneTimed", seconds, count: executions } as const;
  }
  if (seconds) return { live: false, key: "turn.activityThought", seconds } as const;
  return { live: false, key: "turn.activityDone", count: executions } as const;
}

function ActivityGroupBase({ turn, group, renderBlock }: Props) {
  const { t } = useTranslation();
  const bodyId = useId();
  const toggleGroup = useChatStore((s) => s.toggleGroup);
  const open = isGroupOpen(turn, group);
  const errored = groupHasError(group);
  const info = headerInfo(turn, group);
  const params =
    "step" in info
      ? { step: info.step }
      : "count" in info
        ? { count: info.count }
        : "seconds" in info
          ? { seconds: info.seconds }
          : {};

  return (
    <div
      className={cn(
        "overflow-hidden rounded-md border bg-muted/40",
        errored ? "border-destructive/40" : "border-border",
      )}
      data-testid="activity-group"
      data-errored={errored ? "true" : "false"}
      data-open={open ? "true" : "false"}
    >
      <button
        onClick={() => toggleGroup(turn.id, group.startIndex)}
        aria-expanded={open}
        aria-controls={bodyId}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-xs hover:bg-muted"
      >
        <ChevronRight className={cn("h-3 w-3 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} aria-hidden="true" />
        {info.live ? (
          <Loader2 className="h-3 w-3 shrink-0 animate-spin text-primary" aria-hidden="true" />
        ) : errored ? (
          <TriangleAlert className="h-3 w-3 shrink-0 text-destructive" aria-hidden="true" />
        ) : (
          <Sparkles className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden="true" />
        )}
        <span
          className={cn(
            "min-w-0 truncate font-medium",
            info.live && "text-primary",
            errored && "text-destructive",
            !info.live && !errored && "text-muted-foreground",
          )}
        >
          {t(info.key, params)}
        </span>
      </button>
      {open && (
        <div id={bodyId} className="flex flex-col gap-2 border-t border-border px-3 py-2">
          {group.blocks.map((b, i) => renderBlock(b, group.startIndex + i))}
        </div>
      )}
    </div>
  );
}

// Memoized alongside AssistantTurn: the store mutates the tail turn in place
// and clones the turns array, so a streamed delta re-renders only the
// streaming turn's subtree — the group re-derives nothing for earlier turns.
export const ActivityGroup = memo(ActivityGroupBase);
