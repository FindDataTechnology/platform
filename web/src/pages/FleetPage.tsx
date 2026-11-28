// FleetPage.tsx — desktop Wanxing fleet console (spec: desktop-fleet-console).
//
// Since add-local-fleet-control-plane the page is a MANAGEMENT surface, not a
// read-only projection:
//   - local cluster zone: this seat's live snapshot (agents five-state, ports,
//     versions, memory footprint) + the deployable candidates from installed
//     packs, with deploy / stop / start / remove actions that land on the
//     cell's LOCAL store (never a direct runner call, never a cloud write)
//   - cloud seat zone: the public registry directory as an explicit READ-ONLY
//     bridge — disabled in meaning, not in styling: it deploys nothing.
// Live state stays the only runtime truth (the write response is the landed
// fact; the runner converges on its next poll).

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { IS_DESKTOP } from "@/lib/environment";

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

interface Candidate {
  path: string;
  packId: string;
  agentId: string;
  name: string;
  description: string | null;
  deployed: boolean;
  enabled: boolean;
  // add-unified-fleet-console provenance: `source` is the deployment row's
  // origin (null when not deployed); `desiredEnabled` is the cloud desired
  // state — null when the machine is unpaired or the uplink is off, which is
  // exactly when NO provenance badge may render (spec delta).
  source: "manual" | "cloud" | null;
  desiredEnabled: boolean | null;
}

interface Capacity {
  used: number;
  cap: number;
  unit: string;
  podMode: boolean;
}

interface LocalCatalog {
  source: "local";
  agents: CatalogAgent[];
  candidates: Candidate[];
  capacity: Capacity;
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

type WriteAction = "deploy" | "stop" | "start" | "remove";

export function FleetPage() {
  const { t } = useTranslation();
  const [live, setLive] = useState<LiveSnapshot | null>(null);
  const [liveCode, setLiveCode] = useState<string | null>(null);
  const [local, setLocal] = useState<LocalCatalog | null>(null);
  const [localCode, setLocalCode] = useState<string | null>(null);
  const [cloud, setCloud] = useState<CatalogAgent[] | null>(null);
  const [cloudCode, setCloudCode] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<{ code: string; used?: number; cap?: number } | null>(null);

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

  const loadLocal = useCallback(async () => {
    try {
      const r = await fetch("/api/wanxing/fleet/catalog");
      if (r.ok) {
        const doc = (await r.json()) as LocalCatalog;
        setLocal({ source: "local", agents: doc.agents ?? [], candidates: doc.candidates ?? [], capacity: doc.capacity });
        setLocalCode(null);
      } else {
        setLocal(null);
        setLocalCode((await r.json().catch(() => ({}))).error || "local_store_unavailable");
      }
    } catch {
      setLocal(null);
      setLocalCode("local_store_unavailable");
    }
  }, []);

  // The cloud bridge is loaded on demand only: a desktop cluster must never
  // poll a cloud directory to look healthy.
  const loadCloud = useCallback(async () => {
    setCloudCode(null);
    try {
      const r = await fetch("/api/wanxing/fleet/catalog?source=registry");
      if (r.ok) {
        setCloud((await r.json()).agents ?? []);
      } else {
        setCloud(null);
        setCloudCode((await r.json().catch(() => ({}))).error || "registry_unreachable");
      }
    } catch {
      setCloud(null);
      setCloudCode("registry_unreachable");
    }
  }, []);

  const act = useCallback(
    async (action: WriteAction, candidate: Candidate) => {
      setActionError(null);
      setBusy(candidate.path);
      try {
        const url =
          action === "deploy" ? "/api/wanxing/fleet/deployments" : `/api/wanxing/fleet/deployments/${action}`;
        const body =
          action === "deploy" ? { packId: candidate.packId, agentId: candidate.agentId } : { agentPath: candidate.path };
        const r = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!r.ok) {
          const doc = await r.json().catch(() => ({}));
          setActionError({ code: doc.error || "failed", used: doc.used, cap: doc.cap });
        }
      } catch {
        setActionError({ code: "failed" });
      } finally {
        setBusy(null);
        void loadLocal();
        void loadLive();
      }
    },
    [loadLive, loadLocal],
  );

  useEffect(() => {
    // Desktop shell only (hide-fleet-nav-on-web): these zones proxy the
    // desktop process's own runner/store — a plain browser has neither, so it
    // never polls and gets the desktop-only explanation instead of dead zones.
    if (!IS_DESKTOP) return;
    void loadLive();
    void loadLocal();
    const id = setInterval(() => void loadLive(), POLL_MS);
    return () => clearInterval(id);
  }, [loadLive, loadLocal]);

  const budgetPct = live && live.budgetMb > 0 ? Math.min(100, Math.round((live.budget / live.budgetMb) * 100)) : 0;
  const cap = local?.capacity;
  const atCapacity = cap ? cap.used >= cap.cap : false;

  return (
    <div className="flex h-full flex-col bg-background" data-testid="fleet-page">
      <div className="border-b border-border px-6 py-4">
        <h1 className="text-lg font-semibold">{t("fleet.title")}</h1>
      </div>

      {!IS_DESKTOP && (
        <div className="flex-1 flex items-center justify-center p-6">
          <div
            className="max-w-md rounded-md border border-dashed border-border p-6 text-center text-sm text-muted-foreground space-y-2"
            data-testid="fleet-desktop-only"
          >
            <p>{t("fleet.desktopOnly.body")}</p>
            <p className="text-xs">{t("fleet.desktopOnly.hint")}</p>
          </div>
        </div>
      )}

      {IS_DESKTOP && (
        <div className="flex-1 space-y-6 overflow-auto p-6">
          {/* Local cluster zone — writable */}
          <section data-testid="fleet-live">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-foreground">{t("fleet.live.title")}</h2>
              <div className="flex items-center gap-3">
                {cap && (
                  <span className="text-xs text-muted-foreground" data-testid="fleet-capacity">
                    {t("fleet.local.capacity", { used: cap.used, cap: cap.cap })}
                  </span>
                )}
                {live && (
                  <span className="text-xs text-muted-foreground" data-testid="fleet-live-summary">
                    {t("fleet.live.summary", { agents: live.agents.length, children: live.children, count: live.agents.length })}
                  </span>
                )}
              </div>
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

          {/* Deployable candidates from installed packs — the write face */}
          <section data-testid="fleet-candidates">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-foreground">{t("fleet.local.candidatesTitle")}</h2>
              <button
                className="rounded-md border border-border px-2.5 py-1 text-xs hover:bg-muted"
                onClick={() => {
                  void loadLocal();
                  void loadLive();
                }}
                data-testid="fleet-candidates-refresh"
              >
                {t("fleet.catalog.refresh")}
              </button>
            </div>

            {actionError && (
              <div className="mb-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-foreground" data-testid="fleet-action-error">
                {actionError.code === "capacity_exceeded" && actionError.used != null
                  ? t("fleet.local.capacityExceeded", { used: actionError.used, cap: actionError.cap })
                  : t("fleet.local.actionFailed", { code: actionError.code })}
              </div>
            )}

            {localCode ? (
              <div className="flex h-24 items-center justify-center rounded-md border border-dashed border-border text-sm text-muted-foreground" data-testid="fleet-candidates-guide">
                {t("fleet.local.unavailable")}
              </div>
            ) : local === null ? (
              <div className="flex h-24 items-center justify-center text-sm text-muted-foreground">{t("fleet.live.loading")}</div>
            ) : local.candidates.length === 0 ? (
              <div className="flex h-24 items-center justify-center rounded-md border border-dashed border-border text-sm text-muted-foreground" data-testid="fleet-candidates-empty">
                {t("fleet.local.candidatesEmpty")}
              </div>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" data-testid="fleet-candidates-grid">
                {local.candidates.map((c) => {
                  const isBusy = busy === c.path;
                  return (
                    <div key={c.path} className="rounded-md border border-border bg-card p-3" data-testid="fleet-candidate-card">
                      <div className="flex items-start justify-between gap-2">
                        <span className="min-w-0 truncate text-sm font-medium" title={c.name}>{c.name}</span>
                        <span
                          className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${
                            c.enabled ? STATE_STYLES.resident : "bg-muted text-muted-foreground"
                          }`}
                          data-testid="fleet-candidate-state"
                        >
                          {c.enabled
                            ? t("fleet.local.stateRunning")
                            : c.deployed
                              ? t("fleet.local.stateStopped")
                              : t("fleet.local.stateNotDeployed")}
                        </span>
                      </div>
                      <p className="mt-1 truncate text-xs text-muted-foreground" title={c.path}>{c.packId} / {c.agentId}</p>
                      {c.desiredEnabled !== null && (c.source !== null || c.desiredEnabled !== c.enabled) ? (
                        <div className="mt-1 flex items-center gap-1.5" data-testid="fleet-candidate-provenance">
                          {c.source !== null && (
                            <span className={`rounded px-1.5 py-0.5 text-xs ${c.source === "cloud" ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground"}`}>
                              {t(c.source === "cloud" ? "fleet.local.sourceCloud" : "fleet.local.sourceManual")}
                            </span>
                          )}
                          {c.desiredEnabled !== c.enabled && (
                            <span className="rounded bg-warning/15 px-1.5 py-0.5 text-xs text-warning" data-testid="fleet-candidate-diverged">
                              {t("fleet.local.diverged")}
                            </span>
                          )}
                        </div>
                      ) : null}
                      {c.description ? <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{c.description}</p> : null}
                      {!c.deployed && atCapacity && (
                        // Visible guidance beats a hover-only title: the reason
                        // a deploy is prevented should be readable, not hidden.
                        <p className="mt-2 text-xs text-warning" data-testid="fleet-candidate-capacity-note">
                          {t("fleet.local.capacityHint")}
                        </p>
                      )}
                      <div className="mt-3 flex gap-2">
                        {!c.deployed || !c.enabled ? (
                          <button
                            disabled={isBusy || (!c.deployed && atCapacity)}
                            title={!c.deployed && atCapacity ? t("fleet.local.capacityHint") : undefined}
                            className="flex-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
                            onClick={() => void act(c.deployed ? "start" : "deploy", c)}
                            data-testid="fleet-candidate-deploy"
                          >
                            {c.deployed ? t("fleet.local.start") : t("fleet.local.deploy")}
                          </button>
                        ) : (
                          <button
                            disabled={isBusy}
                            className="flex-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-muted disabled:opacity-60"
                            onClick={() => void act("stop", c)}
                            data-testid="fleet-candidate-stop"
                          >
                            {t("fleet.local.stop")}
                          </button>
                        )}
                        {c.deployed && (
                          <button
                            disabled={isBusy}
                            className="rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-muted disabled:opacity-60"
                            onClick={() => void act("remove", c)}
                            data-testid="fleet-candidate-remove"
                          >
                            {t("fleet.local.remove")}
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
            <p className="mt-2 text-xs text-muted-foreground">{t("fleet.local.candidatesNote")}</p>
          </section>

          {/* Cloud seat zone — read-only bridge */}
          <section data-testid="fleet-catalog">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-foreground">{t("fleet.catalog.title")}</h2>
              <button
                className="rounded-md border border-border px-2.5 py-1 text-xs hover:bg-muted"
                onClick={() => void loadCloud()}
                data-testid="fleet-catalog-refresh"
              >
                {t("fleet.catalog.refresh")}
              </button>
            </div>

            {cloudCode ? (
              <div className="flex h-24 items-center justify-center rounded-md border border-dashed border-border text-sm text-muted-foreground" data-testid="fleet-catalog-guide">
                {t(`fleet.catalog.guide.${cloudCode === "registry_not_configured" ? "notConfigured" : "unreachable"}`)}
              </div>
            ) : cloud === null ? (
              <div className="flex h-24 items-center justify-center rounded-md border border-dashed border-border text-sm text-muted-foreground" data-testid="fleet-catalog-idle">
                {t("fleet.catalog.idle")}
              </div>
            ) : cloud.length === 0 ? (
              <div className="flex h-24 items-center justify-center rounded-md border border-dashed border-border text-sm text-muted-foreground" data-testid="fleet-catalog-empty">
                {t("fleet.catalog.empty")}
              </div>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" data-testid="fleet-catalog-grid">
                {cloud.map((a) => (
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
                  </div>
                ))}
              </div>
            )}
            <p className="mt-2 text-xs text-muted-foreground">{t("fleet.catalog.readOnlyNote")}</p>
          </section>
        </div>
      )}
    </div>
  );
}
