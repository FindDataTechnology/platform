// AcceptanceEditor — the team document's acceptance assertions as FORM ROWS
// (complete-team-authoring-loop 2.6).
//
// Acceptance is the only thing a trial run can judge green on
// (`blueprint-trial.js` refuses to run with zero assertions), and until now it
// was writable ONLY by pasting JSON into the document track. That hid the
// ticket to "sellable" behind a developer gesture.
//
// The `kind` dropdown is the server's closed set, imported rather than
// re-typed: a free-text kind would just manufacture
// `acceptance_kind_unsupported` findings. `target` is a post-title picker for
// the same reason — an unknown post title is a judgement the trial cannot make.
//
// This component does not validate. The existing `normalizeAcceptance` chain
// judges every row; the editor's job is to produce rows in the shape it expects
// and to anchor each server finding back to its row.

import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

import { TRIAL_ASSERTION_KINDS, JUDGE_ASSERTION_CAP as JUDGE_CAP, type AssertionKind, type AcceptanceRow } from "@/lib/assertion-kinds";

export { TRIAL_ASSERTION_KINDS };
export type { AssertionKind, AcceptanceRow };

export function AcceptanceEditor({
  value,
  postTitles,
  errors,
  onChange,
}: {
  value: AcceptanceRow[];
  postTitles: string[];
  /** Server findings already scoped to acceptance, keyed by entry path
   *  ("acceptance[2].rubric") so a row can show its own rejection. */
  errors: { error: string; entry?: string; code?: string }[];
  onChange: (next: AcceptanceRow[]) => void;
}) {
  const { t } = useTranslation();

  const judgeCount = value.filter((r) => r.kind === "llm-judged").length;
  const add = () => {
    onChange([...value, { id: `a${value.length + 1}`, kind: "report-landed" }]);
  };
  const update = (i: number, patch: Partial<AcceptanceRow>) =>
    onChange(value.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const remove = (i: number) => onChange(value.filter((_, j) => j !== i));

  const errorsFor = (i: number) => errors.filter((e) => typeof e.entry === "string" && e.entry.startsWith(`acceptance[${i}]`));

  return (
    <div className="space-y-2" data-testid="ws-acceptance">
      {value.map((row, i) => {
        const rowErrors = errorsFor(i);
        return (
          <div
            /* biome-ignore lint/suspicious/noArrayIndexKey: positional rows of an editable list — `id` is a user-editable field, so keying on it alone would remount the row (and drop focus) on every keystroke; position is the row's identity here, exactly as in PostDrawer */
            key={`${row.id}-${i}`}
            className={`rounded-md border p-2 ${rowErrors.length ? "border-destructive/50" : "border-border"}`}
            data-testid={`ws-acceptance-row-${i}`}
          >
            <div className="flex items-center gap-1">
              <Input
                className="w-24 font-mono text-xs"
                value={row.id}
                placeholder={t("studio.acceptance.id")}
                onChange={(e) => update(i, { id: e.target.value })}
                data-testid={`ws-acceptance-id-${i}`}
              />
              <select
                className="rounded-md border border-border bg-background px-2 py-1 text-xs"
                value={row.kind}
                onChange={(e) => update(i, { kind: e.target.value as AssertionKind })}
                data-testid={`ws-acceptance-kind-${i}`}
              >
                {TRIAL_ASSERTION_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>
              <select
                className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1 text-xs"
                value={row.target ?? ""}
                onChange={(e) => update(i, { target: e.target.value || undefined })}
                data-testid={`ws-acceptance-target-${i}`}
              >
                <option value="">{t("studio.acceptance.anyPost")}</option>
                {postTitles.map((title) => (
                  <option key={title} value={title}>
                    {title}
                  </option>
                ))}
              </select>
              <Button size="icon" variant="ghost" aria-label={t("studio.remove")} onClick={() => remove(i)}>
                ×
              </Button>
            </div>

            {row.kind === "escalate-bounded" ? (
              <Input
                className="mt-1 w-32 text-xs"
                type="number"
                placeholder={t("studio.acceptance.expect")}
                value={row.expect ?? ""}
                onChange={(e) => update(i, { expect: e.target.value === "" ? undefined : Number(e.target.value) })}
                data-testid={`ws-acceptance-expect-${i}`}
              />
            ) : null}

            {row.kind === "llm-judged" ? (
              <Textarea
                className="mt-1 text-xs"
                rows={2}
                placeholder={t("studio.acceptance.rubric")}
                value={row.rubric ?? ""}
                onChange={(e) => update(i, { rubric: e.target.value })}
                data-testid={`ws-acceptance-rubric-${i}`}
              />
            ) : null}

            {rowErrors.map((e, k) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: flat error rows for one acceptance row, never reordered
              <p key={k} className="mt-1 text-[11px] text-destructive" data-testid={`ws-acceptance-error-${i}`}>
                {e.error}
              </p>
            ))}
          </div>
        );
      })}

      <div className="flex items-center justify-between gap-2">
        <Button size="sm" variant="outline" onClick={add} data-testid="ws-acceptance-add">
          + {t("studio.acceptance.add")}
        </Button>
        {judgeCount > JUDGE_CAP ? (
          <span className="text-[11px] text-destructive" data-testid="ws-acceptance-cap">
            {t("studio.acceptance.overCap", { n: judgeCount, cap: JUDGE_CAP })}
          </span>
        ) : null}
      </div>
    </div>
  );
}
