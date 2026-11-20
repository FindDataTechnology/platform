// FleetsView — the facet's own fleet organization surface (facet-owns-its-fleets
// 3.2). Reads and writes the facet's own `/api/fleets*` (no platform proxy).
//
// Two panes: the fleet list (left) and one fleet's organization detail
// (right). The detail reuses the SHARED `ConsoleBody` renderer over the facet
// console view model, so a team's organization renders identically on both
// hosts; the owner-side management actions (rename, pause, cadence edit,
// publish, answer a decision) live in this file and nowhere else.
//
// Organization only: there is no start, no dispatch, no turn. A post's status
// is "no executor attached" — the view model's `executor: null` is rendered
// explicitly, never as a running state.

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ConsoleBody } from "@/components/console/ConsoleBody";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState, ErrorState, SkeletonList } from "@/components/ui/states-kit";
import { StatusPill } from "@/components/ui/status-pill";
import type { ConsoleViewModel } from "@/components/console/console-types";

interface FleetSummary {
  id: string;
  name: string;
  state: string;
  origin: "facet" | "platform";
  consoleSlug?: string | null;
}

interface FleetDetailPayload {
  fleet: FleetSummary;
  executor: null;
  members: Array<{ id: string; title: string; cadence: unknown; kpiSlots: unknown[]; harness: string | null }>;
  edges: Array<{ id: string; kind: string; from: string; to: string }>;
  decisions: Array<{ id: string; question: string; severity: string; state: string }>;
}

const STATE_KIND: Record<string, "running" | "paused" | "neutral"> = {
  active: "running",
  paused: "paused",
  archived: "neutral",
};

export function FleetsView({ initialFleetId = null }: { initialFleetId?: string | null } = {}) {
  const { t } = useTranslation();
  const [fleets, setFleets] = useState<FleetSummary[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(initialFleetId);
  const [detail, setDetail] = useState<FleetDetailPayload | null>(null);
  const [consoleView, setConsoleView] = useState<ConsoleViewModel | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadList = useCallback(async () => {
    setListError(null);
    try {
      const r = await fetch("/api/fleets");
      if (r.status === 401) {
        setListError("forbidden");
        return;
      }
      if (!r.ok) {
        setListError("unavailable");
        return;
      }
      const body = (await r.json()) as { fleets: FleetSummary[] };
      setFleets(body.fleets ?? []);
      setSelected((cur) => cur ?? body.fleets?.[0]?.id ?? null);
    } catch {
      setListError("unavailable");
    }
  }, []);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  const loadDetail = useCallback(async (id: string) => {
    setDetailError(null);
    setDetail(null);
    setConsoleView(null);
    try {
      const [detailRes, consoleRes] = await Promise.all([
        fetch(`/api/fleets/${encodeURIComponent(id)}`),
        fetch(`/api/fleets/${encodeURIComponent(id)}/console?surface=platform`),
      ]);
      if (!detailRes.ok) {
        setDetailError(detailRes.status === 401 ? "forbidden" : "unavailable");
        return;
      }
      const d = (await detailRes.json()) as FleetDetailPayload;
      setDetail(d);
      if (consoleRes.ok) setConsoleView((await consoleRes.json()) as ConsoleViewModel);
    } catch {
      setDetailError("unavailable");
    }
  }, []);

  useEffect(() => {
    if (selected) void loadDetail(selected);
  }, [selected, loadDetail]);

  const createFleet = async () => {
    setBusy(true);
    try {
      const r = await fetch("/api/fleets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: t("facetFleets.newFleetName") }),
      });
      const body = await r.json().catch(() => ({}));
      if (r.ok && body.fleet?.id) {
        await loadList();
        setSelected(body.fleet.id);
      }
    } finally {
      setBusy(false);
    }
  };

  // PATCH a fleet row; a 409 is the platform-origin gate — surface its reason.
  const patchFleet = async (id: string, updates: Record<string, unknown>) => {
    setBusy(true);
    try {
      const r = await fetch(`/api/fleets/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(updates),
      });
      const body = await r.json().catch(() => ({}));
      if (r.status === 409) {
        setDetailError(body.error ?? "readonly");
        return;
      }
      if (r.ok) {
        await loadList();
        await loadDetail(id);
      }
    } finally {
      setBusy(false);
    }
  };

  if (listError === "forbidden") {
    return <EmptyState title={t("console.states.forbidden")} />;
  }
  if (listError === "unavailable") {
    return <ErrorState message={t("console.states.unavailable")} onRetry={loadList} retryLabel={t("common.retry")} />;
  }
  if (fleets === null) return <SkeletonList rows={4} />;

  return (
    <div className="grid gap-4 lg:grid-cols-[18rem_1fr]" data-testid="facet-fleets-view">
      <Card
        title={t("facetFleets.title")}
        actions={
          <Button size="xs" onClick={() => void createFleet()} disabled={busy} data-testid="facet-fleets-create">
            {t("facetFleets.create")}
          </Button>
        }
      >
        {fleets.length === 0 ? (
          <EmptyState title={t("facetFleets.empty")} />
        ) : (
          <ul className="space-y-1" data-testid="facet-fleets-list">
            {fleets.map((f) => (
              <li key={f.id}>
                <button
                  type="button"
                  onClick={() => setSelected(f.id)}
                  aria-current={selected === f.id ? "true" : undefined}
                  data-testid={`facet-fleet-row-${f.id}`}
                  className={`flex w-full items-center justify-between gap-2 rounded-md px-2 py-2 text-left text-sm transition-colors ${
                    selected === f.id ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/60"
                  }`}
                >
                  <span className="min-w-0 truncate">{f.name}</span>
                  <span className="shrink-0 text-[11px] text-muted-foreground">{t(`facetFleets.origin.${f.origin}`)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <div className="space-y-4" data-testid="facet-fleet-detail">
        {!selected ? (
          <EmptyState title={t("fleetPlane.detail.empty")} />
        ) : detailError ? (
          <ErrorState
            message={detailError === "forbidden" ? t("console.states.forbidden") : detailError}
            onRetry={() => selected && void loadDetail(selected)}
            retryLabel={t("common.retry")}
          />
        ) : !detail ? (
          <SkeletonList rows={3} />
        ) : (
          <>
            <Card
              title={detail.fleet.name}
              actions={
                <div className="flex items-center gap-2">
                  <StatusPill
                    status={STATE_KIND[detail.fleet.state] ?? "neutral"}
                    label={t(`fleets.state.${detail.fleet.state}`, { defaultValue: detail.fleet.state })}
                  />
                  {detail.fleet.origin === "platform" ? (
                    <span className="text-[11px] text-muted-foreground">{t("facetFleets.readonlyPlatform")}</span>
                  ) : (
                    <>
                      <Button
                        size="xs"
                        variant="outline"
                        disabled={busy}
                        onClick={() =>
                          void patchFleet(detail.fleet.id, { state: detail.fleet.state === "active" ? "paused" : "active" })
                        }
                        data-testid="facet-fleet-toggle-state"
                      >
                        {detail.fleet.state === "active" ? t("fleets.ops.pause") : t("fleets.ops.resume")}
                      </Button>
                      <Button
                        size="xs"
                        variant="outline"
                        disabled={busy}
                        onClick={() => void patchFleet(detail.fleet.id, { published: !detail.fleet.consoleSlug })}
                        data-testid="facet-fleet-toggle-publish"
                      >
                        {detail.fleet.consoleSlug ? t("console.publish.unpublish") : t("console.publish.action")}
                      </Button>
                    </>
                  )}
                </div>
              }
            >
              {/* Explicit "no executor attached" (spec: 只管不跑) — never a
                  running state. */}
              <p className="text-xs text-muted-foreground" data-testid="facet-fleet-executor">
                {t("fleetPlane.executor.none")}
              </p>
              {detail.fleet.consoleSlug ? (
                <a
                  className="mt-1 inline-block text-xs text-primary underline-offset-4 hover:underline"
                  href={`/t/${encodeURIComponent(detail.fleet.consoleSlug)}`}
                >
                  {t("fleetPlane.shareLink")}: /t/{detail.fleet.consoleSlug}
                </a>
              ) : null}
            </Card>

            {consoleView ? <ConsoleBody view={consoleView} /> : null}

            <Card title={t("fleetPlane.members.title")}>
              {detail.members.length === 0 ? (
                <EmptyState title={t("console.absent.no_members")} />
              ) : (
                <ul className="divide-y divide-border/60" data-testid="facet-fleet-members">
                  {detail.members.map((m) => (
                    <li key={m.id} className="flex items-center justify-between gap-3 py-2 first:pt-0 last:pb-0">
                      <span className="min-w-0 truncate text-sm text-foreground">{m.title}</span>
                      <span className="shrink-0 text-[11px] text-muted-foreground">
                        {m.harness ? t("fleetPlane.members.harness", { name: m.harness }) : t("fleetPlane.members.noHarness")}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </>
        )}
      </div>
    </div>
  );
}
