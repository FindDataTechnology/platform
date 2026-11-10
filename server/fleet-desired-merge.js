// ── Desired-state merge + detail beacon (add-unified-fleet-console) ─────────
//
// The cell-side half of the beacon handshake with the resident steward
// (design D2/D5): the steward pulls the cloud desired set and writes
// `fleet-desired.json` into the shared data dir; THIS module is the cell's
// single writer of its own deployment store — it merges the beacon by the
// local-manual-wins rules and records the outcome in `fleet-detail.json`,
// which the steward reads read-only and relays as cell_detail.
//
// Merge rules (design D1, spec cell-lifecycle delta):
//   desired entry enabled   + no local row        → deploy via the existing
//                                                    gates, tagged source=cloud
//   desired entry enabled   + cloud row           → reconcile enabled state
//   desired entry enabled   + MANUAL row          → skip (local wins)
//   desired entry disabled  + cloud row           → stop the row (stays cloud)
//   desired entry absent    + cloud row           → remove (cloud withdrew it)
//   any rejection (capacity / not deployable)     → structured reject, written
//                                                    back into the detail
//                                                    beacon — never silent
//
// Every file op degrades open: an unreadable beacon is "no expectation this
// beat", never an error surfaced to the user.

import path from "node:path";
import fs from "node:fs";
import { atomicWriteJsonSync } from "../lib/persistence.js";
import {
  agentPathFor,
  capacityInfo,
  deployLocalAgent,
  getDeployment,
  listDeployments,
  removeDeployment,
  setDeploymentEnabled,
} from "./local-agent-feed.js";
import { isDbReady } from "../db.js";

const DESIRED_FILE = "fleet-desired.json";
const DETAIL_FILE = "fleet-detail.json";

function dataDirOf(env) {
  return String(env.PLATFORM_DATA_DIR || "").trim();
}

export function desiredBeaconPath(env = process.env) {
  const dir = dataDirOf(env);
  return dir ? path.join(dir, DESIRED_FILE) : null;
}

export function detailBeaconPath(env = process.env) {
  const dir = dataDirOf(env);
  return dir ? path.join(dir, DETAIL_FILE) : null;
}

function readJsonSafe(file) {
  if (!file) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export function readDesiredBeacon(env = process.env) {
  const doc = readJsonSafe(desiredBeaconPath(env));
  if (!doc || typeof doc.version !== "number" || !Array.isArray(doc.entries)) return null;
  return doc;
}

// Five-states ride the runner's own /health (the same loopback call the fleet
// page's /live route makes); a runner that is not up simply reports nothing.
async function runnerAgents(env, doFetch) {
  const base = String(env.WANXING_RUNNER_URL || "http://127.0.0.1:8790").replace(/\/+$/, "");
  try {
    const r = await doFetch(`${base}/health`, { signal: AbortSignal.timeout(2000) });
    if (!r.ok) return [];
    const body = await r.json();
    return Array.isArray(body?.agents) ? body.agents : [];
  } catch {
    return [];
  }
}

export function writeDetailBeacon({ env = process.env, mergeState = null, agents = null } = {}) {
  const file = detailBeaconPath(env);
  if (!file) return null;
  const prev = readJsonSafe(file);
  const doc = {
    at: Date.now(),
    capacity: capacityInfo(env),
    deployments: listDeployments().map((d) => ({
      agentPath: d.agentPath,
      packId: d.packId,
      agentId: d.agentId,
      enabled: d.enabled,
      source: d.source,
    })),
    agents: agents ?? prev?.agents ?? [],
    merge: mergeState ?? prev?.merge ?? { desiredVersionSeen: null, rejects: [] },
  };
  atomicWriteJsonSync(file, doc);
  return doc;
}

// One merge pass. Returns the merge state that also lands in the detail beacon.
export function mergeDesired({ env = process.env, now = Date.now } = {}) {
  const beacon = readDesiredBeacon(env);
  if (!beacon) return null; // no expectation on this machine (uplink off, or never pulled)
  // A merge run against a closed database is a NO-OP that must not be recorded
  // as applied: listDeployments() silently answers [] when the db is not ready,
  // so the withdrawal sweep would sweep nothing yet still stamp this version
  // as seen — and the next (ready) beat would skip it, leaving cloud rows
  // behind forever. Boot beats race db.initDb() in single-process mode.
  if (!isDbReady()) return null;
  const detail = readJsonSafe(detailBeaconPath(env));
  const lastApplied = detail?.merge?.desiredVersionSeen ?? null;
  const rejects = [];

  if (lastApplied !== beacon.version) {
    const desiredKeys = new Set(beacon.entries.map((e) => `${e.packId}/${e.agentId}`));

    for (const entry of beacon.entries) {
      const agentPath = agentPathFor(entry.packId, entry.agentId);
      const existing = getDeployment(agentPath);
      if (!existing) {
        if (entry.enabled === false) continue;
        const out = deployLocalAgent({ packId: entry.packId, agentId: entry.agentId, source: "cloud" });
        if (out.error) rejects.push({ agentPath, code: out.error.code ?? "deploy_failed" });
        continue;
      }
      if (existing.source !== "cloud") continue; // local manual wins
      const wantEnabled = entry.enabled !== false;
      if (Boolean(existing.enabled) !== wantEnabled) {
        const out = setDeploymentEnabled(agentPath, wantEnabled, { source: "cloud" });
        if (out.error) rejects.push({ agentPath, code: out.error.code ?? "reconcile_failed" });
      }
    }

    // Cloud withdrew an expectation → its cloud rows go away. Manual rows and
    // rows the desired set still names are untouched.
    for (const row of listDeployments()) {
      if (row.source !== "cloud") continue;
      if (!desiredKeys.has(`${row.packId}/${row.agentId}`)) {
        removeDeployment(row.agentPath);
      }
    }
  }

  const mergeState = { desiredVersionSeen: beacon.version, rejectedCount: rejects.length, rejects, at: now() };
  return mergeState;
}

// The cell-side beat: merge (if the beacon changed) then always rewrite the
// detail beacon so the steward relays fresh truth. Also the orphan-prune hook
// the residency hardening already runs on boot.
export function startDesiredMergeLoop({ env = process.env, intervalMs = 60_000, doFetch = fetch } = {}) {
  if (!dataDirOf(env)) return null; // no data dir → beacon handshake impossible
  let timer = null;
  async function beat() {
    try {
      const mergeState = mergeDesired({ env });
      // null = nothing merged (no beacon, or the db is not open yet). Not a
      // success for the caller's purposes: the boot retry must keep trying
      // until a real merge pass lands, otherwise "converge on restart" waits
      // for the 60s interval (measured).
      if (mergeState === null) return false;
      const agents = await runnerAgents(env, doFetch);
      writeDetailBeacon({ env, mergeState, agents });
      return true;
    } catch {
      // degrade-open: the cell's other duties never wait on this loop
      return false;
    }
  }
  // First beat: on boot the cluster converges via convergeLocalCluster; the
  // merge rides the first tick so a desired edit made while the machine was
  // offline lands immediately after restart.
  //
  // That first tick fires during module init, BEFORE db.initDb() opens the
  // project database (server.js starts this loop early, the db much later), so
  // mergeDesired throws "database not ready" and the promise of "lands right
  // after restart" silently degraded to "lands up to a minute later" —
  // measured: exactly 60s, i.e. the retry never happened and the interval did
  // the work. Keep retrying until the db is open; the steady interval carries
  // on regardless.
  timer = setInterval(() => void beat(), intervalMs);
  timer.unref?.();
  (async () => {
    for (let attempt = 0; attempt < 120; attempt++) {
      if (await beat()) return;
      await new Promise((r) => { const t = setTimeout(r, 1000); t.unref?.(); });
    }
  })();
  return { stop: () => timer && clearInterval(timer), beat };
}
