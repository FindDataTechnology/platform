// PublishChecklist — the four publish gates in one readable panel
// (complete-creator-loop D1: aggregation, not a second gate).
//
// Before this, a creator learned about a tool-surface gap or a vocabulary
// violation only by pressing publish and reading one sentence naming the
// offenders; the en-coverage answer arrived after a failed publish with jump
// targets, and everything else arrived as a bare message. The rows below come
// from publishChecklist.ts, which only re-states conditions other layers
// already enforce.
//
// Legacy test ids are preserved ON PURPOSE: e2e/packs.spec.js pins
// `pack-publish-gate` and `pack-publish-gap-<path>`, and they are the refusal
// display's contract — the panel absorbed that block rather than growing a
// second copy of it.

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight, AlertCircle, CheckCircle2 } from "lucide-react";
import { StatusPill } from "@/components/ui/status-pill";
import { groupChecklist, type ChecklistGate, type ChecklistRow } from "@/lib/publishChecklist";

/** At most this many rows per gate before the rest fold away — a draft with 40
 *  en-coverage gaps should still be a panel, not a wall. The count stays
 *  visible either way. */
const VISIBLE_PER_GATE = 3;

export function PublishChecklist({
  pending,
  refusal,
  onJump,
}: {
  /** Rows this surface can judge locally, before any publish attempt. */
  pending: ChecklistRow[];
  /** Rows derived from the server's refusal (empty until one happens). */
  refusal: ChecklistRow[];
  onJump: (subject: string) => void;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const refusalGate = refusal.some((r) => r.gate === "enCoverage") ? "enCoverage" : "manifest";
  // A refusal supersedes the local verdict for its own gate: the server is the
  // authority, and showing "nothing pending" beside "publish refused" reads as
  // a bug in the product.
  const merged = [
    ...pending.filter((r) => r.gate !== refusalGate || refusal.length === 0),
    ...refusal,
  ];
  const groups = groupChecklist(merged);
  const count = merged.length;
  const ready = count === 0;

  return (
    <div
      data-testid="publish-checklist"
      className="rounded-md border border-border bg-card/60 px-4 py-3"
      aria-live="polite"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">{t("packs.checklist.title")}</span>
        {ready ? (
          <StatusPill status="neutral" label={t("packs.checklist.ready")} />
        ) : (
          <StatusPill status="failed" label={t("packs.checklist.pending", { count })} />
        )}
        {ready && <CheckCircle2 className="h-4 w-4 text-muted-foreground" aria-hidden="true" />}
      </div>

      {groups.map((group) => {
        const showAll = expanded[group.gate];
        const visible = showAll ? group.rows : group.rows.slice(0, VISIBLE_PER_GATE);
        const hidden = group.rows.length - visible.length;
        const isRefusal = refusal.length > 0 && group.gate === refusalGate;
        return (
          <div key={group.gate} className="mt-2.5" data-testid={`publish-checklist-group-${group.gate}`}>
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              {group.gate === "manifest" ? (
                <AlertCircle className="h-3.5 w-3.5" aria-hidden="true" />
              ) : null}
              <span>{gateLabel(t, group.gate)}</span>
              <span className="tabular-nums">· {group.rows.length}</span>
            </div>
            <ul
              className="mt-1 space-y-1"
              {...(isRefusal ? { "data-testid": "pack-publish-gate", role: "alert" } : {})}
            >
              {visible.map((row) =>
                row.locatable ? (
                  <li key={row.id}>
                    <button
                      type="button"
                      data-testid={`pack-publish-gap-${row.subject}`}
                      onClick={() => onJump(row.subject)}
                      className="w-full rounded-md border border-border px-2 py-1 text-left font-mono text-[11px] text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
                    >
                      {row.subject}
                      <span className="ml-2 font-sans text-[11px] text-muted-foreground">
                        {t("packs.checklist.jump")}
                      </span>
                    </button>
                  </li>
                ) : (
                  <li key={row.id} className="px-2 py-1 text-xs text-muted-foreground">
                    {row.subject}
                  </li>
                ),
              )}
            </ul>
            {hidden > 0 && (
              <button
                type="button"
                onClick={() => setExpanded((e) => ({ ...e, [group.gate]: true }))}
                className="mt-1 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                data-testid={`publish-checklist-more-${group.gate}`}
              >
                <ChevronRight className="h-3 w-3" aria-hidden="true" />
                {t("packs.checklist.more", { count: hidden })}
              </button>
            )}
            {showAll && group.rows.length > VISIBLE_PER_GATE && (
              <button
                type="button"
                onClick={() => setExpanded((e) => ({ ...e, [group.gate]: false }))}
                className="mt-1 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              >
                <ChevronDown className="h-3 w-3" aria-hidden="true" />
                {t("packs.checklist.collapse")}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

function gateLabel(t: (k: string) => string, gate: ChecklistGate): string {
  return t(`packs.checklist.gate.${gate}`);
}
