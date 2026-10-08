// The ask_user_question tool block's two faces (add-user-questions):
//
//   pending  — an interactive card: options as toggles (multi-select where
//              declared), an in-card free-text field whose content submits as
//              the custom answer, a cancel affordance. Presentation intents
//              (plan review) render as this same generic list — the answer
//              encoding is identical either way.
//   resolved — a static summary: the given answers (parsed from the tool
//              result), a cancellation, or a failure. History replay renders
//              exactly this shape, never a live card.
//
// The pending state is the store's pendingQuestion slice; the card binds to
// the block whose call the ask anchored to (toolCallId), and converges for
// every surface on the ask's own tool_end — first answer wins.

import { CircleHelp, Loader2, Send, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { useChatStore, type AskAnswerItem, type AskQuestionItem, type Block } from "@platform/core";
import { wsSend } from "@/hooks/useWebSocket";
import { memo, useState } from "react";

type ToolBlockModel = Extract<Block, { kind: "tool" }>;

interface Props {
  block: ToolBlockModel;
}

// Normalize a question from EITHER wire shape: the pending payload (camelCase
// multiSelect, straight from the seam) or the persisted tool args (the
// model-facing multi_select). Rendering must not care which side it read.
function normalizeQuestion(raw: Record<string, unknown> | null | undefined): AskQuestionItem | null {
  if (!raw || typeof raw.id !== "string" || typeof raw.question !== "string") return null;
  const multiSelect =
    (raw as { multiSelect?: unknown }).multiSelect ?? (raw as { multi_select?: unknown }).multi_select;
  return {
    id: raw.id,
    question: raw.question,
    ...(typeof raw.header === "string" ? { header: raw.header } : {}),
    ...(typeof raw.detail === "string" ? { detail: raw.detail } : {}),
    ...(Array.isArray(raw.options) ? { options: raw.options as AskQuestionItem["options"] } : {}),
    ...(multiSelect === true ? { multiSelect: true } : {}),
  };
}

function questionsOfArgs(args: unknown): AskQuestionItem[] {
  const list = (args as { questions?: unknown } | null)?.questions;
  if (!Array.isArray(list)) return [];
  return list.map((q) => normalizeQuestion(q as Record<string, unknown>)).filter((q) => q !== null);
}

// The resolved summary rows: selected labels + custom text per question, or
// the error text (a cancellation reads as an error result in the transcript).
function answeredRows(result: unknown): AskAnswerItem[] | null {
  const parsed = typeof result === "string" ? safeParse(result) : result;
  const answers = (parsed as { answers?: unknown } | null)?.answers;
  if (!Array.isArray(answers)) return null;
  return answers.filter(
    (a): a is AskAnswerItem =>
      a != null && typeof (a as AskAnswerItem).id === "string" && Array.isArray((a as AskAnswerItem).selected),
  );
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function QuestionCardBase({ block }: Props) {
  const { t } = useTranslation();
  const pending = useChatStore((s) => s.pendingQuestion);
  // Bind to the block the ask anchored to. The anchor is normally present
  // (the server derives it from the turn's tool-call map); an undefined
  // anchor falls back to ANY running ask block — only one can run at a time.
  const isPending =
    block.state === "running" &&
    pending !== null &&
    (pending.toolCallId === block.id || pending.toolCallId === undefined);
  const questions = isPending ? pending.questions : questionsOfArgs(block.args);
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [customs, setCustoms] = useState<Record<string, string>>({});

  const toggle = (q: AskQuestionItem, label: string) => {
    setSelected((prev) => {
      const current = prev[q.id] ?? [];
      if (q.multiSelect === true) {
        return { ...prev, [q.id]: current.includes(label) ? current.filter((l) => l !== label) : [...current, label] };
      }
      return { ...prev, [q.id]: current.includes(label) ? [] : [label] };
    });
  };

  const answersOf = (): AskAnswerItem[] | null => {
    const out: AskAnswerItem[] = [];
    for (const q of questions) {
      const sel = selected[q.id] ?? [];
      const custom = (customs[q.id] ?? "").trim();
      if (sel.length === 0 && !custom) return null; // this question unanswered
      out.push({ id: q.id, selected: sel, ...(custom ? { custom } : {}) });
    }
    return out.length > 0 ? out : null;
  };

  const submit = () => {
    const answers = answersOf();
    if (!isPending || answers === null) return;
    wsSend({ type: "answer_question", askId: pending.askId, answers });
  };
  const cancel = () => {
    if (!isPending) return;
    wsSend({ type: "answer_question", askId: pending.askId, cancelled: true });
  };

  // ── Resolved: a static summary, live turn or history replay alike ─────────
  if (!isPending) {
    const rows = answeredRows(block.result);
    return (
      <div
        data-testid="question-card"
        data-pending="false"
        className={cn(
          "overflow-hidden rounded-md border border-border border-l-2 bg-muted/40",
          block.state === "error" ? "border-l-destructive" : "border-l-success",
        )}
      >
        <div className="flex items-center gap-2 px-3 py-1.5 text-xs">
          <CircleHelp className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="min-w-0 truncate font-medium text-foreground">
            {block.state === "error" ? t("question.cancelled") : t("question.answered")}
          </span>
          {block.state === "error" && (
            <span className="min-w-0 truncate text-muted-foreground">{String(block.result)}</span>
          )}
        </div>
        {rows && rows.length > 0 && (
          <ul className="space-y-1 border-t border-border px-3 py-2 text-xs">
            {rows.map((row) => {
              const q = questions.find((x) => x.id === row.id);
              return (
                <li key={row.id} className="flex min-w-0 flex-col gap-0.5">
                  <span className="truncate text-muted-foreground">{q?.question ?? row.id}</span>
                  <span className="truncate font-medium text-foreground">
                    {row.selected.join("、") || t("question.customAnswer")}
                    {row.custom ? `：${row.custom}` : ""}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    );
  }

  // ── Pending: the interactive card ─────────────────────────────────────────
  const canSubmit = answersOf() !== null;
  return (
    <div
      data-testid="question-card"
      data-pending="true"
      className="overflow-hidden rounded-md border border-border border-l-2 border-l-primary bg-card"
    >
      <div className="flex items-center gap-2 border-b border-border px-3 py-1.5 text-xs">
        <Loader2 className="h-3 w-3 shrink-0 animate-spin text-primary" aria-hidden="true" />
        <span className="font-medium text-foreground">{t("question.title")}</span>
        <span className="text-muted-foreground">{t("question.waitingHint")}</span>
      </div>
      <div className="space-y-3 px-3 py-2">
        {questions.map((q) => {
          const sel = selected[q.id] ?? [];
          return (
            <div key={q.id} className="space-y-1.5" data-testid="question-item">
              {q.header && <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{q.header}</div>}
              <div className="text-sm font-medium text-foreground">{q.question}</div>
              {q.detail && <div className="whitespace-pre-wrap text-xs text-muted-foreground">{q.detail}</div>}
              {q.options && q.options.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {q.options.map((o) => {
                    const active = sel.includes(o.label);
                    return (
                      <button
                        key={o.label}
                        type="button"
                        onClick={() => toggle(q, o.label)}
                        data-testid="question-option"
                        data-selected={active ? "true" : "false"}
                        title={o.description}
                        className={cn(
                          "rounded-md border px-2.5 py-1 text-xs transition-colors",
                          active
                            ? "border-primary bg-primary/10 font-medium text-foreground"
                            : "border-border bg-background text-foreground hover:bg-muted",
                        )}
                      >
                        {o.label}
                      </button>
                    );
                  })}
                </div>
              )}
              <input
                value={customs[q.id] ?? ""}
                onChange={(e) => setCustoms((prev) => ({ ...prev, [q.id]: e.target.value }))}
                placeholder={t("question.customPlaceholder")}
                data-testid="question-custom"
                className="w-full rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>
          );
        })}
        <div className="flex items-center justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={cancel}
            data-testid="question-cancel"
            className="flex items-center gap-1 rounded-md px-2.5 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="h-3 w-3" aria-hidden="true" />
            {t("question.cancel")}
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={!canSubmit}
            data-testid="question-submit"
            className="flex items-center gap-1 rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Send className="h-3 w-3" aria-hidden="true" />
            {t("question.submit")}
          </button>
        </div>
      </div>
    </div>
  );
}

export const QuestionCard = memo(QuestionCardBase);
