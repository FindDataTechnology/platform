// Plan surfaces (openspec: add-plan-progress-panel) — one store slice, three
// presentations:
//   PlanPanel  ≥ lg: the right-hand progress column beside the chat column.
//   PlanDock   < lg: a collapsed line inside the composer card, above the
//              textarea; expanding lists the items in place. It belongs to the
//              pinned composer stack, so growing it consumes message-log space
//              rather than pushing the composer off-screen.
//   TodoList   the shared item list both wrappers render, so status
//              iconography exists exactly once.
//
// The list is the agent's own plan — the latest `todo/write` snapshot, replaced
// wholesale on every write. Entries carry no stable id by design (see the
// protocol type), so the index+content pair is the render key.
//
// Empty plan = the surfaces do not mount at all: no placeholder, no reserved
// space, the chat column simply re-centers.

import { useEffect, useRef, useState } from "react";
import { Check, ChevronRight, ChevronsLeft, ChevronsRight, Circle, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useChatStore } from "@platform/core";
import type { TodoItem } from "@platform/core";
import { cn } from "@/lib/utils";

function StatusIcon({ status }: { status: TodoItem["status"] }) {
  if (status === "completed") {
    return <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />;
  }
  if (status === "in_progress") {
    return <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin text-primary" aria-hidden="true" />;
  }
  return <Circle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground/50" aria-hidden="true" />;
}

export function TodoList({ todos }: { todos: TodoItem[] }) {
  const listRef = useRef<HTMLUListElement>(null);
  const activeIndex = todos.findIndex((todo) => todo.status === "in_progress");

  // Keep the work in progress visible: after a replacement, bring the first
  // in-progress entry into view. `nearest` means a list that is already showing
  // it (or has none) does not scroll at all.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `todos` is the deliberate trigger — the list identity changes on every snapshot
  useEffect(() => {
    if (activeIndex < 0) return;
    listRef.current
      ?.querySelector('[data-status="in_progress"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [todos, activeIndex]);

  return (
    <ul ref={listRef} data-testid="plan-list" className="flex flex-col gap-0.5">
      {todos.map((todo, i) => (
        <li
          // biome-ignore lint/suspicious/noArrayIndexKey: snapshot entries have no id by design; index+content identifies a row within one snapshot
          key={`${i}-${todo.content}`}
          data-testid="plan-item"
          data-status={todo.status}
          className={cn(
            "flex items-start gap-2 rounded-md px-2 py-1.5 text-xs",
            todo.status === "in_progress" && "border-l-2 border-l-primary bg-primary/5",
            todo.status === "completed" && "text-muted-foreground",
          )}
        >
          <StatusIcon status={todo.status} />
          <span
            title={todo.content}
            className={cn(
              "min-w-0 break-words line-clamp-2",
              todo.status === "completed" && "line-through",
            )}
          >
            {todo.content}
          </span>
        </li>
      ))}
    </ul>
  );
}

// The right-hand column. Hidden below lg (the dock takes over there) and
// unmounted entirely while the plan is empty.
export function PlanPanel() {
  const { t } = useTranslation();
  const todos = useChatStore((s) => s.todos);
  const counts = useChatStore((s) => s.todoCounts);
  const [collapsed, setCollapsed] = useState(false);

  if (todos.length === 0) return null;

  return (
    <aside
      data-testid="plan-panel"
      aria-label={t("chat.plan.ariaLabel")}
      className="hidden w-[300px] shrink-0 flex-col border-l border-border bg-card lg:flex"
    >
      {/* Header height and padding mirror the session header so the two
          border-b rules line up across the columns. */}
      <header className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <span className="text-sm font-medium text-foreground">{t("chat.plan.title")}</span>
        <span data-testid="plan-count" className="text-xs tabular-nums text-muted-foreground">
          {counts.completed}/{todos.length}
        </span>
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          aria-expanded={!collapsed}
          aria-label={collapsed ? t("chat.plan.expand") : t("chat.plan.collapse")}
          title={collapsed ? t("chat.plan.expand") : t("chat.plan.collapse")}
          data-testid="plan-collapse"
          className="ml-auto rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          {collapsed ? (
            <ChevronsLeft className="h-4 w-4" aria-hidden="true" />
          ) : (
            <ChevronsRight className="h-4 w-4" aria-hidden="true" />
          )}
        </button>
      </header>
      {!collapsed && (
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          <TodoList todos={todos} />
        </div>
      )}
    </aside>
  );
}

// The narrow-viewport fallback, rendered inside the composer card above the
// textarea. The collapsed line carries the counts so a plan reads at a glance
// without expanding.
export function PlanDock() {
  const { t } = useTranslation();
  const todos = useChatStore((s) => s.todos);
  const counts = useChatStore((s) => s.todoCounts);
  const [open, setOpen] = useState(false);

  if (todos.length === 0) return null;

  // Zero-count segments are omitted: "3 completed · 1 pending" says more than
  // "3 completed · 0 in progress · 1 pending".
  const summary = [
    counts.completed ? t("chat.plan.statusCompleted", { count: counts.completed }) : null,
    counts.inProgress ? t("chat.plan.statusInProgress", { count: counts.inProgress }) : null,
    counts.pending ? t("chat.plan.statusPending", { count: counts.pending }) : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div data-testid="plan-dock" className="lg:hidden">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label={t("chat.plan.ariaLabel")}
        data-testid="plan-dock-toggle"
        className="flex w-full items-center gap-1.5 rounded-md px-1 py-1 text-left text-xs hover:bg-muted"
      >
        <ChevronRight
          className={cn("h-3 w-3 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")}
          aria-hidden="true"
        />
        <span className="shrink-0 font-medium text-foreground">{t("chat.plan.title")}</span>
        <span data-testid="plan-dock-count" className="shrink-0 tabular-nums text-muted-foreground">
          {counts.completed}/{todos.length}
        </span>
        <span className="min-w-0 truncate text-muted-foreground">{summary}</span>
      </button>
      {open && (
        <div className="max-h-40 overflow-y-auto px-1 pb-1">
          <TodoList todos={todos} />
        </div>
      )}
    </div>
  );
}
