// SkillCandidatesView — the owner's review face for AI-proposed skill
// candidates (add-skill-self-evolution). Mounted in the skills extensions
// view above the installed list. Order: evaluated first (promotion-ready),
// then fresh candidates, then decided ones. Every action is the owner's —
// evaluate runs the A/B gate (judge-lane call pair), promote lands the skill
// (materializer hot-loads), reject is final.

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { Blocks } from "lucide-react";
import { Button } from "@/components/ui/button";

interface Candidate {
  id: string;
  name: string;
  description: string;
  body: string;
  evidence: { source?: string; solved?: string; boundary?: string } | null;
  supersedes: string | null;
  status: "candidate" | "evaluated" | "promoted" | "rejected";
  evalReport: { passed?: boolean; reason?: string; error?: string; verdict?: { best: string; reasoning: string }; lane?: { model: string } } | null;
  proposedBy: string;
  createdAt: string;
  sourceDocId?: string | null;
}

const STATUS_ORDER: Record<string, number> = { evaluated: 0, candidate: 1, promoted: 2, rejected: 3 };

export function SkillCandidatesView() {
  const { t } = useTranslation();
  const [items, setItems] = useState<Candidate[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const r = await fetch("/api/skill-evolution/candidates");
      if (!r.ok) throw new Error(String(r.status));
      const d = await r.json();
      setItems([...(d.candidates ?? [])].sort((a, b) => (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9)));
      setError(null);
    } catch (e) {
      setItems([]);
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const act = async (id: string, verb: "evaluate" | "promote" | "reject") => {
    setBusy(id);
    setError(null);
    try {
      const r = await fetch(`/api/skill-evolution/candidates/${id}/${verb}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(verb === "reject" ? { reason: "owner rejected" } : {}),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) setError(d.error ?? String(r.status));
      await reload();
    } finally {
      setBusy(null);
    }
  };

  if (items === null) return null;
  if (items.length === 0) return null; // nothing pending — render nothing (no clutter)

  return (
    <div className="mb-6 rounded-md border border-primary/30 bg-primary/5 p-4" data-testid="skill-candidates">
      <h2 className="text-sm font-medium">{t("skillEvo.title")}</h2>
      <p className="mt-1 text-xs text-muted-foreground">{t("skillEvo.subtitle")}</p>
      {error && (
        <p className="mt-2 text-xs text-destructive" data-testid="skill-candidates-error">
          {error}
        </p>
      )}
      <ul className="mt-3 space-y-2">
        {items.map((c) => (
          <li key={c.id} className="rounded-md border border-border bg-background p-3" data-testid={`skill-candidate-${c.id}`}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm font-medium">
                {c.name}
                {c.supersedes ? <span className="ml-2 text-xs text-muted-foreground">↻ {c.supersedes}</span> : null}
              </span>
              <span
                className={`rounded-full px-2 py-0.5 text-xs ${
                  c.status === "evaluated" ? "bg-primary/15 text-primary" : c.status === "rejected" || c.status === "promoted" ? "bg-muted text-muted-foreground" : "bg-amber-500/15 text-amber-600"
                }`}
                data-testid={`skill-candidate-status-${c.id}`}
              >
                {t(`skillEvo.status.${c.status}`)}
              </span>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">{c.description}</p>
            {/* 8.1 回链：studio 发起的提案带来源文档芯片；cell MCP 提案缺席=诚实不显。 */}
            {c.sourceDocId ? (
              <Link
                to={`/studio?doc=${encodeURIComponent(c.sourceDocId)}`}
                className="mt-1 inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
                data-testid={`skill-candidate-source-doc-${c.id}`}
              >
                <Blocks className="h-3 w-3" />
                {t("studio.workspace.sourceDoc")}
              </Link>
            ) : null}
            {c.evidence?.source ? (
              <p className="mt-1 text-xs text-muted-foreground">
                {t("skillEvo.evidence", { source: c.evidence.source, solved: c.evidence.solved ?? "" })}
              </p>
            ) : null}
            {c.evalReport?.reason && (
              <p className="mt-1 text-xs" data-testid={`skill-candidate-verdict-${c.id}`}>
                {c.evalReport.verdict ? `${t("skillEvo.verdict", { best: c.evalReport.verdict.best })} — ` : ""}
                {c.evalReport.reason}
                {c.evalReport.lane?.model ? ` (${c.evalReport.lane.model})` : ""}
              </p>
            )}
            {c.status !== "promoted" && c.status !== "rejected" && (
              <div className="mt-2 flex flex-wrap gap-2">
                {c.status === "candidate" && (
                  <Button size="sm" variant="outline" disabled={busy === c.id} onClick={() => void act(c.id, "evaluate")} data-testid={`skill-candidate-evaluate-${c.id}`}>
                    {t("skillEvo.evaluate")}
                  </Button>
                )}
                {c.status === "evaluated" && (
                  <Button size="sm" disabled={busy === c.id} onClick={() => void act(c.id, "promote")} data-testid={`skill-candidate-promote-${c.id}`}>
                    {t("skillEvo.promote")}
                  </Button>
                )}
                <Button size="sm" variant="ghost" disabled={busy === c.id} onClick={() => void act(c.id, "reject")} data-testid={`skill-candidate-reject-${c.id}`}>
                  {t("skillEvo.reject")}
                </Button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
