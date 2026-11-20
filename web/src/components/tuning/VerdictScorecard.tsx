// VerdictScorecard — the owner's view of what the bench judged their objects to
// be worth (add-bench-verdict-read-face).
//
// Replaces nothing: SkillCandidatesView above it is the review QUEUE (act on a
// candidate), this is the SCOREBOARD (what did the evaluation say, and can it be
// compared with last time). Both read-only here; the page triggers no evaluation.
//
// Three presentation rules, each of them load-bearing:
//   • `inconclusive` renders as its own state, never as "未通过". Those rows mean
//     the evaluation could not decide — showing them as failures teaches the
//     owner to distrust a number for the wrong reason.
//   • `provisional` is stated in words. A green verdict from an uncalibrated
//     judge is evidence, not a promotion reason; hiding that would be the exact
//     self-deception the ledger exists to prevent.
//   • "no verdicts yet" / "the surface is not deployed" / "not configured" are
//     three DIFFERENT empty states with three different next steps. One generic
//     "暂无数据" would send the owner to the wrong place.

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Gauge } from "lucide-react";

interface Verdict {
  id: number;
  subject_kind: string;
  subject_key: string;
  subject_version: string;
  ruler_kind: string;
  ruler_key: string;
  ruler_digest: string;
  gate: string;
  outcome: "pass" | "fail" | "inconclusive" | string;
  provisional: boolean;
  baseline_run_id: number | null;
}

interface Subject {
  subject: string;
  kind: string;
  key: string;
  version: string;
  latestId: number;
  outcome: string;
  provisional: boolean;
  baselineId: number | null;
  comparison: "no-baseline" | "comparable" | "ruler-migrated";
  delta: number | null;
}

interface Payload {
  available: boolean;
  reason?: string;
  kind?: string;
  asOf?: string;
  owned: number;
  verdicts: Verdict[];
  counts: { pass: number; fail: number; inconclusive: number };
  provisionalCount?: number;
  subjects?: Subject[];
  /** Rows the peer returned at all (including legacy rows with no identity). */
  peerRows?: number;
  /** How many of those carry no subject/ruler identity. */
  unattributed?: number;
}

const OUTCOME_STYLE: Record<string, string> = {
  pass: "bg-primary/15 text-primary",
  fail: "bg-destructive/15 text-destructive",
  inconclusive: "bg-warning/15 text-warning",
};

export function VerdictScorecard() {
  const { t } = useTranslation();
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await fetch("/api/tuning/verdicts");
        const d = (await r.json().catch(() => ({}))) as Payload;
        if (!alive) return;
        if (!r.ok) setError(d.reason ?? String(r.status));
        else setData(d);
      } catch (err) {
        if (alive) setError(String((err as Error)?.message ?? err));
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  if (error) {
    return (
      <p className="text-xs text-destructive" data-testid="verdict-scorecard-error">
        {error}
      </p>
    );
  }
  if (!data) return null;

  // Three distinct empty states — see the header comment for why they must not
  // collapse into one sentence.
  if (!data.available) {
    return (
      <div className="rounded-md border border-border bg-muted/30 p-4" data-testid="verdict-scorecard-unavailable">
        <p className="text-sm font-medium">{t("verdictScorecard.unavailableTitle")}</p>
        <p className="mt-1 text-xs text-muted-foreground">{data.reason}</p>
        {data.kind === "not_deployed" ? (
          <p className="mt-1 text-xs text-muted-foreground">{t("verdictScorecard.notDeployedHint")}</p>
        ) : null}
      </div>
    );
  }

  if (data.owned === 0) {
    return (
      <div className="rounded-md border border-dashed border-border p-4" data-testid="verdict-scorecard-no-objects">
        <p className="text-sm font-medium">{t("verdictScorecard.noObjectsTitle")}</p>
        <p className="mt-1 text-xs text-muted-foreground">{t("verdictScorecard.noObjectsHint")}</p>
      </div>
    );
  }

  if (data.verdicts.length === 0) {
    // Third state, measured live 2026-11-18: the peer HAD rows, but all of them
    // predate the verdict ledger and carry no subject. Saying "no verdicts"
    // here would send the owner looking for a missing integration when the
    // integration works and the history simply has no identity.
    const legacyOnly = (data.peerRows ?? 0) > 0 && (data.unattributed ?? 0) > 0;
    return (
      <div className="rounded-md border border-dashed border-border p-4" data-testid="verdict-scorecard-no-verdicts">
        <p className="text-sm font-medium">
          {legacyOnly
            ? t("verdictScorecard.legacyOnlyTitle", {
                peer: data.peerRows ?? 0,
                owned: data.owned,
              })
            : t("verdictScorecard.noVerdictsTitle", { owned: data.owned })}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          {legacyOnly
            ? t("verdictScorecard.legacyOnlyHint")
            : t("verdictScorecard.noVerdictsHint")}
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-md border border-border p-4" data-testid="verdict-scorecard">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-1.5 text-sm font-medium">
          <Gauge className="h-4 w-4" />
          {t("verdictScorecard.title")}
        </h2>
        <div className="flex gap-3 text-xs" data-testid="verdict-scorecard-counts">
          <span className="text-primary">{t("verdictScorecard.pass")} {data.counts.pass}</span>
          <span className="text-destructive">{t("verdictScorecard.fail")} {data.counts.fail}</span>
          {/* A separate chip on purpose: "could not decide" is not "did not pass". */}
          <span className="text-warning">
            {t("verdictScorecard.inconclusive")} {data.counts.inconclusive}
          </span>
        </div>
      </div>
      {data.provisionalCount ? (
        <p className="mt-2 text-xs text-warning" data-testid="verdict-scorecard-provisional">
          {t("verdictScorecard.provisional", { count: data.provisionalCount })}
        </p>
      ) : null}
      {data.subjects?.length ? (
        <ul className="mt-3 space-y-2" data-testid="verdict-subject-rollup">
          {data.subjects.map((s) => (
            <li key={s.subject} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border p-2 text-xs">
              <span className="font-medium">{s.key}</span>
              <span className="flex flex-wrap items-center gap-2">
                {/* The comparison state, in words. A bare delta next to an
                    incomparable pair is the exact mistake the digest forbids. */}
                <span className="text-muted-foreground">
                  {s.comparison === "comparable"
                    ? t("verdictScorecard.delta", { delta: s.delta ?? 0 })
                    : t(`verdictScorecard.comparison.${s.comparison}`)}
                </span>
                {s.provisional ? (
                  <span className="text-warning">{t("verdictScorecard.rowProvisionalShort")}</span>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      <ul className="mt-3 space-y-2">
        {data.verdicts.map((v) => (
          <li key={v.id} className="rounded-md border border-border p-3" data-testid={`verdict-${v.id}`}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm font-medium">
                {v.subject_key}
                <span className="ml-2 text-xs text-muted-foreground">{v.subject_kind} · {v.subject_version.slice(0, 12)}</span>
              </span>
              <span className={`rounded-full px-2 py-0.5 text-xs ${OUTCOME_STYLE[v.outcome] ?? "bg-muted text-muted-foreground"}`}
                data-testid={`verdict-outcome-${v.id}`}>
                {t(`verdictScorecard.outcome.${v.outcome}`)}
              </span>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {t("verdictScorecard.rulerLine", { key: v.ruler_key, gate: v.gate })}
              {/* The digest is what makes two runs comparable — show a prefix so a
                  human can see "same ruler / different ruler" at a glance. */}
              <span className="ml-1 font-mono">{v.ruler_digest.slice(0, 8)}</span>
            </p>
            {v.provisional ? (
              <p className="mt-1 text-xs text-warning">{t("verdictScorecard.rowProvisional")}</p>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
