// MachinesPage.tsx — the unified machine console (add-unified-fleet-console),
// now the machine LIFECYCLE façade (add-machine-lifecycle-console): pairing
// wizard, roster, per-machine detail with the convergence indicator, history
// timeline, and the unbind exit — one surface, machine birth to unbinding.
//
// Cloud view of every steward-paired machine on this account: roster with
// derived health (silence / divergence / self-reported alerts), per-machine
// detail (deployment entries with their source, agent five-states, runtime
// occupancy, merge outcome), and the desired-state editor. Edits only land in
// the cloud desired set — the MACHINE pulls and applies them on its own beat;
// this page never drives the machine (no control channel, by design). The
// convergence indicator is presentation-only for the same reason.
//
// Data sources: /api/machines (roster), /api/machines/:id (detail),
// /api/machines/:id/history (metadata events), /api/mp/bindcode (pairing, same
// pool as Settings), DELETE /api/machines/:id (unbind).

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { QrCode } from "@/components/settings/QrCode";
import { deriveConvergence, type ConvergenceState } from "@/lib/machine-convergence";

interface Health {
  silence: "online" | "silent" | "never_reported";
  alerts: { kind: string; count?: number; streak?: number; lastSeenAt?: number | null }[];
  divergenceStreak: number;
  lastSeenAt: number | null;
}

interface MachineRow {
  deviceId: string;
  label: string;
  boundAt: number | null;
  lastSeenAt: number | null;
  presence: { state?: string; os?: string; appVersion?: string } | null;
  desiredVersion: number;
  summary: {
    fleetCount: number | null;
    memberCount: number | null;
    enabledTaskCount: number | null;
    deploymentCount: number | null;
    capacity: { used: number; cap: number; unit: string } | null;
  };
  health: Health;
}

interface DeploymentRow {
  agentPath: string;
  packId: string;
  agentId: string;
  enabled: boolean;
  source: "manual" | "cloud";
}

interface DesiredEntry {
  packId: string;
  agentId: string;
  enabled: boolean;
}

interface MachineDetail {
  deviceId: string;
  detail: {
    at: number;
    capacity: { used: number; cap: number; unit: string } | null;
    deployments: DeploymentRow[];
    agents: { key: string; state: string; port: number | null; version: number | null }[];
    merge: { desiredVersionSeen: number | null; rejects?: { agentPath: string; code: string }[] } | null;
  } | null;
  desired: { version: number; entries: DesiredEntry[]; updatedAt: number | null };
  health: Health;
}

interface HistoryEvent {
  at: number;
  kind: string;
  from?: string | null;
  to?: string | number | null;
  who?: string | null;
  version?: number;
  added?: number;
  removed?: number;
  toggled?: number;
  open?: boolean;
  count?: number;
  streak?: number;
}

const POLL_MS = 15_000;
// A detail snapshot older than a few beats reads as stale, not live.
const STALE_AFTER_MS = 5 * 60_000;
// History timeline shows the latest slice; "view all" expands to the cap.
const HISTORY_PREVIEW = 20;
// While the pairing wizard waits for the machine's first check-in.
const PAIR_POLL_MS = 3_000;
const PAIR_POLL_MAX = 6 * 60_000;

function ageLabel(at: number | null | undefined, t: (k: string, o?: Record<string, unknown>) => string): string | null {
  if (!at) return null;
  const s = Math.max(0, Math.floor((Date.now() - at) / 1000));
  if (s < 60) return t("machines.age.seconds", { n: s });
  if (s < 3600) return t("machines.age.minutes", { n: Math.floor(s / 60) });
  return t("machines.age.hours", { n: Math.floor(s / 3600) });
}

const ALERT_KEYS: Record<string, string> = {
  silent: "machines.alerts.silent",
  divergence: "machines.alerts.divergence",
  crash_loop: "machines.alerts.crashLoop",
  pull_failures: "machines.alerts.pullFailures",
  merge_rejects: "machines.alerts.mergeRejects",
};

function clock(seconds: number): string {
  const m = Math.floor(seconds / 60);
  return `${m}:${String(seconds % 60).padStart(2, "0")}`;
}

// ── Convergence indicator ────────────────────────────────────────────────────

function ConvergenceIndicator({ detail, health, desiredVersion, t }: { detail: MachineDetail["detail"]; health: Health; desiredVersion: number; t: (k: string, o?: Record<string, unknown>) => string }) {
  const verdict = deriveConvergence({
    desiredVersion,
    detail,
    silence: health.silence,
    divergenceStreak: health.divergenceStreak,
    now: Date.now(),
    staleAfterMs: STALE_AFTER_MS,
  });
  const styles: Record<ConvergenceState, string> = {
    synced: "bg-success/15 text-success",
    converging: "bg-primary/15 text-primary",
    awaiting: "bg-muted text-muted-foreground",
    diverged: "bg-warning/15 text-warning",
    unknown: "bg-muted text-muted-foreground",
    stale: "bg-warning/15 text-warning",
  };
  const copyArgs =
    verdict.state === "converging" || verdict.state === "awaiting"
      ? { version: desiredVersion, seen: verdict.seenVersion ?? "—" }
      : undefined;
  return (
    <div className={`rounded px-3 py-2 text-sm ${styles[verdict.state]}`} data-testid="machine-convergence" data-state={verdict.state}>
      <span className="font-medium">{t(`machines.converge.${verdict.state}`)}</span>
      <span className="ml-2 text-xs opacity-80">
        {verdict.state === "converging"
          ? t("machines.converge.convergingHint")
          : verdict.state === "awaiting"
            ? t("machines.converge.awaitingHint")
            : verdict.state === "stale"
              ? t("machines.converge.staleHint")
              : verdict.state === "unknown"
                ? t("machines.converge.unknownHint")
                : verdict.state === "diverged"
                  ? t("machines.converge.divergedHint")
                  : t("machines.converge.syncedHint", { version: verdict.seenVersion ?? desiredVersion })}
      </span>
      {copyArgs ? <span className="ml-1 text-xs opacity-60">v{copyArgs.seen} → v{copyArgs.version}</span> : null}
    </div>
  );
}

// ── History timeline ─────────────────────────────────────────────────────────

function historyCopy(e: HistoryEvent, t: (k: string, o?: Record<string, unknown>) => string): string {
  switch (e.kind) {
    case "presence_flip":
      return t("machines.history.presenceFlip", { from: t(`machines.health.${e.from === "silent" ? "silent" : e.from === "online" ? "online" : "neverReported"}`), to: t(`machines.health.${e.to === "silent" ? "silent" : e.to === "online" ? "online" : "neverReported"}`) });
    case "desired_change":
      return t("machines.history.desiredChange", { who: e.who ?? "—", version: e.version ?? 0, added: e.added ?? 0, removed: e.removed ?? 0, toggled: e.toggled ?? 0 });
    case "merge_advance":
      return t("machines.history.mergeAdvance", { from: e.from ?? "—", to: e.to ?? "—" });
    case "rejects_flip":
      return e.open ? t("machines.history.rejectsOpen", { count: e.count ?? 0 }) : t("machines.history.rejectsClear");
    case "divergence_flip":
      return e.open ? t("machines.history.divergenceOpen") : t("machines.history.divergenceClose");
    case "unbound":
      return t("machines.history.unbound", { who: e.who ?? "—" });
    default:
      return t("machines.history.other", { kind: e.kind });
  }
}

function HistoryTimeline({ deviceId, t }: { deviceId: string; t: (k: string, o?: Record<string, unknown>) => string }) {
  const [events, setEvents] = useState<HistoryEvent[] | null>(null);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    let alive = true;
    setEvents(null);
    setExpanded(false);
    fetch(`/api/machines/${encodeURIComponent(deviceId)}/history`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((doc) => {
        if (alive) setEvents(Array.isArray(doc.history) ? doc.history : []);
      })
      .catch(() => {
        if (alive) setEvents([]);
      });
    return () => {
      alive = false;
    };
  }, [deviceId]);
  if (events === null) {
    return <p className="text-xs text-muted-foreground">{t("machines.history.loading")}</p>;
  }
  if (events.length === 0) {
    return <p className="text-xs text-muted-foreground" data-testid="machine-history-empty">{t("machines.history.empty")}</p>;
  }
  const shown = expanded ? events : events.slice(0, HISTORY_PREVIEW);
  return (
    <div data-testid="machine-history">
      <ul className="space-y-1">
        {shown.map((e) => {
          // Composite identity (no array index): the store dedupes by state
          // signature, so two events never share at+kind+payload in practice.
          const rowKey = `${e.at}:${e.kind}:${e.who ?? ""}:${e.version ?? ""}:${e.from ?? ""}:${e.to ?? ""}:${e.open ?? ""}:${e.count ?? ""}`;
          return (
            <li key={rowKey} className="flex items-baseline justify-between gap-3 rounded border border-border px-3 py-1.5 text-sm">
              <span className="min-w-0">{historyCopy(e, t)}</span>
              <span className="shrink-0 text-xs text-muted-foreground">{new Date(e.at).toLocaleString()}</span>
            </li>
          );
        })}
      </ul>
      {events.length > HISTORY_PREVIEW && (
        <button type="button" className="mt-2 text-xs underline text-muted-foreground" onClick={() => setExpanded((v) => !v)}>
          {expanded ? t("machines.history.collapse") : t("machines.history.expand", { n: events.length })}
        </button>
      )}
    </div>
  );
}

// ── Pairing wizard ───────────────────────────────────────────────────────────

type MintState = "idle" | "minting" | "ready" | "error" | "unavailable" | "signed-out";

function PairingDialog({ onClose, t }: { onClose: () => void; t: (k: string, o?: Record<string, unknown>) => string }) {
  const [mintState, setMintState] = useState<MintState>("minting");
  const [code, setCode] = useState("");
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [tick, setTick] = useState(() => Date.now());
  const [waiting, setWaiting] = useState(false);
  const mintedAtRef = useRef<number>(0);
  const alive = useRef(true);
  useEffect(() => {
    return () => {
      alive.current = false;
    };
  }, []);

  const mint = useCallback(async () => {
    setMintState("minting");
    try {
      const r = await fetch("/api/mp/bindcode", { headers: { accept: "application/json" }, credentials: "same-origin" });
      if (!alive.current) return;
      if (r.status === 401) {
        setMintState("signed-out");
        return;
      }
      const contentType = r.headers.get("content-type") ?? "";
      if (r.status === 404 || !contentType.includes("application/json")) {
        setMintState("unavailable");
        return;
      }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const body = (await r.json()) as { code?: string; ttlMs?: number };
      if (!body.code) throw new Error("no code");
      mintedAtRef.current = Date.now();
      setCode(body.code);
      setExpiresAt(Date.now() + (body.ttlMs ?? 5 * 60_000));
      setMintState("ready");
    } catch {
      if (alive.current) setMintState("error");
    }
  }, []);

  useEffect(() => {
    void mint();
  }, [mint]);

  useEffect(() => {
    if (mintState !== "ready") return;
    const id = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, [mintState]);

  // Waiting state: poll the roster; the first machine paired AFTER the mint
  // (boundAt past mintedAt) closes the wizard with the machine in the roster.
  useEffect(() => {
    if (!waiting) return;
    const started = Date.now();
    const id = setInterval(async () => {
      try {
        const r = await fetch("/api/machines");
        if (!r.ok) return;
        const doc = await r.json();
        const fresh = (doc.machines ?? []).some((m: MachineRow) => (m.boundAt ?? 0) > mintedAtRef.current);
        if (fresh) {
          setWaiting(false);
          onClose();
        } else if (Date.now() - started > PAIR_POLL_MAX) {
          setWaiting(false);
        }
      } catch {
        // roster blips keep the wait honest; the interval retries
      }
    }, PAIR_POLL_MS);
    return () => clearInterval(id);
  }, [waiting, onClose]);

  const expired = mintState === "ready" && expiresAt !== null && tick >= expiresAt;
  const secondsLeft = expiresAt ? Math.max(0, Math.ceil((expiresAt - tick) / 1000)) : 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose} data-testid="machine-pair-overlay">
      <div className="w-full max-w-md space-y-4 rounded-lg border border-border bg-background p-6" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-base font-semibold">{t("machines.pair.title")}</h2>
        {mintState === "signed-out" ? (
          <p className="text-sm text-muted-foreground">{t("machines.pair.signedOut")}</p>
        ) : mintState === "unavailable" ? (
          <p className="text-sm text-muted-foreground">{t("machines.pair.unavailable")}</p>
        ) : mintState === "error" ? (
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">{t("machines.pair.error")}</p>
            <button type="button" className="rounded border border-input px-2 py-1 text-xs" onClick={() => void mint()} data-testid="machine-pair-retry">
              {t("machines.pair.retry")}
            </button>
          </div>
        ) : mintState === "minting" ? (
          <p className="text-sm text-muted-foreground">{t("machines.pair.minting")}</p>
        ) : waiting ? (
          <p className="text-sm text-muted-foreground" data-testid="machine-pair-waiting">
            {t("machines.pair.waiting")}
          </p>
        ) : (
          <>
            <p className="text-xs leading-5 text-muted-foreground">{t("machines.pair.hint")}</p>
            <div className="flex flex-wrap items-start gap-5">
              {expired ? (
                <div className="rounded-md border border-dashed border-border p-4 text-xs text-muted-foreground">{t("machines.pair.expired")}</div>
              ) : (
                <QrCode text={`${window.location.origin}/settings/devices?bindcode=${code}`} testId="machine-pairing-qr" />
              )}
              <div className="flex min-w-40 flex-col items-start gap-2">
                <span className="select-all font-mono text-2xl font-bold tracking-[0.3em]" data-testid="machine-pairing-code">
                  {code}
                </span>
                <span className="text-xs text-muted-foreground">{expired ? t("machines.pair.expired") : t("machines.pair.expiresIn", { time: clock(secondsLeft) })}</span>
                <button type="button" className="rounded border border-input px-2 py-1 text-xs text-muted-foreground" onClick={() => void mint()} data-testid="machine-pairing-refresh">
                  {t("machines.pair.refresh")}
                </button>
              </div>
            </div>
            <p className="text-xs leading-5 text-muted-foreground">{t("machines.pair.typeHint")}</p>
            <button type="button" className="rounded bg-primary px-3 py-1.5 text-sm text-primary-foreground" onClick={() => setWaiting(true)} data-testid="machine-pair-wait-start">
              {t("machines.pair.waitStart")}
            </button>
          </>
        )}
        <div className="flex justify-end">
          <button type="button" className="rounded border border-border px-3 py-1.5 text-sm" onClick={onClose}>
            {t("machines.pair.close")}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export function MachinesPage() {
  const { t } = useTranslation();
  const [machines, setMachines] = useState<MachineRow[] | null>(null);
  const [rosterCode, setRosterCode] = useState<string | null>(null);
  const [isAdminView, setIsAdminView] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<MachineDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [pairing, setPairing] = useState(false);
  // The deviceId whose unbind button is in its confirm step, if any.
  const [confirmingUnbind, setConfirmingUnbind] = useState(false);

  const loadRoster = useCallback(async () => {
    try {
      const r = await fetch("/api/machines");
      if (r.ok) {
        const doc = await r.json();
        setMachines(doc.machines ?? []);
        setIsAdminView(Boolean(doc.isAdminView));
        setRosterCode(null);
      } else {
        setRosterCode((await r.json().catch(() => ({}))).error || "roster_unavailable");
      }
    } catch {
      setRosterCode("roster_unavailable");
    }
  }, []);

  const loadDetail = useCallback(async (deviceId: string) => {
    try {
      const r = await fetch(`/api/machines/${encodeURIComponent(deviceId)}`);
      if (r.ok) setDetail(await r.json());
      else setDetail(null);
    } catch {
      setDetail(null);
    }
  }, []);

  useEffect(() => {
    void loadRoster();
    const timer = setInterval(() => void loadRoster(), POLL_MS);
    return () => clearInterval(timer);
  }, [loadRoster]);

  useEffect(() => {
    if (!openId) return;
    setConfirmingUnbind(false);
    void loadDetail(openId);
    const timer = setInterval(() => void loadDetail(openId), POLL_MS);
    return () => clearInterval(timer);
  }, [openId, loadDetail]);

  const saveDesired = useCallback(
    async (deviceId: string, entries: DesiredEntry[]) => {
      setBusy(true);
      setSaveError(null);
      try {
        const r = await fetch(`/api/machines/${encodeURIComponent(deviceId)}/desired`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ entries }),
        });
        if (r.ok) {
          await loadDetail(deviceId);
          await loadRoster();
        } else {
          const doc = await r.json().catch(() => ({}));
          setSaveError(doc.error || "save_failed");
        }
      } catch {
        setSaveError("save_failed");
      } finally {
        setBusy(false);
      }
    },
    [loadDetail, loadRoster],
  );

  const unbind = useCallback(
    async (deviceId: string) => {
      setBusy(true);
      setSaveError(null);
      try {
        const r = await fetch(`/api/machines/${encodeURIComponent(deviceId)}`, { method: "DELETE" });
        if (r.ok) {
          setConfirmingUnbind(false);
          setOpenId(null);
          await loadRoster();
        } else {
          setSaveError("unbind_failed");
        }
      } catch {
        setSaveError("unbind_failed");
      } finally {
        setBusy(false);
      }
    },
    [loadRoster],
  );

  const desiredKey = (e: DesiredEntry) => `${e.packId}/${e.agentId}`;

  const toggleDesired = (entry: DesiredEntry) => {
    if (!detail || busy) return;
    const next = detail.desired.entries.map((e) => (desiredKey(e) === desiredKey(entry) ? { ...e, enabled: !e.enabled } : e));
    void saveDesired(detail.deviceId, next);
  };

  const removeDesired = (entry: DesiredEntry) => {
    if (!detail || busy) return;
    const next = detail.desired.entries.filter((e) => desiredKey(e) !== desiredKey(entry));
    void saveDesired(detail.deviceId, next);
  };

  const addDesiredFromDeployment = (d: DeploymentRow) => {
    if (!detail || busy) return;
    if (detail.desired.entries.some((e) => desiredKey(e) === `${d.packId}/${d.agentId}`)) return;
    void saveDesired(detail.deviceId, [...detail.desired.entries, { packId: d.packId, agentId: d.agentId, enabled: true }]);
  };

  const healthChip = (health: Health) => {
    if (health.alerts.length > 0) {
      return (
        <span className="rounded bg-destructive/15 px-1.5 py-0.5 text-xs text-destructive" data-testid="machine-health-alert">
          {t(ALERT_KEYS[health.alerts[0]?.kind ?? ""] ?? "machines.alerts.other")}
        </span>
      );
    }
    if (health.silence === "online") {
      return <span className="rounded bg-success/15 px-1.5 py-0.5 text-xs text-success">{t("machines.health.online")}</span>;
    }
    return <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">{t(health.silence === "never_reported" ? "machines.health.neverReported" : "machines.health.silent")}</span>;
  };

  const detailStale = detail?.detail ? Date.now() - detail.detail.at > STALE_AFTER_MS : false;
  const openMachine = machines?.find((m) => m.deviceId === openId) ?? null;

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6" data-testid="machines-page">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-lg font-semibold">{t("machines.title")}</h1>
        <div className="flex items-center gap-2">
          {isAdminView && <span className="rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground">{t("machines.adminView")}</span>}
          <button
            type="button"
            className="rounded bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            onClick={() => setPairing(true)}
            data-testid="machine-add"
          >
            {t("machines.pair.add")}
          </button>
        </div>
      </div>

      {rosterCode ? (
        <div className="rounded border border-border p-6 text-sm text-muted-foreground" data-testid="machines-error">
          {t("machines.rosterError")}
        </div>
      ) : !machines || machines.length === 0 ? (
        <div className="rounded border border-border p-6 text-sm text-muted-foreground" data-testid="machines-empty">
          <p>{t("machines.empty")}</p>
          <button
            type="button"
            className="mt-3 rounded bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            onClick={() => setPairing(true)}
            data-testid="machines-empty-pair"
          >
            {t("machines.pair.emptyCta")}
          </button>
        </div>
      ) : (
        <ul className="space-y-2" data-testid="machines-list">
          {machines.map((m) => (
            <li key={m.deviceId}>
              <button
                type="button"
                onClick={() => setOpenId(m.deviceId)}
                className="flex w-full items-center justify-between rounded border border-border px-4 py-3 text-left hover:bg-muted/40"
                data-testid={`machine-row-${m.deviceId}`}
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium">{m.label || m.deviceId}</span>
                    {healthChip(m.health)}
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {m.presence?.os || m.presence?.appVersion
                      ? `${m.presence?.os ?? "—"} · ${m.presence?.appVersion ?? "—"}`
                      : t("machines.system.unknown")}
                    {m.boundAt ? ` · ${t("machines.system.boundAt", { time: new Date(m.boundAt).toLocaleDateString() })}` : ""}
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {t("machines.summary.fleets", { n: m.summary.fleetCount ?? "—" })}
                    {" · "}
                    {t("machines.summary.members", { n: m.summary.memberCount ?? "—" })}
                    {" · "}
                    {t("machines.summary.deployments", { n: m.summary.deploymentCount ?? "—" })}
                    {m.summary.capacity ? ` · ${m.summary.capacity.used}/${m.summary.capacity.cap} ${m.summary.capacity.unit}` : ""}
                  </div>
                </div>
                <div className="shrink-0 text-xs text-muted-foreground">{ageLabel(m.lastSeenAt, t) ?? ""}</div>
              </button>
            </li>
          ))}
        </ul>
      )}

      {pairing && <PairingDialog onClose={() => { setPairing(false); void loadRoster(); }} t={t} />}

      {openId && (
        <div className="fixed inset-0 z-50 flex justify-end bg-black/40" onClick={() => setOpenId(null)} data-testid="machine-detail-overlay">
          <div className="h-full w-full max-w-xl overflow-y-auto bg-background p-6" onClick={(e) => e.stopPropagation()}>
            {!detail ? (
              <p className="text-sm text-muted-foreground">{t("machines.detailLoading")}</p>
            ) : (
              <div className="space-y-6">
                <div>
                  <div className="flex items-center justify-between">
                    <h2 className="font-semibold">{detail.deviceId === openId ? openMachine?.label || detail.deviceId : detail.deviceId}</h2>
                    {healthChip(detail.health)}
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground" data-testid="machine-identity">
                    {openMachine?.presence?.os || openMachine?.presence?.appVersion
                      ? `${openMachine?.presence?.os ?? "—"} · ${openMachine?.presence?.appVersion ?? "—"}`
                      : t("machines.system.unknown")}
                    {openMachine?.boundAt ? ` · ${t("machines.system.boundAt", { time: new Date(openMachine.boundAt).toLocaleString() })}` : ""}
                  </p>
                </div>

                <ConvergenceIndicator detail={detail.detail} health={detail.health} desiredVersion={detail.desired.version} t={t} />

                {detail.detail ? (
                  <>
                    <p className={`text-xs ${detailStale ? "text-warning" : "text-muted-foreground"}`}>
                      {detailStale ? t("machines.detail.stale") : t("machines.detail.fresh")}
                      {` · ${ageLabel(detail.detail.at, t) ?? ""}`}
                    </p>

                    <section>
                      <h3 className="mb-2 text-sm font-medium">{t("machines.detail.deployments")}</h3>
                      {detail.detail.deployments.length === 0 ? (
                        <p className="text-xs text-muted-foreground">{t("machines.detail.noDeployments")}</p>
                      ) : (
                        <ul className="space-y-1" data-testid="machine-deployments">
                          {detail.detail.deployments.map((d) => {
                            const desiredEntry = detail.desired.entries.find((e) => desiredKey(e) === `${d.packId}/${d.agentId}`);
                            const diverged = desiredEntry ? desiredEntry.enabled !== d.enabled : d.source === "cloud";
                            return (
                              <li key={d.agentPath} className="flex items-center justify-between rounded border border-border px-3 py-2 text-sm">
                                <div className="min-w-0">
                                  <div className="truncate">
                                    {d.packId}/{d.agentId}
                                    <span className={`ml-2 rounded px-1.5 py-0.5 text-xs ${d.source === "cloud" ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground"}`}>
                                      {t(d.source === "cloud" ? "machines.source.cloud" : "machines.source.manual")}
                                    </span>
                                    {diverged && <span className="ml-1 rounded bg-warning/15 px-1.5 py-0.5 text-xs text-warning">{t("machines.diverged")}</span>}
                                  </div>
                                  <div className="text-xs text-muted-foreground">{d.enabled ? t("machines.state.enabled") : t("machines.state.disabled")}</div>
                                </div>
                              </li>
                            );
                          })}
                        </ul>
                      )}
                    </section>

                    <section>
                      <h3 className="mb-2 text-sm font-medium">{t("machines.detail.agents")}</h3>
                      {detail.detail.agents.length === 0 ? (
                        <p className="text-xs text-muted-foreground">{t("machines.detail.noAgents")}</p>
                      ) : (
                        <ul className="space-y-1" data-testid="machine-agents">
                          {detail.detail.agents.map((a) => (
                            <li key={a.key} className="flex items-center justify-between rounded border border-border px-3 py-2 text-sm">
                              <span className="truncate">{a.key}</span>
                              <span className="text-xs text-muted-foreground">{a.state}{a.port ? ` · :${a.port}` : ""}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </section>

                    {detail.detail.merge && detail.detail.merge.rejects && detail.detail.merge.rejects.length > 0 && (
                      <section>
                        <h3 className="mb-2 text-sm font-medium text-destructive">{t("machines.detail.mergeRejects")}</h3>
                        <ul className="space-y-1">
                          {detail.detail.merge.rejects.map((r) => (
                            <li key={`${r.agentPath}:${r.code}`} className="rounded border border-destructive/30 px-3 py-2 text-xs">
                              {r.agentPath} · {r.code}
                            </li>
                          ))}
                        </ul>
                      </section>
                    )}
                  </>
                ) : (
                  <p className="text-sm text-muted-foreground">{t("machines.detail.neverReported")}</p>
                )}

                <section>
                  <h3 className="mb-2 text-sm font-medium">{t("machines.desired.title")}</h3>
                  <p className="mb-2 text-xs text-muted-foreground">{t("machines.desired.hint")}</p>
                  {detail.desired.entries.length === 0 ? (
                    <p className="text-xs text-muted-foreground" data-testid="desired-empty">{t("machines.desired.empty")}</p>
                  ) : (
                    <ul className="space-y-1" data-testid="desired-list">
                      {detail.desired.entries.map((e) => (
                        <li key={desiredKey(e)} className="flex items-center justify-between rounded border border-border px-3 py-2 text-sm">
                          <span className="min-w-0 truncate">
                            {e.packId}/{e.agentId}
                            <span className={`ml-2 rounded px-1.5 py-0.5 text-xs ${e.enabled ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground"}`}>
                              {t(e.enabled ? "machines.desired.enabled" : "machines.desired.disabled")}
                            </span>
                          </span>
                          <span className="flex shrink-0 gap-2">
                            <button type="button" className="text-xs underline" disabled={busy} onClick={() => toggleDesired(e)}>
                              {t(e.enabled ? "machines.desired.disable" : "machines.desired.enable")}
                            </button>
                            <button type="button" className="text-xs underline text-destructive" disabled={busy} onClick={() => removeDesired(e)}>
                              {t("machines.desired.remove")}
                            </button>
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                  {detail.detail && detail.detail.deployments.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-2">
                      {detail.detail.deployments
                        .filter((d) => !detail.desired.entries.some((e) => desiredKey(e) === `${d.packId}/${d.agentId}`))
                        .map((d) => (
                          <button
                            key={d.agentPath}
                            type="button"
                            className="rounded border border-border px-2 py-1 text-xs hover:bg-muted/40"
                            disabled={busy}
                            onClick={() => addDesiredFromDeployment(d)}
                            data-testid={`desired-add-${d.packId}-${d.agentId}`}
                          >
                            + {d.packId}/{d.agentId}
                          </button>
                        ))}
                    </div>
                  )}
                  {saveError && <p className="mt-2 text-xs text-destructive">{t(saveError === "unbind_failed" ? "machines.unbind.error" : "machines.desired.saveError")}</p>}
                </section>

                <section>
                  <h3 className="mb-2 text-sm font-medium">{t("machines.history.title")}</h3>
                  <HistoryTimeline deviceId={detail.deviceId} t={t} />
                </section>

                <section className="rounded border border-destructive/30 p-4" data-testid="machine-unbind-zone">
                  <h3 className="text-sm font-medium text-destructive">{t("machines.unbind.title")}</h3>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">{t("machines.unbind.hint")}</p>
                  {confirmingUnbind ? (
                    <div className="mt-2 flex items-center gap-2" data-testid="machine-unbind-confirming">
                      <span className="text-xs text-muted-foreground">{t("machines.unbind.confirmText")}</span>
                      <button
                        type="button"
                        className="rounded border border-destructive/40 bg-destructive/10 px-2 py-1 text-xs font-medium text-destructive hover:bg-destructive/20"
                        disabled={busy}
                        onClick={() => void unbind(detail.deviceId)}
                        data-testid="machine-unbind-confirm"
                      >
                        {t("machines.unbind.confirm")}
                      </button>
                      <button type="button" className="rounded border border-input px-2 py-1 text-xs text-muted-foreground" onClick={() => setConfirmingUnbind(false)}>
                        {t("machines.unbind.cancel")}
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="mt-2 rounded border border-destructive/40 px-2 py-1 text-xs font-medium text-destructive hover:bg-destructive/10"
                      onClick={() => setConfirmingUnbind(true)}
                      data-testid="machine-unbind"
                    >
                      {t("machines.unbind.title")}
                    </button>
                  )}
                </section>

                <button type="button" className="rounded border border-border px-3 py-1.5 text-sm hover:bg-muted/40" onClick={() => setOpenId(null)}>
                  {t("machines.detail.close")}
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
