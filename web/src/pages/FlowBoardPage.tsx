// ── Flow board page (add-task-flow, tasks 6.2–6.4) ──────────────────────────
//
// The human's table: five columns, two bypass groups, and four verbs. Every
// card here is a task — nothing is stored on this page that the engine does not
// already own.
//
// Three deliberate silences, each a spec requirement:
//   * "loading failed" and "no cards" never look alike (a blank board is a lie);
//   * dragging is a GESTURE that fires an existing verb, never a fifth verb;
//   * queue depth and admission refusal are shown as the engine reported them,
//     including "unknown".
//
// Route: /flows

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { PageShell } from "@/components/ui/page-shell";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState, SkeletonList } from "@/components/ui/states-kit";
import { showToast } from "@/components/ui/toast";
import { buildBoard, type BoardCard, type BoardColumn, type BypassGroup } from "@/lib/flow-board";
import type { FlowCard, FlowDeclaration } from "@/lib/types";

interface BoardPayload {
  flows: FlowDeclaration[];
  cards: FlowCard[];
  queueDepth: number | null;
  admissionRefusal: { used: number | null; limit: number | null; message: string } | null;
}

const COLUMNS_ORDER: BoardColumn[] = ["backlog", "ready", "running", "review", "done"];
const BYPASS_ORDER: BypassGroup[] = ["failed", "not_executed"];

async function api(method: string, url: string, body?: unknown) {
  const res = await fetch(url, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.message || data.error || `${method} ${url} (${res.status})`) as Error & { code?: string; payload?: unknown };
    err.code = data.error;
    err.payload = data;
    throw err;
  }
  return data;
}

export function FlowBoardPage() {
  const { t } = useTranslation();
  const [payload, setPayload] = useState<BoardPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // Direct read, no local mirror: a cached board that disagrees with the
      // server is the "two truths" defect in UI clothing.
      const data = (await api("GET", "/api/flows/board")) as BoardPayload;
      setPayload(data);
    } catch (err) {
      // A read failure must render as a failure, never as an empty board.
      setError((err as Error).message);
      setPayload(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const board = useMemo(
    () => (payload ? buildBoard({ cards: payload.cards, queueDepth: payload.queueDepth, admissionRefusal: payload.admissionRefusal }) : null),
    [payload],
  );

  const run = useCallback(
    async (label: string, fn: () => Promise<unknown>) => {
      setBusy(label);
      try {
        await fn();
        await load();
      } catch (err) {
        const e = err as Error & { code?: string; payload?: unknown };
        // The refusal reasons are the teaching surface: a blocked card names
        // its blocker, an unreviewed card names the failed criterion.
        const detail = JSON.stringify((e.payload as { blockedBy?: unknown })?.blockedBy ?? "");
        showToast({ severity: "error", title: e.code === "card_blocked" ? `${t("flows.error.blocked")}${detail}` : e.message });
      } finally {
        setBusy(null);
      }
    },
    [load, t],
  );

  const dispatch = (c: BoardCard) => run(`dispatch:${c.id}`, () => api("POST", `/api/flows/cards/${c.id}/dispatch`, {}));
  const accept = (c: BoardCard) =>
    run(`accept:${c.id}`, () =>
      api("POST", `/api/flows/cards/${c.id}/accept`, { artifacts: (c.history ?? []).length ? [] : [] }).catch(async (err) => {
        const e = err as Error & { code?: string };
        // "no criteria" and "criteria failed" are both routable to the signed
        // override — but only with a reason, which is the whole point.
        if (e.code === "no_criteria" || e.code === "criteria_failed") {
          const reason = window.prompt(t("flows.error.overrridePrompt")) ?? "";
          if (!reason.trim()) throw new Error(t("flows.error.cancelNoReason"));
          return api("POST", `/api/flows/cards/${c.id}/accept`, { override: { reason } });
        }
        throw err;
      }),
    );
  const sendBack = (c: BoardCard) =>
    run(`return:${c.id}`, () => {
      const reason = window.prompt(t("flows.error.returnPrompt")) ?? "";
      if (!reason.trim()) throw new Error(t("flows.error.cancelNoReturn"));
      return api("POST", `/api/flows/cards/${c.id}/return`, { reason });
    });

  const renderCard = (c: BoardCard, stationLabel: string) => (
    <div key={c.id} className="rounded-md border border-border bg-card p-3" data-testid="flow-card" data-card-id={c.id}>
      <p className="line-clamp-2 text-sm">{c.title || c.prompt}</p>
      {stationLabel ? <p className="mt-1 text-xs text-muted-foreground">{stationLabel}</p> : null}
      {c.blocked ? (
        <p className="mt-1 text-xs text-warning">{t("flows.blockedBy", { names: c.blockedByTitles.join("、") })}</p>
      ) : null}
      {c.error ? <p className="mt-1 line-clamp-2 text-xs text-destructive">{c.error}</p> : null}
      <div className="mt-2 flex flex-wrap gap-1">
        {!c.flow?.dispatchedAt && !c.blocked ? (
          <Button size="sm" variant="outline" disabled={busy === `dispatch:${c.id}`} onClick={() => dispatch(c)}>{t("flows.actions.dispatch")}</Button>
        ) : null}
        {/* Accept belongs to the REVIEW state only. Rendering it on a card
            that already carries a passing verdict invites a second signature
            on a closed card, and on an in-flight one it offers a button the
            server will refuse anyway. Caught on the real board (2026-11-20):
            two accepted cards in Done still showed "Accept". */}
        {c.state === "done" && c.flow?.verdict?.outcome !== "pass" ? (
          <Button size="sm" variant="outline" disabled={busy === `accept:${c.id}`} onClick={() => accept(c)}>{t("flows.actions.accept")}</Button>
        ) : null}
        {c.flow?.dispatchedAt ? (
          <Button size="sm" variant="ghost" disabled={busy === `return:${c.id}`} onClick={() => sendBack(c)}>{t("flows.actions.return")}</Button>
        ) : null}
      </div>
    </div>
  );

  const stationLabelOf = (c: BoardCard): string => {
    if (!c.flow?.flowId || !c.flow.stationId) return "";
    const flow = payload?.flows.find((f) => f.flowId === c.flow?.flowId);
    const station = flow?.stations.find((s) => s.stationId === c.flow?.stationId);
    return [flow?.name, station?.label ?? station?.stationId].filter(Boolean).join(" · ");
  };

  return (
    <PageShell title={t("flows.title")} titleTestId="flow-board-title">
      {loading ? <SkeletonList rows={6} /> : null}
      {!loading && error ? (
        <ErrorState message={`${t("flows.error.read")}：${error}`} onRetry={() => void load()} />
      ) : null}
      {!loading && !error && board ? (
        <div className="space-y-4">
          {/* Queue truth: depth and refusal are the engine's numbers. "unknown"
              stays unknown — it is not 0. */}
          <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
            <span>{t("flows.queue.label")}：{board.queueDepth === null ? t("flows.queue.unknown") : board.queueDepth}</span>
            {board.admissionRefusal ? (
              <span className="text-warning">{board.admissionRefusal.message}</span>
            ) : null}
          </div>

          {payload?.cards.length === 0 ? (
            <EmptyState title={t("flows.empty.title")} hint={t("flows.empty.hint")} />
          ) : (
            <>
              <div className="grid gap-3 md:grid-cols-5">
                {COLUMNS_ORDER.map((col) => (
                  <section key={col} className="rounded-md border border-border bg-muted/20 p-2">
                    <h3 className="mb-2 text-xs font-medium text-muted-foreground">
                      {t(`flows.columns.${col}`)}（{board.columns[col].length}）
                    </h3>
                    <div className="space-y-2">
                      {board.columns[col].map((c) => renderCard(c, stationLabelOf(c)))}
                    </div>
                  </section>
                ))}
              </div>

              {BYPASS_ORDER.map((g) =>
                board.bypass[g].length ? (
                  <section key={g} className="rounded-md border border-border p-2">
                    <h3 className="mb-2 text-xs font-medium text-muted-foreground">{t(`flows.bypass.${g}`)}（{board.bypass[g].length}）</h3>
                    <div className="grid gap-2 md:grid-cols-4">
                      {board.bypass[g].map((c) => (
                        <div key={c.id}>
                          {renderCard(c, stationLabelOf(c))}
                          {g === "not_executed" && c.state === "skipped" ? (
                            <p className="mt-1 text-xs text-muted-foreground">
                              {/* The reason rides the record; an unreasoned skip is itself
                                  a defect worth showing rather than hiding. */}
                              {c.error || t("flows.noReason")}
                            </p>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  </section>
                ) : null,
              )}
            </>
          )}
        </div>
      ) : null}
    </PageShell>
  );
}
