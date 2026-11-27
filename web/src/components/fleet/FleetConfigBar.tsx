// Fleet config bar (fleet-config-overview): a horizontal read-only aggregate
// above the canvas — model distribution, effort spread, context-budget usage
// histogram, and the 24h edge traffic heatmap. Every number derives from the
// cockpit aggregate the page already fetched: no new endpoint, no new query,
// and hovering/clicking never writes (纯读面).

import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { KIND_COLORS, type GraphEdge } from "@/lib/fleet-layout";
import type { CanvasTraffic } from "@/components/fleet/FleetCanvas";

export interface ConfigBarMember {
  id: string;
  title: string;
  effectiveModel: string | null;
  effort: string | null;
  contextBudget: number | null;
  latestTurnUsage: { input: number | null; output: number | null } | null;
}

const EFFORT_ORDER = ["low", "medium", "high"] as const;
const BUDGET_BUCKETS = [25, 50, 75, 100] as const;

function usageTotal(u: ConfigBarMember["latestTurnUsage"]): number | null {
  if (!u) return null;
  const input = u.input ?? 0;
  const output = u.output ?? 0;
  if (u.input == null && u.output == null) return null;
  return input + output;
}

export function FleetConfigBar({
  members,
  edges,
  traffic,
}: {
  members: ConfigBarMember[];
  /** Declared orchestration edges, so zero-traffic edges render grayed. */
  edges: GraphEdge[];
  traffic: CanvasTraffic[];
}) {
  const { t } = useTranslation();

  const models = useMemo(() => {
    const groups = new Map<string, number>();
    for (const m of members) {
      const key = m.effectiveModel ?? t("fleets.configBar.unset");
      groups.set(key, (groups.get(key) ?? 0) + 1);
    }
    return [...groups.entries()];
  }, [members, t]);

  const effortDist = useMemo(() => {
    const counts = new Map<string, number>();
    for (const m of members) {
      const key = m.effort ?? "unset";
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  }, [members]);

  const budgetBuckets = useMemo(() => {
    // 0-25, 25-50, 50-75, 75-100, over
    const buckets: [number, number, number, number, number] = [0, 0, 0, 0, 0];
    let excluded = 0;
    let noData = 0;
    for (const m of members) {
      if (!m.contextBudget || m.contextBudget <= 0) {
        excluded += 1;
        continue;
      }
      // consumed = newest real turn's usage; no usage reported ≠ under quota —
      // it is absence, and the histogram counts it honestly in a gray chip.
      const used = usageTotal(m.latestTurnUsage);
      if (used == null) {
        noData += 1;
        continue;
      }
      const pct = (used / m.contextBudget) * 100;
      const idx = pct >= 100 ? 4 : Math.min(3, Math.floor(pct / 25));
      buckets[idx as 0 | 1 | 2 | 3 | 4] += 1;
    }
    return { buckets, excluded, noData };
  }, [members]);

  const edgeRows = useMemo(() => {
    const byKey = new Map<string, CanvasTraffic>();
    for (const tr of traffic) byKey.set(`${tr.from}→${tr.to}:${tr.kind}`, tr);
    const rows: { key: string; from: string; to: string; kind: string; turns: number; ratio: number | null }[] = [];
    for (const e of edges) {
      if (e.kind === "fanout") {
        for (const target of e.targets ?? []) rows.push({ key: `${e.from}→${target}:fanout`, from: e.from ?? "", to: target, kind: "fanout", turns: 0, ratio: null });
      } else if (e.from && e.to) {
        rows.push({ key: `${e.from}→${e.to}:${e.kind}`, from: e.from, to: e.to, kind: e.kind, turns: 0, ratio: null });
      }
    }
    for (const row of rows) {
      const tr = byKey.get(row.key);
      if (tr && tr.turns > 0) {
        row.turns = tr.turns;
        row.ratio = (tr.ok ?? 0) / tr.turns;
      }
    }
    return rows;
  }, [edges, traffic]);

  const heatColor = (ratio: number | null): string => {
    if (ratio == null) return "#94a3b8";
    if (ratio >= 0.9) return "#22c55e";
    if (ratio >= 0.5) return "#f59e0b";
    return "#ef4444";
  };

  if (members.length === 0) return null;

  return (
    <div
      className="mt-1 flex flex-wrap items-stretch gap-3 rounded-md border border-border bg-muted/20 px-3 py-2"
      data-testid="fleet-config-bar"
    >
      {/* Model distribution */}
      <div className="flex min-w-0 flex-col gap-1" data-testid="config-bar-models">
        <span className="text-[10px] font-medium text-muted-foreground">{t("fleets.configBar.models")}</span>
        <div className="flex flex-wrap items-center gap-1">
          {models.map(([model, count]) => (
            <span key={model} className="rounded-full bg-muted px-2 py-px text-[10px]" title={model}>
              <span className="font-medium">{model}</span>
              <span className="ml-1 text-muted-foreground">×{count}</span>
            </span>
          ))}
        </div>
      </div>

      {/* Effort histogram */}
      <div className="flex flex-col gap-1" data-testid="config-bar-effort">
        <span className="text-[10px] font-medium text-muted-foreground">{t("fleets.configBar.effort")}</span>
        <div className="flex items-center gap-1">
          {EFFORT_ORDER.map((level) => {
            const count = effortDist.get(level) ?? 0;
            return (
              <span
                key={level}
                className={`rounded-full px-2 py-px text-[10px] ${count > 0 ? "bg-primary/15 text-primary" : "bg-muted/60 text-muted-foreground/60"}`}
              >
                {t(`fleets.configBar.effortLevel.${level}`)} {count > 0 ? `×${count}` : ""}
              </span>
            );
          })}
          {(effortDist.get("unset") ?? 0) > 0 ? (
            <span className="rounded-full bg-muted px-2 py-px text-[10px] text-muted-foreground">
              {t("fleets.configBar.unset")} ×{effortDist.get("unset")}
            </span>
          ) : null}
        </div>
      </div>

      {/* Context budget histogram */}
      <div className="flex flex-col gap-1" data-testid="config-bar-budget">
        <span className="text-[10px] font-medium text-muted-foreground" title={t("fleets.configBar.budgetHint")}>
          {t("fleets.configBar.budget")}
        </span>
        <div className="flex items-end gap-1">
          {BUDGET_BUCKETS.map((b, i) => {
            const n = budgetBuckets.buckets[i as 0 | 1 | 2 | 3] ?? 0;
            return (
              <span
                key={b}
                className={`rounded px-1.5 py-px text-[10px] ${n > 0 ? "bg-muted" : "bg-muted/40 text-muted-foreground/60"}`}
                title={`0-${b}%`}
              >
                ≤{b}%{n > 0 ? ` ×${n}` : ""}
              </span>
            );
          })}
          <span
            className={`rounded px-1.5 py-px text-[10px] ${budgetBuckets.buckets[4] > 0 ? "bg-destructive/15 text-destructive" : "bg-muted/40 text-muted-foreground/60"}`}
            data-testid="config-bar-budget-over"
          >
            &gt;100%{budgetBuckets.buckets[4] > 0 ? ` ×${budgetBuckets.buckets[4]}` : ""}
          </span>
          {budgetBuckets.noData > 0 ? (
            <span className="rounded bg-muted/60 px-1.5 py-px text-[10px] text-muted-foreground" title={t("fleets.configBar.budgetNoDataHint")}>
              {t("fleets.configBar.budgetNoData")} ×{budgetBuckets.noData}
            </span>
          ) : null}
        </div>
      </div>

      {/* 24h edge traffic heatmap */}
      <div className="flex min-w-0 flex-col gap-1" data-testid="config-bar-traffic">
        <span className="text-[10px] font-medium text-muted-foreground" title={t("fleets.configBar.trafficHint")}>
          {t("fleets.configBar.traffic")}
        </span>
        <div className="flex flex-wrap items-center gap-1">
          {edgeRows.length === 0 ? (
            <span className="text-[10px] text-muted-foreground">{t("fleets.configBar.noTraffic")}</span>
          ) : (
            edgeRows.map((row) => (
              <span
                key={row.key}
                className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-px text-[10px]"
                title={`${row.key}${row.turns > 0 ? ` · ${row.turns} ${t("fleets.configBar.turnsSuffix")}` : ` · ${t("fleets.configBar.trafficNone")}`}`}
              >
                <span className="h-2 w-2 rounded-full" style={{ background: row.turns > 0 ? heatColor(row.ratio) : "#cbd5e1" }} />
                <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: KIND_COLORS[row.kind] ?? "#94a3b8" }} />
                {row.from.slice(-4)}→{row.to.slice(-4)}
              </span>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
