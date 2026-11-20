// Console block renderers (add-pack-console) — the ONE implementation both
// hosts use. The facet SPA reaches this file through its `@` alias onto
// web/src (the same arrangement components/packs already rides), so there is
// no second copy to drift.
//
// Contract this file keeps:
//   · colors come from the status vocabulary only (StatusPill), never a raw
//     hue — `scripts/design-lint.mjs` ratchets that debt to zero;
//   · every absent block renders the SAME honest empty state with the reason's
//     own copy — never a zero, never a skeleton that pretends to load;
//   · an unknown block id (a declaration from a newer validator) degrades in
//     place; it never takes the page down;
//   · copy arrives through i18n (`console.*`), never hardcoded here.

import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/states-kit";
import { StatusPill } from "@/components/ui/status-pill";
import {
  MEMBER_STATUS_KIND,
  type ConsoleBlockView,
  type ConsoleDecisionsData,
  type ConsoleKpiData,
  type ConsoleOrchestrationData,
  type ConsoleSpendData,
  type ConsoleStreamData,
  type ConsoleTeamData,
  type ConsoleViewModel,
} from "@/components/console/console-types";

// A renderer receives the block and narrows `data` itself. No generics: a new
type BlockRenderer = (props: { block: ConsoleBlockView }) => ReactNode;

function num(value: number | null | undefined, locale: string): string {
  return typeof value === "number" && Number.isFinite(value) ? new Intl.NumberFormat(locale).format(value) : "—";
}

function money(value: number | null | undefined, locale: string): string {
  // Honest absence: an unpriced window stays an em dash, never a fabricated 0.
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat(locale, { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(value);
}

function time(value: number | null | undefined, locale: string): string {
  if (typeof value !== "number" || !value) return "—";
  return new Date(value).toLocaleString(locale, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

// ── team ────────────────────────────────────────────────────────────────────
function TeamBlock({ block }: { block: ConsoleBlockView }) {
  const { t, i18n } = useTranslation();
  const data = block.data as ConsoleTeamData;
  const rows = data.members ?? [];
  return (
    <ul className="divide-y divide-border/60" data-testid="console-block-team">
      {rows.map((m) => {
        const kind = MEMBER_STATUS_KIND[m.status] ?? "neutral";
        const statusLabel = t(`fleets.status.${m.status}`, { defaultValue: m.status });
        return (
          <li key={m.id} className="flex items-center justify-between gap-3 py-2 first:pt-0 last:pb-0">
            <div className="min-w-0">
              <div className="truncate text-sm font-medium text-foreground">{m.title}</div>
              <div className="truncate text-xs text-muted-foreground">
                {t("console.team.lastReport")} {time(m.latestReportAt, i18n.language)}
              </div>
            </div>
            <StatusPill status={kind} label={statusLabel} />
          </li>
        );
      })}
    </ul>
  );
}

// ── stream ──────────────────────────────────────────────────────────────────
function StreamBlock({ block }: { block: ConsoleBlockView }) {
  const { t, i18n } = useTranslation();
  const data = block.data as ConsoleStreamData;
  return (
    <ul className="space-y-3" data-testid="console-block-stream">
      {data.entries.map((e) => (
        <li key={e.memberId} className="border-l border-border pl-3">
          <div className="flex items-baseline justify-between gap-3">
            <span className="truncate text-sm font-medium text-foreground">{e.title}</span>
            <span className="shrink-0 text-xs text-muted-foreground">{time(e.report?.at, i18n.language)}</span>
          </div>
          <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
            {e.report?.summary?.trim() ? e.report.summary : t("console.stream.noSummary")}
          </p>
        </li>
      ))}
    </ul>
  );
}

// ── kpi ─────────────────────────────────────────────────────────────────────
function KpiBlock({ block }: { block: ConsoleBlockView }) {
  const { i18n } = useTranslation();
  const data = block.data as ConsoleKpiData;
  return (
    <div className="grid gap-3 sm:grid-cols-2" data-testid="console-block-kpi">
      {data.slots.map((slot) => {
        // A slot reported by several posts shows the sum of the reported values
        // (the KPI wall's reading) plus how many posts contributed — never an
        // average, which would hide a silent post inside a plausible number.
        const numeric = slot.posts.every((p) => typeof p.value === "number");
        const total = numeric ? slot.posts.reduce((acc, p) => acc + Number(p.value), 0) : null;
        const latestTrend = slot.posts.find((p) => typeof p.trend === "number")?.trend ?? null;
        return (
          <div key={slot.key} className="rounded-md border border-border/70 p-3">
            <div className="text-xs text-muted-foreground">{slot.label}</div>
            <div className="mt-1 flex items-baseline gap-2">
              <span className="text-xl font-semibold tabular-nums text-foreground">
                {numeric ? num(total, i18n.language) : String(slot.posts[0]?.value ?? "—")}
                {slot.unit ? <span className="ml-1 text-xs font-normal text-muted-foreground">{slot.unit}</span> : null}
              </span>
              {latestTrend != null ? (
                <span className={latestTrend >= 0 ? "text-xs text-status-running" : "text-xs text-status-failed"}>
                  {latestTrend >= 0 ? "▲" : "▼"} {Math.abs(latestTrend)}%
                </span>
              ) : null}
            </div>
            <div className="mt-1 text-[11px] text-muted-foreground">
              {slot.posts.length}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── decisions ───────────────────────────────────────────────────────────────
function DecisionsBlock({ block }: { block: ConsoleBlockView }) {
  const { t, i18n } = useTranslation();
  const data = block.data as ConsoleDecisionsData;
  return (
    <ul className="divide-y divide-border/60" data-testid="console-block-decisions">
      {data.items.map((item) => (
        <li key={item.id} className="flex items-start justify-between gap-3 py-2 first:pt-0 last:pb-0">
          <div className="min-w-0">
            <div className="truncate text-sm text-foreground">{item.summary ?? t("console.decisions.untitled")}</div>
            <div className="mt-0.5 truncate text-xs text-muted-foreground">
              {item.memberTitle ?? "—"} · {t("console.decisions.expires")} {time(item.expiresAt, i18n.language)}
            </div>
          </div>
          <StatusPill
            status={item.severity === "high" ? "failed" : item.severity === "low" ? "neutral" : "waiting"}
            label={t(`console.decisions.severity.${item.severity}`, { defaultValue: item.severity })}
          />
        </li>
      ))}
    </ul>
  );
}

// ── spend ───────────────────────────────────────────────────────────────────
function SpendBlock({ block }: { block: ConsoleBlockView }) {
  const { t, i18n } = useTranslation();
  const d = block.data as ConsoleSpendData;
  const cells = [
    { key: "runs", label: t("console.spend.rounds"), value: num(d.runs, i18n.language) },
    { key: "turns", label: t("console.spend.turns"), value: num(d.turns, i18n.language) },
    { key: "cost", label: t("console.spend.cost"), value: money(d.costUsd, i18n.language) },
    { key: "priced", label: t("console.spend.pricedTurns"), value: num(d.pricedTurns, i18n.language) },
  ];
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4" data-testid="console-block-spend">
      {cells.map((c) => (
        <div key={c.key} className="rounded-md border border-border/70 p-3">
          <div className="text-xs text-muted-foreground">{c.label}</div>
          <div className="mt-1 text-lg font-semibold tabular-nums text-foreground">{c.value}</div>
        </div>
      ))}
    </div>
  );
}

// ── orchestration ───────────────────────────────────────────────────────────
function OrchestrationBlock({ block }: { block: ConsoleBlockView }) {
  const { t } = useTranslation();
  const data = block.data as ConsoleOrchestrationData;
  const edges = data.expanded ?? [];
  const declaredCount = data.declared?.edges?.length ?? 0;
  // Keyed by CONTENT, not by position: an index key makes React reuse a chip's
  // DOM for a different edge when the graph re-orders (stale/derived flags flip),
  // and the same edge can legitimately appear twice. Dedupe on the same string we
  // key by, so the list is both stable and free of duplicate chips.
  const seen = new Set<string>();
  const chips = edges
    .map((e) => ({ edge: e, key: `${e.from}\u0000${e.to}\u0000${e.kind ?? ""}\u0000${e.derived ? 1 : 0}` }))
    .filter(({ key }) => (seen.has(key) ? false : (seen.add(key), true)));
  return (
    <div className="space-y-2" data-testid="console-block-orchestration">
      <p className="text-xs text-muted-foreground">
        {t("console.orchestration.summary", { declared: declaredCount, total: edges.length })}
      </p>
      <ul className="flex flex-wrap gap-2">
        {chips.map(({ edge: e, key }) => (
          <li
            key={key}
            className="rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground"
          >
            {e.kind ?? "—"}
            {e.derived ? ` · ${t("console.orchestration.derived")}` : ""}
          </li>
        ))}
      </ul>
    </div>
  );
}

const RENDERERS: Record<string, BlockRenderer> = {
  team: TeamBlock,
  stream: StreamBlock,
  kpi: KpiBlock,
  decisions: DecisionsBlock,
  spend: SpendBlock,
  orchestration: OrchestrationBlock,
};

const BLOCK_TITLE_KEY: Record<string, string> = {
  team: "console.block.team",
  stream: "console.block.stream",
  kpi: "console.block.kpi",
  decisions: "console.block.decisions",
  spend: "console.block.spend",
  orchestration: "console.block.orchestration",
};

/** One block: title + renderer, or the honest empty state with its reason. */
export function ConsoleBlock({ block }: { block: ConsoleBlockView }) {
  const { t } = useTranslation();
  const titleKey = BLOCK_TITLE_KEY[block.block];
  const title = titleKey ? t(titleKey) : t("console.block.unknown");

  if (block.state === "absent") {
    const reasonKey = `console.absent.${block.absentReason ?? "unknown"}`;
    return (
      <Card title={title} data-testid={`console-card-${block.block}`}>
        <EmptyState title={t(reasonKey, { defaultValue: t("console.absent.unknown") })} />
      </Card>
    );
  }

  const Renderer = RENDERERS[block.block];
  if (!Renderer) {
    // A declaration from a newer validator: say so in place, keep the page.
    return (
      <Card title={title} data-testid={`console-card-${block.block}`}>
        <p className="text-xs text-muted-foreground">{t("console.block.needsNewerClient")}</p>
      </Card>
    );
  }

  return (
    <Card title={title} data-testid={`console-card-${block.block}`}>
      <Renderer block={block} />
    </Card>
  );
}

/** The whole console body: headline strip + the declared blocks in order. */
export function ConsoleBody({ view }: { view: ConsoleViewModel }) {
  const { i18n } = useTranslation();
  const headline = view.headline?.value;
  return (
    <div className="space-y-3" data-testid="console-body">
      {headline != null ? (
        <div className="flex items-baseline gap-2">
          <span className="text-2xl font-semibold tabular-nums text-foreground">{String(headline)}</span>
          <span className="text-xs text-muted-foreground">{view.headline?.field}</span>
        </div>
      ) : null}
      {view.blocks.length === 0 ? (
        <EmptyState title="" hint={undefined} />
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {view.blocks.map((block) => (
            <ConsoleBlock key={block.block} block={block} />
          ))}
        </div>
      )}
      <p className="pt-1 text-[11px] text-muted-foreground">
        {new Date(view.sampledAt).toLocaleString(i18n.language)}
      </p>
    </div>
  );
}
