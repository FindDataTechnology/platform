// InboxPage — 待办 (openspec: owner-inbox).
//
// One screen that answers "what needs me today?" across every lane that parks
// work for a human. Two segments only: 等你 (open, needs a ruling) and 在途
// (ruled but not closed). Every row states, BEFORE any button is pressed, what
// approving it will do — that sentence comes from the SERVER, derived from the
// same detail fields the approval callback reads, so the copy cannot drift from
// the behaviour.
//
// Deliberate absences, each one a spec requirement:
//   • no "approve all" — a batch is N independent rulings (runBatch fires the
//     lane's own endpoint per item and reports per-item receipts);
//   • no client-side lane logic — every action's endpoint came back in the
//     envelope, so this page cannot invent a second path into any lane;
//   • a lane that failed to read renders as failed, never as "nothing here".

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { Inbox as InboxIcon, RefreshCw } from "lucide-react";
import { PageShell } from "@/components/ui/page-shell";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState, SkeletonList } from "@/components/ui/states-kit";
import {
  fetchInbox,
  itemsInBucket,
  runAction,
  runBatch,
  type BatchReceipt,
  type InboxAction,
  type InboxItem,
  type InboxPayload,
} from "@platform/core";

type Segment = "waiting" | "inflight";

function severityClass(sev: string): string {
  if (sev === "high") return "bg-destructive/15 text-destructive";
  if (sev === "low") return "bg-muted text-muted-foreground";
  return "bg-muted text-foreground";
}

export function InboxPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [payload, setPayload] = useState<InboxPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [segment, setSegment] = useState<Segment>("waiting");
  const [busy, setBusy] = useState<string | null>(null);
  const [receipts, setReceipts] = useState<BatchReceipt[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [choiceByItem, setChoiceByItem] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const body = await fetchInbox();
      setPayload(body);
      setError(null);
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 60_000);
    return () => clearInterval(timer);
  }, [load]);

  const items = useMemo(() => itemsInBucket(payload, segment), [payload, segment]);
  const failed = useMemo(() => (payload?.lanes ?? []).filter((l) => l.status === "error"), [payload]);

  const typeLabel = (it: InboxItem) => {
    const key = `inbox.type.${it.itemType}`;
    const tx = t(key);
    return tx === key ? it.itemType : tx;
  };

  const runOne = async (item: InboxItem, action: InboxAction) => {
    setBusy(`${item.itemRef}:${action.op}`);
    setReceipts(null);
    try {
      const body: Record<string, unknown> = {};
      if (action.op === "approve" || action.op === "amend") {
        body.choice = choiceByItem[item.itemRef] ?? item.recommendation ?? item.options?.[0]?.value ?? "";
      }
      const res = await runAction(action, body, item.actions);
      setReceipts([{ itemRef: item.itemRef, ok: res.ok, status: res.status, error: res.ok ? undefined : String((res.data as { error?: string } | null)?.error ?? `HTTP ${res.status}`) }]);
      await load();
    } catch (e) {
      setReceipts([{ itemRef: item.itemRef, ok: false, error: String((e as Error)?.message ?? e) }]);
    } finally {
      setBusy(null);
    }
  };

  // Batch: the SAME op across the selected rows, one independent ruling each.
  const runSelected = async (op: string) => {
    const jobs = items
      .filter((it) => selected.has(it.itemRef))
      .map((it) => {
        const action = it.actions.find((a) => a.op === op);
        return action
          ? {
              itemRef: it.itemRef,
              action,
              body: op === "approve" || op === "amend"
                ? { choice: choiceByItem[it.itemRef] ?? it.recommendation ?? it.options?.[0]?.value ?? "" }
                : {},
            }
          : null;
      })
      .filter((j): j is { itemRef: string; action: InboxAction; body: Record<string, unknown> } => Boolean(j));
    if (!jobs.length) return;
    setBusy("batch");
    try {
      setReceipts(await runBatch(jobs));
      setSelected(new Set());
      await load();
    } finally {
      setBusy(null);
    }
  };

  const toggle = (ref: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(ref)) next.delete(ref);
      else next.add(ref);
      return next;
    });

  const counts = payload?.counts ?? { waiting: 0, inflight: 0 };

  return (
    <PageShell
      title={t("inbox.title")}
      titleTestId="inbox-title"
      subtitle={t("inbox.subtitle")}
      actions={
        <Button variant="outline" size="sm" onClick={() => void load()} data-testid="inbox-refresh">
          <RefreshCw className={loading ? "h-3 w-3 animate-spin" : "h-3 w-3"} aria-hidden="true" />
          {t("inbox.refresh")}
        </Button>
      }
      filters={
        <div className="flex flex-wrap items-center gap-2" data-testid="inbox-segments">
          {(["waiting", "inflight"] as const).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setSegment(s)}
              data-testid={`inbox-segment-${s}`}
              className={`inline-flex h-7 items-center rounded-md border px-2.5 text-xs ${
                segment === s ? "border-primary bg-primary/10 font-medium text-primary" : "border-border text-muted-foreground hover:bg-muted"
              }`}
            >
              {t(`inbox.segment.${s}`)} · {s === "waiting" ? counts.waiting : counts.inflight}
            </button>
          ))}
          {segment === "waiting" && selected.size > 0 ? (
            <span className="ml-auto flex items-center gap-2" data-testid="inbox-batch-bar">
              <span className="text-xs text-muted-foreground">{t("inbox.batch.selected", { count: selected.size })}</span>
              <Button size="sm" disabled={busy === "batch"} onClick={() => void runSelected("approve")} data-testid="inbox-batch-approve">
                {t("inbox.batch.approve")}
              </Button>
              <Button size="sm" variant="outline" disabled={busy === "batch"} onClick={() => void runSelected("reject")} data-testid="inbox-batch-reject">
                {t("inbox.batch.reject")}
              </Button>
            </span>
          ) : null}
        </div>
      }
    >
      <div className="mx-auto w-full max-w-4xl px-4 pb-10 md:px-6" data-testid="inbox-page">
        {error ? (
          <ErrorState message={t("inbox.loadError", { message: error })} onRetry={() => void load()} retryLabel={t("inbox.refresh")} />
        ) : loading && !payload ? (
          <SkeletonList rows={4} />
        ) : (
          <>
            {failed.length > 0 ? (
              <div className="mb-4 rounded-md border border-status-failed/40 bg-card px-3 py-2 text-xs text-status-failed" data-testid="inbox-lane-errors">
                {failed.map((l) => (
                  <div key={l.id}>
                    {t("inbox.laneError", { lane: l.label, message: l.error ?? "" })}
                  </div>
                ))}
              </div>
            ) : null}

            {receipts ? (
              <div className="mb-4 rounded-md border border-border bg-card px-3 py-2 text-xs" data-testid="inbox-receipts">
                {receipts.map((r) => (
                  <div key={r.itemRef} className={r.ok ? "text-success" : "text-destructive"}>
                    {r.ok ? t("inbox.receipt.ok", { ref: r.itemRef }) : t("inbox.receipt.failed", { ref: r.itemRef, error: r.error ?? "" })}
                  </div>
                ))}
              </div>
            ) : null}

            {items.length === 0 ? (
              <EmptyState
                icon={<InboxIcon className="h-5 w-5" />}
                title={segment === "waiting" ? t("inbox.empty.waiting") : t("inbox.empty.inflight")}
                hint={t("inbox.empty.hint")}
              />
            ) : (
              <ul className="flex flex-col gap-3" data-testid="inbox-list">
                {items.map((it) => {
                  const approve = it.actions.find((a) => a.op === "approve" || a.op === "accept");
                  const reject = it.actions.find((a) => a.op === "reject");
                  const primary = it.actions.find((a) => a.op !== "approve" && a.op !== "accept" && a.op !== "reject" && a.op !== "amend");
                  const selectable = segment === "waiting" && Boolean(approve);
                  return (
                    <li key={`${it.laneId}:${it.itemRef}`} className="rounded-md border border-border bg-card p-3" data-testid={`inbox-item-${it.itemRef}`}>
                      <div className="flex flex-wrap items-center gap-2">
                        {selectable ? (
                          <input
                            type="checkbox"
                            checked={selected.has(it.itemRef)}
                            onChange={() => toggle(it.itemRef)}
                            aria-label={it.title}
                            data-testid={`inbox-select-${it.itemRef}`}
                          />
                        ) : null}
                        <span className={`rounded-full px-2 py-0.5 text-[11px] ${severityClass(it.severity)}`}>
                          {t(`inbox.severity.${it.severity}`) || it.severity}
                        </span>
                        <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">{typeLabel(it)}</span>
                        <span className="text-xs text-muted-foreground">{it.originLabel}</span>
                        {it.submittedAt ? (
                          <span className="ml-auto text-[11px] text-muted-foreground">{new Date(it.submittedAt).toLocaleString()}</span>
                        ) : null}
                      </div>

                      <p className="mt-2 text-sm font-medium text-foreground" data-testid={`inbox-title-${it.itemRef}`}>{it.title}</p>

                      {/* The whole point of the surface: the consequence is stated
                          before the button, and it came from the server. */}
                      <p className="mt-1 text-xs leading-5 text-muted-foreground" data-testid={`inbox-consequence-${it.itemRef}`}>
                        {it.consequence}
                      </p>

                      {it.evaluation && it.evaluation.status !== "passed" ? (
                        <p className="mt-1 text-xs text-status-waiting" data-testid={`inbox-eval-${it.itemRef}`}>
                          {t(`inbox.eval.${it.evaluation.status}`)}
                          {it.evaluation.reason ? ` · ${it.evaluation.reason}` : ""}
                        </p>
                      ) : null}

                      {it.evidence ? <EvidenceBlock item={it} /> : null}

                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        {segment === "waiting" && it.options && it.options.length > 0 && (approve || it.actions.some((a) => a.op === "amend")) ? (
                          <select
                            className="rounded-md border border-border bg-background px-2 py-1 text-xs"
                            value={choiceByItem[it.itemRef] ?? it.recommendation ?? it.options[0]?.value ?? ""}
                            onChange={(e) => setChoiceByItem((m) => ({ ...m, [it.itemRef]: e.target.value }))}
                            data-testid={`inbox-choice-${it.itemRef}`}
                          >
                            {it.options.map((o) => (
                              <option key={o.value} value={o.value}>{o.label}</option>
                            ))}
                          </select>
                        ) : null}
                        {approve ? (
                          <Button
                            size="sm"
                            disabled={busy === `${it.itemRef}:${approve.op}`}
                            onClick={() => void runOne(it, approve)}
                            data-testid={`inbox-approve-${it.itemRef}`}
                          >
                            {approve.label}
                          </Button>
                        ) : null}
                        {primary ? (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={busy === `${it.itemRef}:${primary.op}`}
                            onClick={() => (primary.op === "answer" ? navigate(`/chat/${encodeURIComponent(String(it.originRefs.sessionId ?? ""))}`) : void runOne(it, primary))}
                            data-testid={`inbox-action-${primary.op}-${it.itemRef}`}
                          >
                            {primary.label}
                          </Button>
                        ) : null}
                        {reject ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={busy === `${it.itemRef}:${reject.op}`}
                            onClick={() => void runOne(it, reject)}
                            data-testid={`inbox-reject-${it.itemRef}`}
                          >
                            {reject.label}
                          </Button>
                        ) : null}
                        {it.actions.some((a) => a.op === "evaluate") ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={busy === `${it.itemRef}:evaluate`}
                            onClick={() => {
                              const ev = it.actions.find((a) => a.op === "evaluate")!;
                              void runOne(it, ev);
                            }}
                            data-testid={`inbox-evaluate-${it.itemRef}`}
                          >
                            {t("inbox.rerunEval")}
                          </Button>
                        ) : null}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </>
        )}
      </div>
    </PageShell>
  );
}

/** Evidence in a disclosure. Unrenderable shapes fall back to readable text —
 *  the spec forbids dropping evidence just because a client cannot style it. */
function EvidenceBlock({ item }: { item: InboxItem }) {
  const { t } = useTranslation();
  const detail = (item.evidence?.detail ?? null) as { changes?: unknown; diff?: unknown } | null;
  const changes = detail?.changes ?? null;
  const diff = detail?.diff ?? null;
  const card = item.evidence?.card ?? null;
  const amended = item.evidence?.amended ?? null;
  if (!changes && !diff && !card && !amended) return null;
  return (
    <details className="mt-1" data-testid={`inbox-evidence-${item.itemRef}`}>
      <summary className="cursor-pointer select-none text-xs text-muted-foreground">{t("inbox.evidence")}</summary>
      <div className="mt-1 space-y-1">
        {changes ? (
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 text-[11px]">
            {JSON.stringify(changes, null, 2)}
          </pre>
        ) : null}
        {diff ? (
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 text-[11px]">
            {typeof diff === "string" ? diff : JSON.stringify(diff, null, 2)}
          </pre>
        ) : null}
        {card ? (
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 text-[11px]">
            {JSON.stringify(card, null, 2)}
          </pre>
        ) : null}
        {amended ? (
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 text-[11px]">
            {String(amended)}
          </pre>
        ) : null}
      </div>
    </details>
  );
}
