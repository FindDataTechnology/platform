// FleetPage.tsx — desktop Wanxing fleet console (spec: desktop-fleet-console).
//
// Two read zones over the cell's proxy lane (no new desktop credentials):
//   - local fleet: the seat runner's live snapshot (agents five-state, ports,
//     versions, memory footprint), polled
//   - market catalog: the public registry's a2a directory, read-only
// Deploys stay disabled until the device-management plane (slice ③) makes
// this seat a legal deploy target — the button says so instead of failing.

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

interface LiveAgent {
  key: string;
  path: string | null;
  port: number | null;
  state: string;
  version: number | null;
}

interface LiveSnapshot {
  ok: boolean;
  agents: LiveAgent[];
  children: number;
  queued: number;
  budget: number;
  budgetMb: number;
}

interface CatalogAgent {
  path: string | null;
  name: string | null;
  description: string | null;
  version: string | null;
  tags: string[];
}

const STATE_STYLES: Record<string, string> = {
  serving: "bg-primary/15 text-primary",
  resident: "bg-success/15 text-success",
  starting: "bg-warning/15 text-warning",
  draining: "bg-muted text-muted-foreground",
  paused: "bg-muted text-muted-foreground",
  warm: "bg-muted/60 text-muted-foreground",
};

const POLL_MS = 10_000;

export function FleetPage() {
  const { t } = useTranslation();
  const [live, setLive] = useState<LiveSnapshot | null>(null);
  const [liveCode, setLiveCode] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<CatalogAgent[] | null>(null);
  const [catalogCode, setCatalogCode] = useState<string | null>(null);

  const loadLive = useCallback(async () => {
    try {
      const r = await fetch("/api/wanxing/fleet/live");
      if (r.ok) {
        setLive(await r.json());
        setLiveCode(null);
      } else {
        setLive(null);
        setLiveCode((await r.json().catch(() => ({}))).error || "runner_not_running");
      }
    } catch {
      setLive(null);
      setLiveCode("runner_not_running");
    }
  }, []);

  const loadCatalog = useCallback(async () => {
    try {
      const r = await fetch("/api/wanxing/fleet/catalog");
      if (r.ok) {
        setCatalog((await r.json()).agents ?? []);
        setCatalogCode(null);
      } else {
        setCatalog(null);
        setCatalogCode((await r.json().catch(() => ({}))).error || "registry_unreachable");
      }
    } catch {
      setCatalog(null);
      setCatalogCode("registry_unreachable");
    }
  }, []);

  useEffect(() => {
    void loadLive();
    void loadCatalog();
    const id = setInterval(() => void loadLive(), POLL_MS);
    return () => clearInterval(id);
  }, [loadLive, loadCatalog]);

  const budgetPct = live && live.budgetMb > 0 ? Math.min(100, Math.round((live.budget / live.budgetMb) * 100)) : 0;

  return (
    <div className="flex h-full flex-col bg-background" data-testid="fleet-page">
      <div className="border-b border-border px-6 py-4">
        <h1 className="text-lg font-semibold">{t("fleet.title")}</h1>
      </div>

      <div className="flex-1 space-y-6 overflow-auto p-6">
        {/* Local fleet zone */}
        <section data-testid="fleet-live">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-foreground">{t("fleet.live.title")}</h2>
            {live && (
              <span className="text-xs text-muted-foreground" data-testid="fleet-live-summary">
                {t("fleet.live.summary", { agents: live.agents.length, children: live.children })}
              </span>
            )}
          </div>

          {liveCode ? (
            <div
              className="flex h-28 flex-col items-center justify-center gap-1 rounded-md border border-dashed border-border text-sm text-muted-foreground"
              data-testid="fleet-live-guide"
            >
              <span>{t(`fleet.live.guide.${liveCode === "runner_not_running" ? "notRunning" : "error"}`)}</span>
              <span className="text-xs">{t("fleet.live.guide.howToEnable")}</span>
            </div>
          ) : live ? (
            <>
              <div className="mb-2 flex items-center gap-2" data-testid="fleet-budget">
                <span className="text-xs text-muted-foreground">{t("fleet.live.budget")}</span>
                <div className="h-1.5 w-40 overflow-hidden rounded-full bg-muted">
                  <div className="h-full rounded-full bg-primary/70" style={{ width: `${budgetPct}%` }} />
                </div>
                <span className="text-xs text-muted-foreground">{live.budget} / {live.budgetMb} MB</span>
              </div>
              {live.agents.length === 0 ? (
                <div className="flex h-24 items-center justify-center rounded-md border border-dashed border-border text-sm text-muted-foreground" data-testid="fleet-live-empty">
                  {t("fleet.live.empty")}
                </div>
              ) : (
                <div className="overflow-hidden rounded-md border border-border" data-testid="fleet-agents-table">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border bg-muted/40 text-left text-xs text-muted-foreground">
                        <th className="px-3 py-2 font-medium">{t("fleet.live.agent")}</th>
                        <th className="px-3 py-2 font-medium">{t("fleet.live.state")}</th>
                        <th className="px-3 py-2 font-medium">{t("fleet.live.version")}</th>
                        <th className="px-3 py-2 font-medium">{t("fleet.live.port")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {live.agents.map((a) => (
                        <tr key={a.key} className="border-b border-border/60 last:border-0" data-testid="fleet-agent-row">
                          <td className="max-w-[320px] truncate px-3 py-2" title={a.path ?? a.key}>{a.key}</td>
                          <td className="px-3 py-2">
                            <span className={`rounded-full px-2 py-0.5 text-xs ${STATE_STYLES[a.state] ?? "bg-muted text-muted-foreground"}`}>
                              {t(`fleet.live.states.${a.state}`, a.state)}
                            </span>
                          </td>
                          <td className="px-3 py-2 text-muted-foreground">{a.version ?? "—"}</td>
                          <td className="px-3 py-2 text-muted-foreground">{a.port ?? "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          ) : (
            <div className="flex h-24 items-center justify-center text-sm text-muted-foreground">{t("fleet.live.loading")}</div>
          )}
        </section>

        {/* Market catalog zone */}
        <section data-testid="fleet-catalog">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-foreground">{t("fleet.catalog.title")}</h2>
            <button
              className="rounded-md border border-border px-2.5 py-1 text-xs hover:bg-muted"
              onClick={() => void loadCatalog()}
              data-testid="fleet-catalog-refresh"
            >
              {t("fleet.catalog.refresh")}
            </button>
          </div>

          {catalogCode ? (
            <div className="flex h-24 items-center justify-center rounded-md border border-dashed border-border text-sm text-muted-foreground" data-testid="fleet-catalog-guide">
              {t(`fleet.catalog.guide.${catalogCode === "registry_not_configured" ? "notConfigured" : "unreachable"}`)}
            </div>
          ) : catalog === null ? (
            <div className="flex h-24 items-center justify-center text-sm text-muted-foreground">{t("fleet.live.loading")}</div>
          ) : catalog.length === 0 ? (
            <div className="flex h-24 items-center justify-center rounded-md border border-dashed border-border text-sm text-muted-foreground" data-testid="fleet-catalog-empty">
              {t("fleet.catalog.empty")}
            </div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" data-testid="fleet-catalog-grid">
              {catalog.map((a) => (
                <div key={a.path ?? a.name} className="rounded-md border border-border bg-card p-3" data-testid="fleet-catalog-card">
                  <div className="flex items-start justify-between gap-2">
                    <span className="min-w-0 truncate text-sm font-medium" title={a.name ?? ""}>{a.name ?? a.path}</span>
                    {a.version ? <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">v{a.version}</span> : null}
                  </div>
                  {a.description ? <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{a.description}</p> : null}
                  {a.tags.length > 0 ? (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {a.tags.slice(0, 4).map((tag) => (
                        <span key={tag} className="rounded-full bg-primary/10 px-2 py-0.5 text-xs text-primary/80">{tag}</span>
                      ))}
                    </div>
                  ) : null}
                  <button
                    disabled
                    title={t("fleet.catalog.deployPending")}
                    className="mt-3 w-full cursor-not-allowed rounded-md border border-border px-2 py-1 text-xs text-muted-foreground opacity-60"
                    data-testid="fleet-catalog-deploy"
                  >
                    {t("fleet.catalog.deploy")}
                  </button>
                </div>
              ))}
            </div>
          )}
          <p className="mt-2 text-xs text-muted-foreground">{t("fleet.catalog.deployNote")}</p>
        </section>
      </div>
    </div>
  );
}
