// ── Steward reporting + desired-state doors (add-cell-lifecycle 4.2,
//    add-unified-fleet-console) ────────────────────────────────────────────────
//
// The doors a steward-kind device credential may open (spec device-pairing-auth
// delta): posting `cell_presence` / `cell_manifest` / `cell_detail` events, and
// pulling ONLY its own machine's deployment desired set. Payloads are
// whitelisted BY SHAPE — content fields are absent from the whitelist's type
// space, so prompts, sessions and tool args never reach the relay or the
// machines store. presence/manifest relay onward to the 萬星 ingest the
// gateway's own cell-sampler uses (OpsView unchanged by this change);
// cell_detail is store-only. Without FLEET_INGEST_* set the relay door
// accepts-and-drops (202) — degrade-open: reporting never blocks a cell.
//
// The desired door is self-scoped by construction: the target machine is the
// token's `did`, and no request parameter can name another device.

import crypto from "node:crypto";

const PRESENCE_FIELDS = new Set(["state", "os", "appVersion", "protocolVersion", "at"]);
const MANIFEST_FIELDS = new Set(["fleetCount", "memberCount", "enabledTaskCount", "labels", "at"]);
const LABELS_MAX = 32;
const LABEL_MAX_CHARS = 64;

// cell_detail is metadata about WHAT runs on the machine, never WHAT it said:
// deployment identity/enabled/source, per-agent five-state, runtime-group
// occupancy, merge outcome counters, steward self-health. Everything else is
// stripped below.
const DETAIL_LIMITS = { deployments: 64, agents: 64, rejects: 64, str: 200 };
const DETAIL_SOURCES = new Set(["manual", "cloud"]);
const DETAIL_AGENT_STATES = new Set(["stopped", "starting", "serving", "draining", "crashed", "unknown"]);

function shapeWhitelisted(payload, allowed) {
  const out = {};
  for (const key of allowed) {
    if (payload?.[key] == null) continue;
    out[key] = payload[key];
  }
  if (out.labels != null) {
    out.labels = Array.isArray(out.labels)
      ? out.labels.filter((v) => typeof v === "string").slice(0, LABELS_MAX).map((v) => v.slice(0, LABEL_MAX_CHARS))
      : [];
  }
  return out;
}

function cappedStr(v) {
  return typeof v === "string" ? v.slice(0, DETAIL_LIMITS.str) : null;
}

function cappedInt(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

// Deep whitelist for the detail snapshot: each field either lands with a
// coerced, capped, type-checked value or is dropped — unknown keys (and any
// content-shaped field) cannot survive this function.
function sanitizeDetail(payload) {
  const out = { at: cappedInt(payload?.at) ?? Date.now() };
  if (payload?.capacity && typeof payload.capacity === "object") {
    const cap = {
      used: cappedInt(payload.capacity.used),
      cap: cappedInt(payload.capacity.cap),
      unit: cappedStr(payload.capacity.unit),
    };
    if (cap.used != null || cap.cap != null) out.capacity = cap;
  }
  if (Array.isArray(payload?.deployments)) {
    out.deployments = payload.deployments.slice(0, DETAIL_LIMITS.deployments).map((d) => ({
      agentPath: cappedStr(d?.agentPath),
      packId: cappedStr(d?.packId),
      agentId: cappedStr(d?.agentId),
      enabled: d?.enabled === true,
      source: DETAIL_SOURCES.has(d?.source) ? d.source : "manual",
    }));
  }
  if (Array.isArray(payload?.agents)) {
    out.agents = payload.agents.slice(0, DETAIL_LIMITS.agents).map((a) => ({
      key: cappedStr(a?.key),
      state: DETAIL_AGENT_STATES.has(a?.state) ? a.state : "unknown",
      port: cappedInt(a?.port),
      version: cappedInt(a?.version),
    }));
  }
  if (payload?.merge && typeof payload.merge === "object") {
    const m = { desiredVersionSeen: cappedInt(payload.merge.desiredVersionSeen) };
    if (Array.isArray(payload.merge.rejects)) {
      m.rejects = payload.merge.rejects.slice(0, DETAIL_LIMITS.rejects).map((r) => ({
        agentPath: cappedStr(r?.agentPath),
        code: cappedStr(r?.code),
      }));
    }
    out.merge = m;
  }
  if (payload?.steward && typeof payload.steward === "object") {
    const s = { crashRestarts: cappedInt(payload.steward.crashRestarts), pullFailures: cappedInt(payload.steward.pullFailures) };
    if (s.crashRestarts != null || s.pullFailures != null) out.steward = s;
  }
  return out;
}

export function createCellReportDoor({ appAuth, env = process.env, fetchImpl = fetch, now = Date.now, machines = null }) {
  const baseUrl = String(env.FLEET_INGEST_URL || "").trim().replace(/\/+$/, "");
  const relayToken = String(env.FLEET_INGEST_TOKEN || "").trim();
  const relayOn = Boolean(baseUrl && relayToken);

  function steward(req) {
    const bearer = String(req.headers.authorization || "").startsWith("Bearer ")
      ? String(req.headers.authorization).slice(7)
      : null;
    return bearer ? appAuth.stewardFromToken(bearer) : null;
  }

  async function relay(event) {
    if (!relayOn) return false;
    try {
      const r = await fetchImpl(`${baseUrl}/ingest`, {
        method: "POST",
        headers: { authorization: `Bearer ${relayToken}`, "content-type": "application/json" },
        body: JSON.stringify({ events: [event] }),
        signal: AbortSignal.timeout(5000),
      });
      if (!r.ok) console.warn(`[cell-report] ingest answered ${r.status} — dropping one ${event.kind} event`);
      return r.ok;
    } catch (e) {
      console.warn(`[cell-report] ingest relay failed (degrade-open, event dropped): ${e?.message || e}`);
      return false;
    }
  }

  async function handle(req, res) {
    const who = steward(req);
    if (!who) return res.status(401).json({ error: "steward credential required" });

    const kind = req.body?.kind;
    if (!["presence", "manifest", "detail"].includes(kind)) {
      return res.status(400).json({ error: "kind must be one of presence|manifest|detail" });
    }
    let payload;
    if (kind === "detail") {
      payload = sanitizeDetail(req.body?.payload ?? {});
    } else {
      const allowed = kind === "presence" ? PRESENCE_FIELDS : MANIFEST_FIELDS;
      payload = shapeWhitelisted(req.body?.payload ?? {}, allowed);
      if (kind === "presence" && typeof payload.state !== "string") {
        return res.status(400).json({ error: "presence.payload.state is required" });
      }
      if (kind === "manifest") {
        for (const k of ["fleetCount", "memberCount", "enabledTaskCount"]) {
          if (payload[k] != null && !Number.isFinite(payload[k])) {
            return res.status(400).json({ error: `manifest.payload.${k} must be a number` });
          }
        }
      }
    }

    // Roster liveness rides the door: every arrival refreshes lastSeenAt, so
    // the machines view never needs a probe or the sister-repo ingest.
    if (machines) {
      machines.touch(who.did, {
        ownerEmail: who.email,
        presence: kind === "presence" ? payload : undefined,
      });
      if (kind === "detail") machines.recordDetail(who.did, payload);
    }

    // cell_detail is store-only: the ops board's event contract is unchanged.
    if (kind === "detail") return res.status(202).json({ accepted: true, relayed: false });

    const event = {
      id: crypto.randomUUID(),
      source: "cell-steward",
      agent: `cell-steward:${who.did}`,
      kind: `cell_${kind}`,
      ts: now(),
      payload,
    };
    const relayed = await relay(event);
    return res.status(202).json({ accepted: true, relayed });
  }

  return { handle, relayOn, steward };
}

// The desired-state pull door (add-unified-fleet-console): a steward reads
// ONLY its own machine's desired deployment set. Self-scoped — the machine is
// the token's `did`; the endpoint accepts no device parameter at all, so
// cross-machine reads are impossible by construction.
export function createDesiredFleetDoor({ appAuth, machines }) {
  async function handle(req, res) {
    const bearer = String(req.headers.authorization || "").startsWith("Bearer ")
      ? String(req.headers.authorization).slice(7)
      : null;
    const who = bearer ? appAuth.stewardFromToken(bearer) : null;
    if (!who) return res.status(401).json({ error: "steward credential required" });
    const row = machines?.get(who.did) ?? null;
    if (!row?.desired) return res.json({ version: 0, entries: [] });
    return res.json({ version: row.desired.version, entries: row.desired.entries ?? [], updatedAt: row.desired.at ?? null });
  }
  return { handle };
}
