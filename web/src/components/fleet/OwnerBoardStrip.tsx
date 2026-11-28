// OwnerBoardStrip — 主人经营坞总览 (add-fleet-owner-surface A/B/C) +
// 迭代回路面 (add-fleet-owner-iteration)。
//
// 点在 FleetsPage 未选中任何集群时的详情面：集群清单(状态/告警/花销投影)
// + 机位占位行(跨机可见) + 花销(c)账户级粗对账 + 市场行(自己的模板成交记)
// + 新版提示(订阅跟新, 只交通不升级) + 迭代提议(决策车道入队) + digest 订阅
// 开关。每一路数据独立可达, 任一失败如实降级 — 坞面从不把一路的缺席伪装
// 成另一路的一切正常。

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import * as owner from "@/lib/fleet-owner-api";
import type { OwnerBoardFleet, BillingSnapshot, OwnerCellRow, SubUpdate, DigestSub, IterationRow, MemoryFace } from "@/lib/fleet-owner-api";
import * as api from "@/lib/packs-api";
import type { MarketPurchase } from "@/lib/packs-api";
import { Button } from "@/components/ui/button";

const money = (n: number) => `$${n.toFixed(2)}`;

export function OwnerBoardStrip({ onSelect }: { onSelect: (fleetId: string) => void }) {
  const { t } = useTranslation();
  const [board, setBoard] = useState<OwnerBoardFleet[] | null>(null);
  const [boardError, setBoardError] = useState<string | null>(null);
  const [cells, setCells] = useState<OwnerCellRow[] | null>(null);
  const [memory, setMemory] = useState<MemoryFace | null>(null);
  const [billing, setBilling] = useState<BillingSnapshot | null>(null);
  const [billingError, setBillingError] = useState<string | null>(null);
  const [purchases, setPurchases] = useState<MarketPurchase[]>([]);
  const [updates, setUpdates] = useState<SubUpdate[]>([]);
  const [digestSubs, setDigestSubs] = useState<DigestSub[]>([]);
  const [iterationsBy, setIterationsBy] = useState<Record<string, IterationRow[]>>({});
  const [proposalFor, setProposalFor] = useState<string | null>(null);
  const [proposalDraft, setProposalDraft] = useState("");
  const [proposalMsg, setProposalMsg] = useState<string | null>(null);

  const reloadBoard = useCallback(() => {
    owner
      .fetchOwnerBoard()
      .then((r) => setBoard(r.fleets))
      .catch((e) => setBoardError((e as Error).message));
  }, []);
  const reloadDigest = useCallback(() => {
    owner
      .listDigestSubscriptions()
      .then((r) => setDigestSubs(r.subscriptions ?? []))
      .catch(() => {});
  }, []);

  // 内存水位卡 (harden-platform-memory-carrier 3.1): 只读, 随坞面加载 +
  // 60s 轮询 (与 add-cockpit-ops-loop 同拍)。路由缺席 (404, 桌面单机) 或
  // 读取失败 → 卡不渲染, honest absence; 网关答了但计量不可用 → 卡渲染
  // 不可用标记 (spec: 非 Linux 如实降级)。
  const reloadMemory = useCallback(() => {
    owner.fetchMemoryFace().then(setMemory);
  }, []);
  useEffect(() => {
    reloadMemory();
    const timer = setInterval(reloadMemory, 60_000);
    return () => clearInterval(timer);
  }, [reloadMemory]);

  useEffect(() => {
    reloadBoard();
    owner.fetchOwnerCells().then((r) => r && setCells(r.cells));
    owner
      .fetchBillingSnapshot()
      .then(setBilling)
      .catch((e) => setBillingError((e as Error).message));
    api
      .myMarketPurchases()
      .then((r) => setPurchases((r.purchases ?? []).filter((p) => p.status === "settled")))
      .catch(() => {});
    owner
      .subscriptionUpdates()
      .then((r) => setUpdates(r.updates ?? []))
      .catch(() => {});
    reloadDigest();
  }, [reloadDigest, reloadBoard]);

  const marketSpendFor = (packId: string | null | undefined) => {
    if (!packId) return null;
    const rows = purchases.filter((p) => p.packId === packId);
    if (!rows.length) return null;
    return rows.reduce((sum, p) => sum + (p.direction === "refund" ? -p.priceUsd : p.priceUsd), 0);
  };
  const updateFor = (packId: string | null | undefined) =>
    packId ? updates.find((u) => u.packId === packId) ?? null : null;
  const digestFor = (fleetId: string) => digestSubs.filter((s) => s.fleetId === fleetId);

  const toggleDigest = async (fleetId: string, cadence: "daily" | "weekly", active: boolean) => {
    try {
      if (active) await owner.digestUnsubscribe(fleetId, cadence);
      else await owner.digestSubscribe(fleetId, cadence);
      reloadDigest();
    } catch {
      /* 失败如实留在未选中态 */
    }
  };

  const loadIterations = async (fleetId: string) => {
    try {
      const r = await owner.listIterations(fleetId);
      setIterationsBy((m) => ({ ...m, [fleetId]: r.iterations ?? [] }));
    } catch {
      setIterationsBy((m) => ({ ...m, [fleetId]: [] }));
    }
  };

  const submitProposal = async (fleetId: string) => {
    setProposalMsg(null);
    let changes: Record<string, unknown>;
    try {
      changes = JSON.parse(proposalDraft || "{}");
    } catch {
      setProposalMsg(t("fleets.board.proposalInvalidJson"));
      return;
    }
    if (Object.keys(changes ?? {}).length === 0) {
      setProposalMsg(t("fleets.board.proposalEmpty"));
      return;
    }
    try {
      const out = await owner.proposeIteration(fleetId, { summary: proposalDraft.slice(0, 120) || "迭代提议", changes });
      setProposalMsg(t("fleets.board.proposalQueued"));
      setProposalFor(null);
      setProposalDraft("");
      await loadIterations(fleetId);
      void out;
    } catch (e) {
      setProposalMsg((e as Error).message);
    }
  };

  const retryIteration = async (fleetId: string, it: IterationRow) => {
    try {
      await owner.retryIteration(fleetId, it.id);
    } finally {
      loadIterations(fleetId);
    }
  };

  return (
    <section className="space-y-4" data-testid="fleet-owner-board">
      <div className="flex items-center justify-between">
        <h3 className="font-medium">{t("fleets.board.title")}</h3>
      </div>

      {boardError && (
        <p className="text-sm text-destructive" data-testid="fleet-board-error">
          {t("fleets.board.loadError", { error: boardError })}
        </p>
      )}

      {cells && cells.length > 0 && (
        <div className="space-y-1" data-testid="fleet-board-cells">
          {cells.map((c) =>
            c.placeholder ? (
              <div key={c.cellId} className="flex items-center gap-2 rounded-md border border-dashed border-border px-3 py-1.5 text-xs text-muted-foreground" data-testid={`fleet-cell-sleep-${c.cellId}`}>
                <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground" />
                <span className="font-mono">{c.cellId}</span>
                <span>{t("fleets.board.cellSleeping")}</span>
                {c.lastTrafficAt && <span className="ml-auto">{t("fleets.board.cellLastTraffic", { at: new Date(c.lastTrafficAt).toLocaleString() })}</span>}
              </div>
            ) : (
              <div key={c.cellId} className="flex items-center gap-2 px-3 py-1 text-xs text-muted-foreground" data-testid={`fleet-cell-live-${c.cellId}`}>
                <span className="h-1.5 w-1.5 rounded-full bg-primary" />
                <span className="font-mono">{c.cellId}</span>
                <span>{c.state}</span>
              </div>
            ),
          )}
        </div>
      )}

      {memory && (
        <div className="rounded-lg border border-border p-3" data-testid="fleet-board-memory">
          <div className="flex items-center gap-2">
            <h4 className="text-sm font-medium">{t("fleets.board.memoryTitle")}</h4>
            {memory.available && memory.container?.available && memory.container.headroomPct != null && memory.container.limitBytes != null ? (
              memory.container.headroomPct < memory.container.threshold ? (
                <span
                  className="rounded-full bg-status-waiting/15 px-2 py-0.5 text-xs text-status-waiting"
                  title={`${t("fleets.board.memoryLow", {
                    pct: Math.round((1 - memory.container.headroomPct) * 100),
                    thresholdPct: Math.round(memory.container.threshold * 100),
                  })} · used ${Math.round((memory.container.usedBytes ?? 0) / 1048576)}MB / limit ${Math.round(memory.container.limitBytes / 1048576)}MB`}
                  data-testid="fleet-board-memory-low"
                >
                  {t("fleets.board.memoryLow", {
                    pct: Math.round((1 - memory.container.headroomPct) * 100),
                    thresholdPct: Math.round(memory.container.threshold * 100),
                  })}
                </span>
              ) : (
                <span className="text-xs text-muted-foreground" data-testid="fleet-board-memory-ok">
                  {t("fleets.board.memoryHeadroom", { pct: Math.round(memory.container.headroomPct * 100) })}
                </span>
              )
            ) : (
              <span className="text-xs text-muted-foreground" data-testid="fleet-board-memory-unavailable">
                {t("fleets.board.memoryUnavailable")}
              </span>
            )}
          </div>
          {memory.available && memory.container?.available && memory.container.usedBytes != null && memory.container.limitBytes != null && (
            <div className="mt-1.5" data-testid="fleet-board-memory-bar">
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className={`h-full ${memory.container.headroomPct != null && memory.container.headroomPct < memory.container.threshold ? "bg-status-waiting" : "bg-primary"}`}
                  style={{ width: `${Math.min(100, Math.round((memory.container.usedBytes / memory.container.limitBytes) * 100))}%` }}
                />
              </div>
              <p className="mt-0.5 text-[10px] text-muted-foreground">
                {t("fleets.board.memoryUsageLine", {
                  pct: Math.round((memory.container.usedBytes / memory.container.limitBytes) * 100),
                  limitMb: Math.round(memory.container.limitBytes / 1048576),
                })}
              </p>
            </div>
          )}
          {(memory.cells ?? []).map((c) => (
            <div key={c.cellId} className="mt-1 flex items-center gap-2 text-xs text-muted-foreground" data-testid={`fleet-board-memory-cell-${c.cellId}`}>
              <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground" />
              <span className="font-mono">{c.cellId}</span>
              <span>{t("fleets.board.memoryCellLine", { mb: Math.round(c.totalBytes / 1048576), count: c.processes.length })}</span>
            </div>
          ))}
          {memory.browserLane && (
            <div
              className={`mt-1 flex items-center gap-2 text-xs ${
                memory.browserLane.reachable === false ? "text-muted-foreground/40" : "text-muted-foreground"
              }`}
              data-testid="fleet-board-memory-browser-lane"
              title={memory.browserLane.url ?? undefined}
            >
              <span
                className={`h-1.5 w-1.5 rounded-full ${
                  memory.browserLane.reachable === false ? "bg-muted-foreground/30" : "bg-muted-foreground"
                }`}
              />
              <span>
                {t("fleets.board.memoryBrowserLane", {
                  mb: Math.round((memory.browserLane.totalBytes ?? 0) / 1048576),
                })}
              </span>
              {memory.browserLane.reachable === false && (
                <span className="rounded-full bg-muted/40 px-1.5 py-px text-[10px]" data-testid="fleet-board-memory-browser-lane-down">
                  {t("fleets.board.memoryBrowserLaneDown")}
                </span>
              )}
            </div>
          )}
          {memory.available && (memory.ungrouped?.totalBytes ?? 0) > 0 && (
            <p className="mt-1 text-[10px] text-muted-foreground" data-testid="fleet-board-memory-ungrouped">
              {t("fleets.board.memoryUngrouped", { mb: Math.round((memory.ungrouped?.totalBytes ?? 0) / 1048576) })}
            </p>
          )}
        </div>
      )}

      {board && board.length === 0 && (
        <p className="text-sm text-muted-foreground" data-testid="fleet-board-empty">
          {t("fleets.empty")}
        </p>
      )}
      {board && board.length > 0 && (
        <div className="space-y-2">
          {board.map((f) => {
            const marketSpend = marketSpendFor(f.sourceTemplate?.packId);
            const upd = updateFor(f.sourceTemplate?.packId);
            const digest = digestFor(f.id);
            const its = iterationsBy[f.id] ?? [];
            return (
              <button
                key={f.id}
                type="button"
                onClick={() => onSelect(f.id)}
                className="w-full rounded-lg border border-border p-3 text-left hover:border-primary/50"
                data-testid={`fleet-board-row-${f.id}`}
              >
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-medium text-foreground">{f.name}</span>
                  <span className="rounded-full px-2 py-0.5 text-xs bg-muted text-muted-foreground">{t(`fleets.state.${f.state}`)}</span>
                  {f.failing > 0 && (
                    <span className="rounded-full bg-destructive/15 px-2 py-0.5 text-xs text-destructive" data-testid={`fleet-board-failing-${f.id}`}>
                      {t("fleets.board.failingBadge", { count: f.failing })}
                    </span>
                  )}
                  {f.openDecisions > 0 && (
                    <span className="rounded-full bg-primary/15 px-2 py-0.5 text-xs text-primary" data-testid={`fleet-board-decisions-${f.id}`}>
                      {t("fleets.decisions.waitingBadge", { count: f.openDecisions })}
                    </span>
                  )}
                  {upd && (
                    <span className="rounded-full bg-status-waiting/15 px-2 py-0.5 text-xs text-status-waiting" title={upd.notes ?? undefined} data-testid={`fleet-board-update-${f.id}`}>
                      {t("fleets.board.newVersion", { version: upd.latestVersion })}
                    </span>
                  )}
                  <span className="ml-auto text-xs text-muted-foreground">
                    {t("fleets.board.onDutyLine", { on: f.counts.onDuty, total: f.counts.total })}
                  </span>
                </div>
                <div className="mt-1.5 grid grid-cols-3 gap-2 text-xs text-muted-foreground" data-testid={`fleet-board-spend-${f.id}`}>
                  {(["24h", "7d", "30d"] as const).map((w) => {
                    const s = f.spend.windows[w];
                    return (
                      <span key={w}>
                        {w}: {t("fleets.board.turnsLine", { turns: s.turns, runs: s.runs })}
                        {s.usageInput != null && s.usageOutput != null && (
                          <span className="block">tok {s.usageInput}/{s.usageOutput}</span>
                        )}
                      </span>
                    );
                  })}
                  {marketSpend != null && (
                    <span className="text-foreground" data-testid={`fleet-board-market-${f.id}`}>
                      {t("fleets.board.marketSpend", { amount: money(marketSpend) })}
                    </span>
                  )}
                </div>
                <div className="mt-1.5 flex items-center gap-2 text-xs" data-testid={`fleet-board-actions-${f.id}`} onClick={(e) => e.stopPropagation()}>
                  <Button
                    variant={digest.some((d) => d.cadence === "daily") ? "default" : "outline"}
                    size="sm"
                    className="h-6 px-2 text-[11px]"
                    onClick={() => void toggleDigest(f.id, "daily", digest.some((d) => d.cadence === "daily"))}
                    data-testid={`fleet-digest-daily-${f.id}`}
                  >
                    {t("fleets.board.digestDaily")}
                  </Button>
                  <Button
                    variant={digest.some((d) => d.cadence === "weekly") ? "default" : "outline"}
                    size="sm"
                    className="h-6 px-2 text-[11px]"
                    onClick={() => void toggleDigest(f.id, "weekly", digest.some((d) => d.cadence === "weekly"))}
                    data-testid={`fleet-digest-weekly-${f.id}`}
                  >
                    {t("fleets.board.digestWeekly")}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-6 px-2 text-[11px]"
                    onClick={() => setProposalFor(proposalFor === f.id ? null : f.id)}
                    data-testid={`fleet-propose-${f.id}`}
                  >
                    {t("fleets.board.proposeIteration")}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 px-2 text-[11px]"
                    onClick={() => void loadIterations(f.id)}
                    data-testid={`fleet-iterations-${f.id}`}
                  >
                    {t("fleets.board.iterationsBtn")}
                  </Button>
                </div>
                {proposalFor === f.id && (
                  <div className="mt-2 space-y-1.5" data-testid={`fleet-propose-form-${f.id}`} onClick={(e) => e.stopPropagation()}>
                    <textarea
                      className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs"
                      rows={2}
                      placeholder={t("fleets.board.proposalPlaceholder")}
                      value={proposalDraft}
                      onChange={(e) => setProposalDraft(e.target.value)}
                      data-testid={`fleet-propose-draft-${f.id}`}
                    />
                    <div className="flex items-center gap-2">
                      <Button size="sm" className="h-6 px-2 text-[11px]" onClick={() => void submitProposal(f.id)} data-testid={`fleet-propose-submit-${f.id}`}>
                        {t("fleets.board.proposalSubmit")}
                      </Button>
                      {proposalMsg && <span className="text-xs text-muted-foreground">{proposalMsg}</span>}
                    </div>
                  </div>
                )}
                {its.length > 0 && (
                  <ul className="mt-2 space-y-1 text-xs" data-testid={`fleet-iterations-list-${f.id}`}>
                    {its.slice(0, 5).map((it) => (
                      <li key={it.id} className="flex items-center gap-2" data-testid={`fleet-iteration-row-${it.id}`}>
                        <span className={`rounded-full px-2 py-0.5 ${it.state === "published" ? "bg-primary/15 text-primary" : it.state === "failed" ? "bg-destructive/15 text-destructive" : "bg-muted text-muted-foreground"}`}>
                          {it.state}
                          {it.publishedVersion != null ? ` · v${it.publishedVersion}` : ""}
                        </span>
                        {it.axis && <span className="text-destructive">{it.axis}</span>}
                        {it.state === "failed" && (
                          <Button size="sm" variant="outline" className="h-5 px-1.5 text-[10px]" onClick={(e) => { e.stopPropagation(); void retryIteration(f.id, it); }} data-testid={`fleet-iteration-retry-${it.id}`}>
                            {t("fleets.board.retry")}
                          </Button>
                        )}
                        {it.note && <span className="text-muted-foreground truncate max-w-[24rem]">{it.note}</span>}
                      </li>
                    ))}
                  </ul>
                )}
              </button>
            );
          })}
        </div>
      )}

      {/* 花销(c): 账户级粗粒度对账 — 口径随行, 不混加 token。 */}
      <div className="rounded-lg border border-border p-3" data-testid="fleet-board-billing">
        <h4 className="text-sm font-medium">{t("fleets.board.billingTitle")}</h4>
        {billingError && (
          <p className="text-xs text-destructive mt-1" data-testid="fleet-billing-error">
            {t("fleets.board.billingError", { error: billingError })}
          </p>
        )}
        {billing?.linked === false && (
          <p className="text-xs text-muted-foreground mt-1">{t("fleets.board.billingUnlinked")}</p>
        )}
        {billing?.linked && billing.accountState === "ok" && billing.deltas && (
          <div className="mt-1 grid grid-cols-3 gap-2 text-xs text-muted-foreground" data-testid="fleet-billing-deltas">
            {(["24h", "7d", "30d"] as const).map((w) => (
              <span key={w}>
                {w}: {billing.deltas?.[w] ? money(billing.deltas[w].spentUsd) : t("fleets.board.deltaUnknown")}
              </span>
            ))}
          </div>
        )}
        <p className="mt-1.5 text-[10px] text-muted-foreground" data-testid="fleet-billing-basis">
          {billing?.basis}
          {billing?.sampledAt && ` · ${new Date(billing.sampledAt).toLocaleString()}`}
          {billing?.panelUrl && (
            <Button variant="link" className="h-auto p-0 ml-2 text-[10px]" onClick={() => window.open(billing.panelUrl, "_blank", "noopener")} data-testid="fleet-billing-panel">
              {t("packs.detail.connectPanel")}
            </Button>
          )}
        </p>
      </div>
    </section>
  );
}
