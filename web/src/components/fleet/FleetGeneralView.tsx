// FleetGeneralView — 普通人视图 (agent-as-employee-model 5.5)
//
// 读 /api/fleets/:id/views/general：报告、进度、困难、成本、成果、约定六块。
// 取不到的字段显示「未取得」+ 原因，不渲染 0 或空列表冒充。
// 逐回合明细不在这里：「查看详细记录」跳到专业视图（原始 JSON）。

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

type Unavailable = { unavailable: "undeclared" | "source_unavailable" | "forbidden"; detail?: string };
type Field<T> = T | Unavailable;
type View = {
  reports: Field<{ memberId: string; summary: string; at: number }[]>;
  progress: Field<{ recentTurns: number; byStatus: Record<string, number> }>;
  difficulties: Field<{ memberId: string; text: string }[]>;
  cost: Field<{ window: string; usd: number; turns: number }>;
  outcomes: Field<{ memberId: string; metrics: Record<string, unknown> }[]>;
  commitments: Field<{ id: string; title: string | null; expiresAt: number | null }[]>;
};

const isUn = (v: unknown): v is Unavailable => !!v && typeof v === "object" && "unavailable" in (v as object);

function Missing({ v }: { v: Unavailable }) {
  const { t } = useTranslation();
  return (
    <span className="text-muted-foreground text-sm" data-testid="view-unavailable">
      {t("fleets.generalView.unavailable")}：{t(`fleets.generalView.reason.${v.unavailable}`)}
    </span>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <div className="text-xs font-medium text-muted-foreground">{title}</div>
      <div className="text-sm">{children}</div>
    </div>
  );
}

export function FleetGeneralView({ fleetId }: { fleetId: string }) {
  const { t } = useTranslation();
  const [view, setView] = useState<View | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [raw, setRaw] = useState<unknown>(null);

  useEffect(() => {
    let alive = true;
    fetch(`/api/fleets/${encodeURIComponent(fleetId)}/views/general`)
      .then(async (r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((v) => alive && setView(v))
      .catch((e) => alive && setError(String(e?.message || e)));
    return () => { alive = false; };
  }, [fleetId]);

  const openDetail = () =>
    fetch(`/api/fleets/${encodeURIComponent(fleetId)}/views/professional`)
      .then((r) => r.json())
      .then(setRaw)
      .catch((e) => setRaw({ error: String(e?.message || e) }));

  if (error) return <Card className="p-3 text-sm text-destructive" data-testid="general-view-error">{t("fleets.generalView.loadFailed")}：{error}</Card>;
  if (!view) return null;

  return (
    <Card className="p-3 space-y-3" data-testid="general-view">
      <div className="flex items-center justify-between">
        <div className="font-medium">{t("fleets.generalView.title")}</div>
        <Button variant="ghost" size="sm" onClick={openDetail} data-testid="general-view-detail">
          {t("fleets.generalView.detail")}
        </Button>
      </div>
      <div className="grid gap-3 md:grid-cols-3">
        <Section title={t("fleets.generalView.cost")}>
          {isUn(view.cost) ? <Missing v={view.cost} /> : `$${view.cost.usd.toFixed(2)} / ${view.cost.window}`}
        </Section>
        <Section title={t("fleets.generalView.progress")}>
          {isUn(view.progress) ? <Missing v={view.progress} /> : Object.entries(view.progress.byStatus).map(([k, n]) => `${k} ${n}`).join(" · ") || "—"}
        </Section>
        <Section title={t("fleets.generalView.commitments")}>
          {isUn(view.commitments) ? <Missing v={view.commitments} /> : view.commitments.length
            ? <ul>{view.commitments.map((c) => <li key={c.id}>{c.title ?? c.id}</li>)}</ul> : t("fleets.generalView.none")}
        </Section>
        <Section title={t("fleets.generalView.difficulties")}>
          {isUn(view.difficulties) ? <Missing v={view.difficulties} /> : view.difficulties.length
            ? <ul>{view.difficulties.map((d) => <li key={`${d.memberId}:${d.text}`}>{d.memberId}：{d.text}</li>)}</ul> : t("fleets.generalView.none")}
        </Section>
        <Section title={t("fleets.generalView.outcomes")}>
          {isUn(view.outcomes) ? <Missing v={view.outcomes} /> : <ul>{view.outcomes.map((o) => <li key={o.memberId}>{o.memberId}：{Object.entries(o.metrics).map(([k, v]) => `${k}=${String(v)}`).join(", ")}</li>)}</ul>}
        </Section>
        <Section title={t("fleets.generalView.reports")}>
          {isUn(view.reports) ? <Missing v={view.reports} /> : view.reports.length
            ? <ul>{view.reports.slice(0, 5).map((r) => <li key={r.memberId}>{r.memberId}：{r.summary}</li>)}</ul> : t("fleets.generalView.none")}
        </Section>
      </div>
      {raw ? <pre className="max-h-64 overflow-auto text-xs bg-muted p-2 rounded" data-testid="professional-raw">{JSON.stringify(raw, null, 2)}</pre> : null}
    </Card>
  );
}
