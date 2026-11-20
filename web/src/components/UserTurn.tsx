// UserTurn.tsx — right-aligned pill for user text. Whitespace preserved. The
// LAST user turn carries an edit-and-resend action (revealed on hover,
// keyboard-accessible via focus-visible) — it prefills the composer instead of
// mutating history. A `taskSummary` turn is the delegation aggregator's
// injected summary (spec: agent-delegation-tools): rendered task-authored —
// left-aligned, bordered, labelled — never as a user bubble, and never
// editable.
import { memo } from "react";
import { useTranslation } from "react-i18next";
import { ListChecks, Pencil } from "lucide-react";

function UserTurnBase({ text, onEdit, taskSummary }: { text: string; onEdit?: () => void; taskSummary?: boolean }) {
  const { t } = useTranslation();
  if (taskSummary) {
    return (
      <div
        className="flex items-start gap-2 rounded-md border border-border border-l-2 border-l-primary bg-muted/40 px-3 py-2"
        data-testid="turn-task-summary"
      >
        <ListChecks className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium text-primary">{t("tasks.summary.label")}</p>
          <p className="mt-0.5 whitespace-pre-wrap break-words text-sm text-foreground/80">{text}</p>
        </div>
      </div>
    );
  }
  return (
    <div className="group flex items-end justify-end gap-1" data-testid="turn-user">
      {onEdit && (
        <button
          type="button"
          onClick={onEdit}
          aria-label={t("turn.editResend")}
          data-testid="turn-edit"
          className="mb-0.5 grid h-6 w-6 place-items-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
        >
          <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      )}
      <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl bg-primary-deep px-4 py-2 text-sm text-primary-foreground">
        {text}
      </div>
    </div>
  );
}

// Memoized: the store mutates turn objects in place and clones only the
// turns array, so a streaming delta re-renders just the tail turn's
// component instead of reconciling the whole transcript.
export const UserTurn = memo(UserTurnBase);
