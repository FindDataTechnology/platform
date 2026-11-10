import { ChevronRight, Eye, ListChecks, Loader2, Wrench } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { useChatStore, type Block } from "@platform/core";
import { usePreviewStore } from "@/hooks/usePreviewStore";
import { CronToolCard } from "@/components/CronToolCard";
import { TaskCard } from "@/components/TaskCard";
import { QuestionCard } from "@/components/QuestionCard";
import { ActionCard } from "@/components/ActionCard";
import { ConnectCta } from "@/components/ConnectCta";
import { baseName, fileUrl, producedFilePaths, resolveRef } from "@/lib/file-preview";
import { memo, useEffect, useId, useState } from "react";

// ── Supply annotation index (add-mcp-annotation-overlay D5) ─────────────────
// One fetch per locale, module-cached: the light {servers, tools} index from
// /api/supply-annotations. A tool block looks up `mcp__<server>__<leaf>`; any
// failure degrades to null (raw rendering, byte-identical to before).
interface ToolAnnotation {
  label: string;
  summary: string;
}
type AnnotationIndex = { servers: Record<string, ToolAnnotation>; tools: Record<string, ToolAnnotation> };
const annotationIndexCache = new Map<string, Promise<AnnotationIndex>>();
function annotationIndex(locale: string): Promise<AnnotationIndex> {
  let p = annotationIndexCache.get(locale);
  if (!p) {
    p = fetch(`/api/supply-annotations?locale=${encodeURIComponent(locale)}`)
      .then((r) => (r.ok ? r.json() : { servers: {}, tools: {} }))
      .catch(() => ({ servers: {}, tools: {} }));
    annotationIndexCache.set(locale, p);
  }
  return p;
}

// `mcp__<server>__<leaf>` → { server, leaf }; any other name → null.
function parseMcpToolName(name: string): { server: string; leaf: string } | null {
  if (!name.startsWith("mcp__")) return null;
  const rest = name.slice(5);
  const i = rest.indexOf("__");
  if (i <= 0 || i + 2 >= rest.length) return null;
  return { server: rest.slice(0, i), leaf: rest.slice(i + 2) };
}

function useToolAnnotation(name: string): ToolAnnotation | null {
  const { i18n } = useTranslation();
  const [ann, setAnn] = useState<ToolAnnotation | null>(null);
  useEffect(() => {
    const parsed = parseMcpToolName(name);
    if (!parsed) return;
    let alive = true;
    annotationIndex(i18n.language).then((idx) => {
      if (!alive) return;
      setAnn(idx.tools[`${parsed.server}__${parsed.leaf}`] ?? null);
    });
    return () => {
      alive = false;
    };
  }, [name, i18n.language]);
  return ann;
}

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
  const toolAnn = useToolAnnotation(name);
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

  // propose_action renders as an action confirmation card. Suffix match like
  // the cron/delegate cards: on the wire the name is `mcp__actions__propose_action`
  // (a strict compare against the bare name never fired — the card was a plain
  // tool block in every real turn until the 2026-10-22 acceptance caught it).
  // The store mutates tool blocks in place, so the memoized card would never
  // see the landed result through the same object: hand it this render's
  // values, and the card re-renders exactly when its block does.
  if (name.endsWith("__propose_action")) {
    return <ActionCard block={{ name, args, state, result }} />;
  }

  // The file this call PRODUCED, when it produced one (openspec:
  // wire-shell-produced-artifacts). A read/list call has no file to open, so it
  // offers no action — "any file the call named, read or written" was the
  // defect this rule replaces. A path that does not resolve to a served root
  // simply yields no action.
  const fileRef =
    state === "done" ? resolveRef(producedFilePaths(name, args)[0] ?? "", workspace) : null;
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
            {/* add-mcp-annotation-overlay: the localized human label leads
                when the tool carries an annotation — the raw callable name
                stays visible beside it and is never replaced. */}
            {toolAnn ? (
              <span className="min-w-0 truncate" data-testid="tool-annotation-label">
                <span className="font-medium text-foreground">{toolAnn.label}</span>{" "}
                <span className="font-mono text-[10px] text-muted-foreground">{name}</span>
              </span>
            ) : (
              <span className="min-w-0 truncate font-mono font-semibold text-foreground">{name}</span>
            )}
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
          {/* Credential-shaped failures carry the panel to fix (chat-connect-
              guidance); the block auto-opens on error, so this stays visible. */}
          {state === "error" && block.connect?.panel && <ConnectCta panel={block.connect.panel} />}
        </div>
      )}
    </div>
  );
}

function Section({ label, body, error }: { label: string; body: string; error?: boolean }) {
  return (
    <div>
      <div className="micro-label mb-1 font-semibold text-muted-foreground">
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
