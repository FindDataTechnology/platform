// PersonaAmendmentsView — the owner's review face for AI-proposed persona
// amendments (add-persona-self-evolution). Mounted in the builder hub's
// tuning area (add-agent-builder-hub 调优区) below the skill candidates.
// Order: evaluated first (promotion-ready), then fresh candidates, then
// decided ones. Every action is the owner's — evaluate runs the persona A/B
// gate (judge-lane call pair), promote SPLITS by target (a custom preset
// materializes; a pack persona opens a fork draft), reject is final. When
// nothing is pending the honest empty state remains visible — the hub spec
// keeps the placeholder contract (暂无修订) rather than hiding the area.

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { Blocks } from "lucide-react";
import { Button } from "@/components/ui/button";

interface Amendment {
  id: string;
  // Row fields ride snake_case verbatim from the store (the skill view's
  // same tolerance) — only evidence/evalReport deserialize into objects.
  target_kind: "preset" | "pack";
  target_ref: string;
  agent_id: string | null;
  current_persona: string | null;
  amended_persona: string;
  evidence: { source?: string; fixed?: string; boundary?: string } | null;
  status: "candidate" | "evaluated" | "promoted" | "rejected";
  evalReport: { passed?: boolean; reason?: string; error?: string; verdict?: { best: string; reasoning: string }; lane?: { model: string } } | null;
  proposed_by: string;
  created_at: string;
  source_doc_id?: string | null;
}

const STATUS_ORDER: Record<string, number> = { evaluated: 0, candidate: 1, promoted: 2, rejected: 3 };

export function PersonaAmendmentsView() {
  const { t } = useTranslation();
  const [items, setItems] = useState<Amendment[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const r = await fetch("/api/persona-evolution/candidates");
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
      const r = await fetch(`/api/persona-evolution/candidates/${id}/${verb}`, {
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

  return (
    <div className="rounded-md border border-primary/30 bg-primary/5 p-4" data-testid="persona-amendments">
      <h2 className="text-sm font-medium">{t("personaEvo.title")}</h2>
      <p className="mt-1 text-xs text-muted-foreground">{t("personaEvo.subtitle")}</p>
      {error && (
        <p className="mt-2 text-xs text-destructive" data-testid="persona-amendments-error">
          {error}
        </p>
      )}
      {items.length === 0 ? (
        // Nothing pending — the honest empty state (the hub placeholder
        // contract: the area never renders writable controls it cannot back).
        <p className="mt-3 text-xs text-muted-foreground" data-testid="tuning-persona-placeholder">
          {t("personaEvo.empty")}
        </p>
      ) : (
        <ul className="mt-3 space-y-2">
          {items.map((c) => (
            <li key={c.id} className="rounded-md border border-border bg-background p-3" data-testid={`persona-amendment-${c.id}`}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm font-medium">
                  {c.target_kind === "pack" ? `${c.target_ref} · ${c.agent_id ?? ""}` : c.target_ref}
                  <span className="ml-2 text-xs text-muted-foreground">{t(`personaEvo.target.${c.target_kind}`)}</span>
                </span>
                <span
                  className={`rounded-full px-2 py-0.5 text-xs ${
                    c.status === "evaluated" ? "bg-primary/15 text-primary" : c.status === "rejected" || c.status === "promoted" ? "bg-muted text-muted-foreground" : "bg-amber-500/15 text-amber-600"
                  }`}
                  data-testid={`persona-amendment-status-${c.id}`}
                >
                  {t(`personaEvo.status.${c.status}`)}
                </span>
              </div>
              <details className="mt-1">
                <summary className="cursor-pointer select-none text-xs text-muted-foreground">{t("personaEvo.viewDiff")}</summary>
                <div className="mt-2 grid gap-2 text-xs">
                  <div>
                    <p className="font-medium text-muted-foreground">{t("personaEvo.current")}</p>
                    <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 text-[11px]">{c.current_persona}</pre>
                  </div>
                  <div>
                    <p className="font-medium text-muted-foreground">{t("personaEvo.amended")}</p>
                    <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap rounded bg-primary/5 p-2 text-[11px]">{c.amended_persona}</pre>
                  </div>
                </div>
              </details>
              {c.evidence?.source ? (
                <p className="mt-1 text-xs text-muted-foreground">
                  {t("personaEvo.evidence", { source: c.evidence.source, fixed: c.evidence.fixed ?? "" })}
                </p>
              ) : null}
              {/* 8.1 回链：studio 发起的提案带来源文档芯片；cell MCP 提案缺席=诚实不显。 */}
              {c.source_doc_id ? (
                <Link
                  to={`/studio?doc=${encodeURIComponent(c.source_doc_id)}`}
                  className="mt-1 inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
                  data-testid={`persona-amendment-source-doc-${c.id}`}
                >
                  <Blocks className="h-3 w-3" />
                  {t("studio.workspace.sourceDoc")}
                </Link>
              ) : null}
              {c.evalReport?.reason && (
                <p className="mt-1 text-xs" data-testid={`persona-amendment-verdict-${c.id}`}>
                  {c.evalReport.verdict ? `${t("skillEvo.verdict", { best: c.evalReport.verdict.best })} — ` : ""}
                  {c.evalReport.reason}
                  {c.evalReport.lane?.model ? ` (${c.evalReport.lane.model})` : ""}
                </p>
              )}
              {c.status !== "promoted" && c.status !== "rejected" && (
                <div className="mt-2 flex flex-wrap gap-2">
                  {c.status === "candidate" && (
                    <Button size="sm" variant="outline" disabled={busy === c.id} onClick={() => void act(c.id, "evaluate")} data-testid={`persona-amendment-evaluate-${c.id}`}>
                      {t("personaEvo.evaluate")}
                    </Button>
                  )}
                  {c.status === "evaluated" && (
                    <Button size="sm" disabled={busy === c.id} onClick={() => void act(c.id, "promote")} data-testid={`persona-amendment-promote-${c.id}`}>
                      {c.target_kind === "pack" ? t("personaEvo.promoteFork") : t("personaEvo.promote")}
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" disabled={busy === c.id} onClick={() => void act(c.id, "reject")} data-testid={`persona-amendment-reject-${c.id}`}>
                    {t("skillEvo.reject")}
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
