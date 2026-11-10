// ── Fleet machines console routes (add-unified-fleet-console) ───────────────
//
// The user-facing machines surface, registered by BOTH entrypoints (gateway
// for hosted topology, server.js for single-process) exactly like the device
// pairing routes: one shared implementation, each entrypoint supplies its own
// identity resolvers. All routes take the WEB/app account identity — never a
// steward credential (steward tokens open the two steward doors only).
//
// Roster base is the account's STEWARD-kind pairings (bindings own pairing
// truth); machines-store rows join in for liveness/detail/desired. A revoked
// pairing therefore drops out of the roster automatically — no store cleanup
// path to forget. Admin view lists every machine the store knows (a device
// that never reported has no data to show, so the store base loses nothing).
//
// Health is derived read-only from already-reported data: zero outbound
// probes, ever (spec fleet-machine-console).

import express from "express";

import { HISTORY_LIMIT, HISTORY_RETENTION_MS } from "./fleet-machines-store.js";

const DEFAULT_SILENCE_MS = 30 * 60 * 1000;
const DEFAULT_ALERT_THRESHOLD = 3;
const DESIRED_LIMITS = { entries: 64, str: 200 };

function cappedStr(v, max = DESIRED_LIMITS.str) {
  return typeof v === "string" && v.length > 0 ? v.slice(0, max) : null;
}

// Pure derivation so tests pin the semantics, not wiring.
export function deriveMachineHealth(row, { now = Date.now, silenceMs = DEFAULT_SILENCE_MS, alertThreshold = DEFAULT_ALERT_THRESHOLD } = {}) {
  const alerts = [];
  const lastSeenAt = row?.lastSeenAt ?? null;
  const silence = lastSeenAt == null ? "never_reported" : now() - lastSeenAt > silenceMs ? "silent" : "online";
  if (silence === "silent") alerts.push({ kind: "silent", lastSeenAt });
  const divergenceStreak = row?.divergenceStreak ?? 0;
  if (divergenceStreak >= alertThreshold) alerts.push({ kind: "divergence", streak: divergenceStreak });
  const steward = row?.detail?.steward ?? null;
  if (steward?.crashRestarts != null && steward.crashRestarts >= alertThreshold) {
    alerts.push({ kind: "crash_loop", count: steward.crashRestarts });
  }
  if (steward?.pullFailures != null && steward.pullFailures >= alertThreshold) {
    alerts.push({ kind: "pull_failures", count: steward.pullFailures });
  }
  const rejects = row?.detail?.merge?.rejects ?? [];
  if (rejects.length > 0) alerts.push({ kind: "merge_rejects", count: rejects.length });
  return { silence, alerts, divergenceStreak, lastSeenAt };
}

function machineView({ deviceId, binding, row, now, silenceMs, alertThreshold }) {
  const detail = row?.detail ?? null;
  const health = deriveMachineHealth(row, { now, silenceMs, alertThreshold });
  return {
    deviceId,
    label: binding?.label ?? "",
    boundAt: binding?.boundAt ?? null,
    lastSeenAt: row?.lastSeenAt ?? null,
    presence: row?.presence ?? null,
    desiredVersion: row?.desired?.version ?? 0,
    summary: {
      fleetCount: row?.presence?.fleetCount ?? null,
      memberCount: row?.presence?.memberCount ?? null,
      enabledTaskCount: row?.presence?.enabledTaskCount ?? null,
      deploymentCount: Array.isArray(detail?.deployments) ? detail.deployments.length : null,
      capacity: detail?.capacity ?? null,
    },
    health,
  };
}

export function registerFleetMachineRoutes({
  app,
  appAuth,
  machines,
  callerEmail,
  isAdmin = () => false,
  silenceMs = DEFAULT_SILENCE_MS,
  alertThreshold = DEFAULT_ALERT_THRESHOLD,
  now = Date.now,
}) {
  function stewardBindingsFor(email) {
    return (appAuth.devicesFor(email) ?? []).filter((d) => d.kind === "steward");
  }

  // Roster: the account's steward pairings, store rows joined in. Admin sees
  // every device the store knows (store rows are the only cross-account view;
  // devices that never reported have nothing to show). Silence is derived on
  // read, so each read also books a silence flip into the machine's history —
  // "observed silent" is a fact worth one event per silence episode, not one
  // per poll.
  app.get("/api/machines", (req, res) => {
    const email = callerEmail(req);
    if (!email) return res.status(401).json({ error: "Authentication required" });
    let items;
    if (isAdmin(req)) {
      items = machines.list().map((row) => machineView({ deviceId: row.deviceId, binding: null, row, now, silenceMs, alertThreshold }));
    } else {
      items = stewardBindingsFor(email).map((binding) =>
        machineView({ deviceId: binding.deviceId, binding, row: machines.get(binding.deviceId), now, silenceMs, alertThreshold }),
      );
    }
    for (const item of items) machines.noteSilence?.(item.deviceId, item.health.silence);
    items.sort((a, b) => {
      const rank = (m) => (m.health.alerts.length > 0 ? 1 : 0);
      if (rank(a) !== rank(b)) return rank(a) - rank(b);
      return (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0);
    });
    return res.json({ machines: items, isAdminView: isAdmin(req) });
  });

  function ownDeviceOr404(req, res, email) {
    const deviceId = String(req.params?.deviceId ?? "");
    const binding = stewardBindingsFor(email).find((d) => d.deviceId === deviceId);
    if (!binding) {
      res.status(404).json({ error: "machine_not_found" });
      return null;
    }
    return binding;
  }

  app.get("/api/machines/:deviceId", (req, res) => {
    const email = callerEmail(req);
    if (!email) return res.status(401).json({ error: "Authentication required" });
    if (!isAdmin(req) && !ownDeviceOr404(req, res, email)) return undefined;
    const deviceId = String(req.params?.deviceId ?? "");
    const row = machines.get(deviceId);
    const health = deriveMachineHealth(row, { now, silenceMs, alertThreshold });
    machines.noteSilence?.(deviceId, health.silence);
    return res.json({
      deviceId,
      detail: row?.detail ?? null,
      desired: row?.desired ? { version: row.desired.version, entries: row.desired.entries, updatedAt: row.desired.at } : { version: 0, entries: [] },
      health,
    });
  });

  // Bounded per-machine metadata history (add-machine-lifecycle-console):
  // newest first. Access mirrors the roster's account scoping, plus the
  // revocation retention window — the account that revoked the machine may
  // still read its history for HISTORY_RETENTION_MS, then the row (and its
  // history) is swept. A bound machine that never reported has an empty
  // history, not a 404.
  app.get("/api/machines/:deviceId/history", (req, res) => {
    const email = callerEmail(req);
    if (!email) return res.status(401).json({ error: "Authentication required" });
    const deviceId = String(req.params?.deviceId ?? "");
    const ownBinding = stewardBindingsFor(email).some((d) => d.deviceId === deviceId);
    const row = machines.get(deviceId);
    const inRetention = Boolean(
      row && row.revokedAt != null && row.ownerEmail === email && now() - row.revokedAt <= HISTORY_RETENTION_MS,
    );
    if (!ownBinding && !inRetention && !isAdmin(req)) {
      return res.status(404).json({ error: "machine_not_found" });
    }
    if (!row) {
      if (ownBinding) return res.json({ deviceId, history: [], revokedAt: null });
      return res.status(404).json({ error: "machine_not_found" });
    }
    const rawLimit = Number(req.query?.limit);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.trunc(rawLimit), HISTORY_LIMIT) : HISTORY_LIMIT;
    return res.json({ deviceId, history: (row.history ?? []).slice(0, limit), revokedAt: row.revokedAt ?? null });
  });

  // Unbind from the machine console (add-machine-lifecycle-console): revoke
  // the steward binding AND clear the cloud desired set, so a re-pair under
  // the same deviceId cannot inherit stale expectations. The store row (with
  // its history) is retained for the retention window, then swept.
  app.delete("/api/machines/:deviceId", async (req, res) => {
    const email = callerEmail(req);
    if (!email) return res.status(401).json({ error: "Authentication required" });
    if (!ownDeviceOr404(req, res, email)) return undefined;
    const deviceId = String(req.params?.deviceId ?? "");
    const revoked = await appAuth.revoke(email, deviceId);
    if (!revoked?.ok) return res.status(404).json({ error: "machine_not_found" });
    machines.revoke(deviceId, { who: email });
    // Answer only once the revocation is durable — a 200 a gateway restart
    // can erase would let a revoked machine keep pulling its old expectation.
    await machines.flush;
    return res.json({ ok: true, deviceId });
  });

  // Whole-set replace: the editor sends the complete desired list (add /
  // remove / toggle are all one shape), the machine applies it wholesale on
  // its next pull. Validation is strict — identity fields plus enabled only.
  //
  // express.json() rides THIS registration: both mount sites register bare
  // handlers (no parser), so without it req.body is undefined and every
  // write 400s "entries must be an array". Live walkthrough caught it —
  // unit tests hand the handler a pre-parsed body and never see the gap.
  app.put("/api/machines/:deviceId/desired", express.json(), async (req, res) => {
    const email = callerEmail(req);
    if (!email) return res.status(401).json({ error: "Authentication required" });
    if (!ownDeviceOr404(req, res, email)) return undefined;
    const deviceId = String(req.params?.deviceId ?? "");
    const raw = req.body?.entries;
    if (!Array.isArray(raw)) return res.status(400).json({ error: "entries must be an array" });
    if (raw.length > DESIRED_LIMITS.entries) return res.status(400).json({ error: "too_many_entries" });
    const seen = new Set();
    const entries = [];
    for (const e of raw) {
      const packId = cappedStr(e?.packId);
      const agentId = cappedStr(e?.agentId);
      if (!packId || !agentId) return res.status(400).json({ error: "entry requires packId and agentId" });
      const key = `${packId}/${agentId}`;
      if (seen.has(key)) return res.status(400).json({ error: `duplicate entry ${key}` });
      seen.add(key);
      entries.push({ packId, agentId, enabled: e?.enabled !== false });
    }
    const row = machines.recordDesired(deviceId, entries, { ownerEmail: email });
    // Answer only once the expectation is on disk: a 200 that a gateway
    // restart can erase is a lie the user acts on.
    await machines.flush;
    return res.json({
      desired: { version: row.desired.version, entries: row.desired.entries, updatedAt: row.desired.at },
      health: deriveMachineHealth(row, { now, silenceMs, alertThreshold }),
    });
  });
}
