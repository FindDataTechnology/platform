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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useCronStore } from "@platform/core";
import { PageShell } from "@/components/ui/page-shell";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState, SkeletonList } from "@/components/ui/states-kit";
import { showToast } from "@/components/ui/toast";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { buildBoard, buildFlowDeclaration, buildLanes, columnOf, flowSlugFromName, refreshDelay, unscopedNotice, type BoardCard, type BoardColumn, type BypassGroup } from "@/lib/flow-board";
import type { FlowCard, FlowDeclaration } from "@/lib/types";

interface BoardPayload {
  flows: FlowDeclaration[];
  cards: FlowCard[];
  queueDepth: number | null;
  admissionRefusal: { used: number | null; limit: number | null; message: string } | null;
  /** Cards withheld because they belong to someone else. Content never arrives;
   *  the count does, so a board that shows fewer cards than exist explains why. */
  unscoped?: number;
}

/** What `GET /cards/:id/transcript` answers. */
interface TranscriptPayload {
  sessionId: string | null;
  exists: boolean;
  messages: { role: string; content: string; key?: string }[];
  readError?: string;
}

const COLUMNS_ORDER: BoardColumn[] = ["backlog", "ready", "running", "review", "done"];
const BYPASS_ORDER: BypassGroup[] = ["failed", "not_executed"];

// View preference key + helpers. localStorage can throw (private mode, quota);
// a failed read/write degrades to the default view rather than taking the page
// down, because the preference is convenience, not state.
const VIEW_KEY = "flows.board.view";
type ViewMode = "single" | "lanes";
const readStoredView = (): ViewMode => {
  try { return localStorage.getItem(VIEW_KEY) === "lanes" ? "lanes" : "single"; } catch { return "single"; }
};
const writeStoredView = (v: ViewMode) => {
  try { localStorage.setItem(VIEW_KEY, v); } catch { /* preference is best-effort */ }
};

/** Compose-dialog form state. One object so reset is one call. */
interface ComposeState {
  mode: "flow" | "card";
  name: string;
  flowId: string;
  stationLabel: string;
  targetKind: string;
  targetRef: string;
  flowPick: string;
  stationPick: string;
  prompt: string;
  presets: { id: string; name: string }[];
  presetsError: boolean;
}
const emptyCompose = (): ComposeState => ({
  mode: "flow", name: "", flowId: "", stationLabel: "",
  targetKind: "persona", targetRef: "", flowPick: "", stationPick: "", prompt: "",
  presets: [], presetsError: false,
});

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
  // The open card and its transcript. `null` card = closed. The transcript load
  // is per-open so a stale conversation never shows against another card.
  const [opened, setOpened] = useState<BoardCard | null>(null);
  const [transcript, setTranscript] = useState<TranscriptPayload | null>(null);
  const [transcriptLoading, setTranscriptLoading] = useState(false);
  // Board view: one axis (columns only) or lanes (columns × flow·station). The
  // choice is per-user UI state only — localStorage, no server write, because a
  // view preference is not a fact about the card.
  const [view, setViewMode] = useState<ViewMode>(() => readStoredView());
  // The compose dialog. Two modes share it: no flow yet → declare one; flows
  // exist → add a card to one. Both end by re-reading the board.
  const [composeOpen, setComposeOpen] = useState(false);
  const [compose, setCompose] = useState<ComposeState>(() => emptyCompose());
  const [composeIssues, setComposeIssues] = useState<string[]>([]);
  const [composeBusy, setComposeBusy] = useState(false);

  const openCard = useCallback(async (card: BoardCard) => {
    setOpened(card);
    setTranscript(null);
    setTranscriptLoading(true);
    try {
      const data = (await api("GET", `/api/flows/cards/${card.id}/transcript`)) as TranscriptPayload;
      // Stamp a stable key once, at the moment the payload lands: the list never
      // reorders, and a content-derived key would collide on two identical turns.
      setTranscript({ ...data, messages: data.messages.map((m, i) => ({ ...m, key: `${card.id}-${i}` })) });
    } catch (err) {
      // The failure is shown INSIDE the panel; the card itself stays usable.
      setTranscript({ sessionId: null, exists: false, messages: [], readError: (err as Error).message });
    } finally {
      setTranscriptLoading(false);
    }
  }, []);

  const load = useCallback(async ({ quiet = false }: { quiet?: boolean } = {}) => {
    // A background refresh (triggered by a task broadcast) must not flash the
    // skeleton over a board the user is reading — only the first read shows it.
    if (!quiet) setLoading(true);
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
      if (!quiet) setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // Live refresh over the EXISTING WS lane (same trigger FleetsPage uses): the
  // cron store updates on every cron_status/cron_completed broadcast, and a
  // card's state rides those. Watching it means a dispatch or a finished turn
  // shows up without a manual reload — no second polling loop, no new event.
  const cronJobsVersion = useCronStore((st) => st.jobs.map((j) => `${j.id}:${j.state ?? ""}:${j.paused ? 1 : 0}`).join("|"));
  const lastFetchRef = useRef(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: cronJobsVersion is the intentional external refresh signal
  useEffect(() => {
    const wait = refreshDelay(lastFetchRef.current, Date.now());
    if (wait > 0) {
      const timer = setTimeout(() => { lastFetchRef.current = Date.now(); void load({ quiet: true }); }, wait);
      return () => clearTimeout(timer);
    }
    lastFetchRef.current = Date.now();
    void load({ quiet: true });
  }, [cronJobsVersion, load]);

  const board = useMemo(
    () => (payload ? buildBoard({ cards: payload.cards, queueDepth: payload.queueDepth, admissionRefusal: payload.admissionRefusal }) : null),
    [payload],
  );
  // Lanes are a pure cut of the SAME cards; the flat board stays the source of
  // every column decision.
  const lanes = useMemo(
    () => (payload ? buildLanes({ cards: payload.cards, flows: payload.flows, queueDepth: payload.queueDepth, admissionRefusal: payload.admissionRefusal }) : []),
    [payload],
  );
  const pickView = useCallback((v: ViewMode) => {
    setViewMode(v);
    writeStoredView(v);
  }, []);

  const openCompose = useCallback(() => {
    const hasFlows = (payload?.flows.length ?? 0) > 0;
    setCompose({ ...emptyCompose(), mode: hasFlows ? "card" : "flow", flowPick: payload?.flows[0]?.flowId ?? "" });
    setComposeIssues([]);
    setComposeOpen(true);
    // The persona picker is convenience: when the roster cannot be read the
    // reference is typed by hand rather than blocking card creation.
    void api("GET", "/api/agent/presets")
      .then((d: { presets?: { id: string; name: string }[] }) => {
        setCompose((c) => ({ ...c, presets: d.presets ?? [] }));
      })
      .catch(() => setCompose((c) => ({ ...c, presetsError: true })));
  }, [payload]);

  const submitCompose = useCallback(async () => {
    setComposeBusy(true);
    setComposeIssues([]);
    try {
      if (compose.mode === "flow") {
        const decl = buildFlowDeclaration({
          name: compose.name,
          flowId: compose.flowId || flowSlugFromName(compose.name),
          station: { label: compose.stationLabel, kind: compose.targetKind, ref: compose.targetRef },
        });
        await api("PUT", `/api/flows/${encodeURIComponent(decl.flowId)}`, decl);
      } else {
        // create = arrange only. The card exists and is addressable; nothing is
        // enqueued until someone dispatches it (task-flow-board: "建卡不启跑").
        await api("POST", `/api/flows/${encodeURIComponent(compose.flowPick)}/cards`, {
          prompt: compose.prompt,
          stationId: compose.stationPick || undefined,
        });
      }
      setComposeOpen(false);
      await load({ quiet: true });
    } catch (err) {
      // The server's refusals are structured and already name the field + the
      // legal values — shown verbatim rather than re-worded.
      const e = err as Error & { payload?: { issues?: { field?: string; error?: string }[] } };
      const issues = e.payload?.issues?.map((i) => [i.field, i.error].filter(Boolean).join(": ")) ?? [];
      setComposeIssues(issues.length ? issues : [e.message]);
    } finally {
      setComposeBusy(false);
    }
  }, [compose, load]);

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
    <div
      key={c.id}
      className="cursor-pointer rounded-md border border-border bg-card p-3"
      data-testid="flow-card"
      data-card-id={c.id}
      // Whole card opens the detail; the verb buttons below stop the event so
      // a dispatch click never doubles as "open".
      onClick={() => void openCard(c)}
    >
      <p className="line-clamp-2 text-sm">{c.title || c.prompt}</p>
      {stationLabel ? <p className="mt-1 text-xs text-muted-foreground">{stationLabel}</p> : null}
      {c.blocked ? (
        <p className="mt-1 text-xs text-warning">{t("flows.blockedBy", { names: c.blockedByTitles.join("、") })}</p>
      ) : null}
      {c.error ? <p className="mt-1 line-clamp-2 text-xs text-destructive">{c.error}</p> : null}
      <div className="mt-2 flex flex-wrap gap-1" onClick={(e) => e.stopPropagation()}>
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
      <div className="mb-3 flex justify-end">
        <Button size="sm" onClick={openCompose} data-testid="flow-compose-open">{t("flows.compose.title")}</Button>
      </div>
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
            <div className="flex items-center gap-1" data-testid="flow-view-toggle" aria-label={t("flows.view.toggle")}>
              <Button size="sm" variant={view === "single" ? "outline" : "ghost"} onClick={() => pickView("single")} data-testid="flow-view-single">
                {t("flows.view.single")}
              </Button>
              <Button size="sm" variant={view === "lanes" ? "outline" : "ghost"} onClick={() => pickView("lanes")} data-testid="flow-view-lanes">
                {t("flows.view.lanes")}
              </Button>
            </div>
            {board.admissionRefusal ? (
              <span className="text-warning">{board.admissionRefusal.message}</span>
            ) : null}
            {/* The withheld count explains a shorter board. It is not rendered at
                zero: a line that is always there stops being read. */}
            {unscopedNotice(payload?.unscoped) !== null ? (
              <span data-testid="flow-unscoped">{t("flows.unscoped", { count: unscopedNotice(payload?.unscoped) })}</span>
            ) : null}
          </div>

          {payload?.cards.length === 0 ? (
            <EmptyState title={t("flows.empty.title")} hint={t("flows.empty.hint")} />
          ) : view === "lanes" ? (
            <div className="space-y-3" data-testid="flow-lanes">
              {lanes.map((lane) => (
                <section key={lane.key} className="rounded-md border border-border p-2" data-testid="flow-lane" data-lane-key={lane.key}>
                  <h3 className="mb-2 text-xs font-medium text-muted-foreground">{lane.label}</h3>
                  <div className="grid gap-3 md:grid-cols-5">
                    {COLUMNS_ORDER.map((col) => (
                      <div key={col} className="rounded-md bg-muted/20 p-2">
                        <h4 className="mb-1 text-[11px] text-muted-foreground">{t(`flows.columns.${col}`)}（{lane.board.columns[col].length}）</h4>
                        <div className="space-y-2">
                          {lane.board.columns[col].map((c) => renderCard(c, ""))}
                        </div>
                      </div>
                    ))}
                  </div>
                  {BYPASS_ORDER.map((g) =>
                    lane.board.bypass[g].length ? (
                      <div key={g} className="mt-2">
                        <h4 className="mb-1 text-[11px] text-muted-foreground">{t(`flows.bypass.${g}`)}（{lane.board.bypass[g].length}）</h4>
                        <div className="grid gap-2 md:grid-cols-4">
                          {lane.board.bypass[g].map((c) => renderCard(c, ""))}
                        </div>
                      </div>
                    ) : null,
                  )}
                </section>
              ))}
            </div>
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

      {/* The card's detail: what it says, and the same four verbs. Read-only
          transcript — this dialog adds no write path of its own. */}
      {/* Compose: declare a minimal flow, or add a card to one. The two modes
          are one dialog because they are one act — arranging work — and the
          form is the only path that makes /flows grow a card at all. */}
      <Dialog open={composeOpen} onOpenChange={(o) => { if (!o) setComposeOpen(false); }}>
        <DialogContent data-testid="flow-compose-dialog">
          <DialogHeader>
            <DialogTitle>{compose.mode === "flow" ? t("flows.compose.flowTitle") : t("flows.compose.cardTitle")}</DialogTitle>
          </DialogHeader>
          <div className="mt-3 space-y-2">
            {compose.mode === "flow" ? (
              <>
                <Label>{t("flows.compose.name")}</Label>
                <Input value={compose.name} onChange={(e) => setCompose((c) => ({ ...c, name: e.target.value }))} data-testid="compose-name" />
                <Label>{t("flows.compose.flowId")}</Label>
                <Input
                  value={compose.flowId}
                  onChange={(e) => setCompose((c) => ({ ...c, flowId: e.target.value }))}
                  placeholder={flowSlugFromName(compose.name)}
                  data-testid="compose-flow-id"
                />
                <Label>{t("flows.compose.stationLabel")}</Label>
                <Input value={compose.stationLabel} onChange={(e) => setCompose((c) => ({ ...c, stationLabel: e.target.value }))} data-testid="compose-station" />
                <Label>{t("flows.compose.targetKind")}</Label>
                <Select value={compose.targetKind} onChange={(e) => setCompose((c) => ({ ...c, targetKind: e.target.value }))} data-testid="compose-kind">
                  <option value="persona">persona</option>
                  <option value="a2a">a2a</option>
                  <option value="cluster">cluster</option>
                  <option value="tool">tool</option>
                </Select>
                <Label>{t("flows.compose.targetRef")}</Label>
                <Input value={compose.targetRef} onChange={(e) => setCompose((c) => ({ ...c, targetRef: e.target.value }))} data-testid="compose-ref" list="compose-preset-list" />
                <datalist id="compose-preset-list">
                  {compose.presets.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </datalist>
                {compose.presetsError ? <p className="text-xs text-warning">{t("flows.compose.noPresets")}</p> : null}
              </>
            ) : (
              <>
                <Label>{t("flows.compose.pickFlow")}</Label>
                <Select value={compose.flowPick} onChange={(e) => setCompose((c) => ({ ...c, flowPick: e.target.value, stationPick: "" }))} data-testid="compose-flow-pick">
                  {(payload?.flows ?? []).map((f) => <option key={f.flowId} value={f.flowId}>{f.name}</option>)}
                </Select>
                <Label>{t("flows.compose.pickStation")}</Label>
                <Select value={compose.stationPick} onChange={(e) => setCompose((c) => ({ ...c, stationPick: e.target.value }))} data-testid="compose-station-pick">
                  <option value="">—</option>
                  {(payload?.flows.find((f) => f.flowId === compose.flowPick)?.stations ?? []).map((s) => (
                    <option key={s.stationId} value={s.stationId}>{s.label ?? s.stationId}</option>
                  ))}
                </Select>
                <Label>{t("flows.compose.cardPrompt")}</Label>
                <Textarea value={compose.prompt} onChange={(e) => setCompose((c) => ({ ...c, prompt: e.target.value }))} data-testid="compose-prompt" />
              </>
            )}
            {composeIssues.length ? (
              <ul className="space-y-1 text-xs text-destructive" data-testid="compose-issues">
                {composeIssues.map((m) => <li key={m}>{m}</li>)}
              </ul>
            ) : null}
          </div>
          <DialogFooter className="mt-4">
            <Button variant="outline" size="sm" onClick={() => setComposeOpen(false)}>{t("flows.compose.cancel")}</Button>
            <Button size="sm" disabled={composeBusy} onClick={() => void submitCompose()} data-testid="compose-submit">
              {compose.mode === "flow" ? t("flows.compose.submitFlow") : t("flows.compose.submitCard")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={opened !== null} onOpenChange={(o) => { if (!o) setOpened(null); }}>
        {opened ? (
          <DialogContent data-testid="flow-card-dialog">
            <DialogHeader>
              <DialogTitle>{opened.title || opened.prompt}</DialogTitle>
              <DialogDescription>
                {[stationLabelOf(opened), t(`flows.columns.${columnOf(opened) as BoardColumn}`)].filter(Boolean).join(" · ")}
              </DialogDescription>
            </DialogHeader>

            <h4 className="mt-4 text-xs font-medium text-muted-foreground">{t("flows.card.transcript")}</h4>
            <div className="mt-2 max-h-64 space-y-2 overflow-y-auto rounded-md border border-border p-2" data-testid="flow-card-transcript">
              {transcriptLoading ? <p className="text-xs text-muted-foreground">…</p> : null}
              {!transcriptLoading && transcript?.readError ? (
                <p className="text-xs text-destructive">{t("flows.card.readError")}{transcript.readError}</p>
              ) : null}
              {!transcriptLoading && transcript && !transcript.readError && !transcript.exists ? (
                // Never-dispatched and empty read the same to the server; the copy
                // says which one it is without pretending it failed.
                <p className="text-xs text-muted-foreground">{t("flows.card.empty")}</p>
              ) : null}
              {/* The transcript is immutable per open, so a positional key is
                  stable; a content-derived key would collide on two identical
                  turns. The key is assigned when the payload lands. */}
              {transcript?.messages.map((m) => (
                <div key={m.key} className={m.role === "user" ? "text-xs" : "text-xs text-muted-foreground"}>
                  <span className="font-medium">{m.role === "user" ? "▸" : "◂"}</span> {m.content}
                </div>
              ))}
            </div>

            <DialogFooter className="mt-4">
              <Button variant="outline" size="sm" onClick={() => setOpened(null)}>{t("flows.card.close")}</Button>
            </DialogFooter>
          </DialogContent>
        ) : null}
      </Dialog>
    </PageShell>
  );
}
