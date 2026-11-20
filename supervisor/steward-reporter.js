// ── Steward uplink client (add-cell-lifecycle 4.3) ─────────────────────────
//
// presence/manifest reporting to the gateway's cell-report door. Contract:
//   explicit-off by default  — the reporter only exists once the user has
//     paired (pair file present = explicitly opted in, consent line ③ at
//     install time names payloads individually)
//   degrade-open             — platform unreachable ⇒ bounded ring buffer or
//     drop, never a stall, never a modal
//   401 self-destruct        — the console revoked this pairing: burn the
//     local identity (key+token+pair file) and go dark; a re-pair is a fresh
//     bind code, by design (see cell-lifecycle destroy protocol)

import fs from "node:fs";
import path from "node:path";
import { STEWARD_PROTOCOL_VERSION } from "../lib/cell-lifecycle.js";
import { readCronJobs, cellJobsFile } from "../lib/cell-lifecycle.js";
import { refreshStewardToken } from "./steward-identity.js";

const PAIR_FILE = "steward-pair.json";
const BUF_MAX = 100;
// add-unified-fleet-console: beacon files shared with the cell (single writer
// each — the cell authors detail, this reporter authors desired) and the
// crash guard's persisted state, all read read-only from the same data dir.
const DESIRED_FILE = "fleet-desired.json";
const DETAIL_FILE = "fleet-detail.json";
const HEALTH_FILE = "steward-health.json";

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(path.join(file), "utf8"));
  } catch {
    return null;
  }
}

function atomicWriteJson(file, value) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function readPairFile(dataDir) {
  try { return JSON.parse(fs.readFileSync(path.join(dataDir, PAIR_FILE), "utf8")); } catch { return null; }
}

export function createStewardReporter({
  steward,
  dataDir,
  storage,
  appVersion = "0.0.0",
  tickMs = 60_000,
  fetchImpl = null,
  manifestFn = null,
}) {
  const pair = readPairFile(dataDir);
  const state = {
    token: pair?.token ?? null,
    deviceId: pair?.deviceId ?? null,
    gatewayUrl: pair?.gatewayUrl ?? null,
    email: pair?.email ?? null,
    buffer: [],
    // Desired-state pull bookkeeping (add-unified-fleet-console): consecutive
    // failures feed the machine's self-reported health; the version gates the
    // beacon write so an unchanged cloud edits nothing locally.
    pullFailures: 0,
    lastDesiredVersion: null,
  };
  let timer = null;
  let running = false;
  const doFetch = fetchImpl ?? defaultFetch;

  async function defaultFetch(url, { method = "POST", headers = {}, body }) {
    const res = await fetch(url, {
      method,
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  }

  function noteReport(ok) {
    const row = steward.registry.get(steward.cellId);
    if (row) steward.registry.put({ ...row, lastReportAt: ok ? Date.now() : row.lastReportAt ?? null });
  }

  async function postOnce(kind, payload) {
    if (!state.token) return { skipped: "no-token" };
    const res = await doFetch(`${state.gatewayUrl}/api/gateway/cell-report`, {
      headers: { authorization: `Bearer ${state.token}` },
      body: { kind, payload },
    });
    if (res.status === 401) {
      const refreshed = await refreshStewardToken({ gatewayUrl: state.gatewayUrl, deviceId: state.deviceId, storage }).catch(() => null);
      if (refreshed) {
        state.token = refreshed;
        fs.writeFileSync(path.join(dataDir, PAIR_FILE), JSON.stringify({ ...state, token: refreshed }, null, 2), { mode: 0o600 });
        const retry = await doFetch(`${state.gatewayUrl}/api/gateway/cell-report`, {
          headers: { authorization: `Bearer ${state.token}` },
          body: { kind, payload },
        });
        if (retry.status !== 401) return { accepted: retry.status === 202, retried: true };
      }
      // Second 401: pairing is dead — self-destruct (spec 5.1 channel ③).
      await selfDestruct();
      return { dead: true };
    }
    return { accepted: res.status === 202 };
  }

  async function selfDestruct() {
    console.warn("[steward-reporter] server revoked this pairing (401) — burning local identity and going dark");
    try { await storage.remove(); } catch { /* */ }
    try { fs.rmSync(path.join(dataDir, PAIR_FILE), { force: true }); } catch { /* */ }
    state.token = null;
    stopReporter_();
  }

  // Desired-state pull (add-unified-fleet-console): the machine reads ONLY
  // its own expectation set — the door is self-scoped by the token's device
  // id, so there is nothing here to address. The result lands in the cell's
  // desired beacon; the CELL merges (it is the deployment store's single
  // writer). Consecutive failures ride cell_detail as self-reported health.
  async function pullDesired() {
    if (!state.token) return;
    let res;
    try {
      res = await doFetch(`${state.gatewayUrl}/api/gateway/desired-fleet`, {
        // GET, explicitly: the door mounts on app.get and defaultFetch's POST
        // default would fall through to the generic session-auth layer
        // (401 "Authentication required"), which the reporter reads as a
        // revoked pairing — burning a healthy identity on the first tick.
        method: "GET",
        headers: { authorization: `Bearer ${state.token}` },
      });
    } catch {
      state.pullFailures = Math.min(state.pullFailures + 1, 999);
      return;
    }
    if (res.status === 401) {
      const refreshed = await refreshStewardToken({ gatewayUrl: state.gatewayUrl, deviceId: state.deviceId, storage }).catch(() => null);
      if (refreshed) {
        state.token = refreshed;
        fs.writeFileSync(path.join(dataDir, PAIR_FILE), JSON.stringify({ ...state, token: refreshed }, null, 2), { mode: 0o600 });
        try {
          res = await doFetch(`${state.gatewayUrl}/api/gateway/desired-fleet`, {
            method: "GET",
            headers: { authorization: `Bearer ${refreshed}` },
          });
        } catch {
          state.pullFailures = Math.min(state.pullFailures + 1, 999);
          return;
        }
      }
      if (res.status === 401) {
        await selfDestruct();
        return;
      }
    }
    if (res.status !== 200) {
      state.pullFailures = Math.min(state.pullFailures + 1, 999);
      return;
    }
    const body = res.body ?? null; // defaultFetch's contract: {status, body}
    if (!body || typeof body.version !== "number" || !Array.isArray(body.entries)) {
      state.pullFailures = Math.min(state.pullFailures + 1, 999);
      return;
    }
    state.pullFailures = 0;
    if (body.version === state.lastDesiredVersion) return;
    state.lastDesiredVersion = body.version;
    try {
      atomicWriteJson(path.join(dataDir, DESIRED_FILE), { version: body.version, entries: body.entries, pulledAt: Date.now() });
    } catch { /* unwritable data dir: nothing to merge, cell converges locally */ }
  }

  // cell_detail relay: the cell authors fleet-detail.json (its deployments,
  // five-states, merge outcome); this adds the steward's own self-health and
  // posts it. Buffered like manifest on failure — degrade-open.
  async function postDetail() {
    const detail = readJsonSafe(path.join(dataDir, DETAIL_FILE));
    if (!detail) return;
    const health = readJsonSafe(path.join(dataDir, HEALTH_FILE)) ?? {};
    const payload = {
      ...detail,
      steward: { crashRestarts: Number(health.failures ?? 0), pullFailures: state.pullFailures },
    };
    const out = await postOnce("detail", payload);
    if (!out.accepted && !out.dead && !out.retried) {
      if (state.buffer.length < BUF_MAX) state.buffer.push({ kind: "detail", payload });
    }
  }

  async function tick() {
    if (state.buffer.length > 0) {
      const head = state.buffer[0];
      const out = await postOnce(head.kind, head.payload);
      if (out.accepted || out.retried || out.dead) {
        if (!out.dead) state.buffer.shift();
        else state.buffer.length = 0;
      } else {
        // Platform down: keep shape, drop the oldest when at cap (degrade-open).
        noteReport(false);
        if (state.buffer.length >= BUF_MAX) state.buffer.shift();
        return;
      }
    }
    // manifestFn is synchronous by design (reads the cell's own stores); a
    // sync throw must reach tick's catch as a rejection, not a TypeError on
    // `.catch` of a plain value — the silent-dead-uplink bug (smoke-caught).
    let base = null;
    if (manifestFn) {
      try { base = await manifestFn(); } catch { base = null; }
    }
    if (!base) base = defaultManifest();
    const presence = { state: steward.running ? "running" : "suspended", os: process.platform, appVersion, protocolVersion: STEWARD_PROTOCOL_VERSION, at: Date.now() };
    await postOnce("presence", presence);
    const manifest = {
      fleetCount: base.fleetCount ?? 0,
      memberCount: base.memberCount ?? 0,
      enabledTaskCount: base.enabledTaskCount ?? 0,
      labels: base.labels ?? [],
      at: Date.now(),
    };
    const out = await postOnce("manifest", manifest);
    if (!out.accepted && !out.dead && !out.retried) {
      if (state.buffer.length < BUF_MAX) state.buffer.push({ kind: "manifest", payload: manifest });
      noteReport(false);
    } else {
      noteReport(true);
    }
    if (out.dead) return;
    // The pull + detail lanes ride the same beat (add-unified-fleet-console):
    // machine reads its expectation, then relays the cell's detail snapshot.
    await pullDesired();
    await postDetail();
  }

  function defaultManifest() {
    const jobs = readCronJobs(cellJobsFile(dataDir));
    return { enabledTaskCount: jobs.filter((j) => j?.cron && !j?.paused).length, fleetCount: 0, memberCount: 0, labels: [] };
  }

  function stopReporter_() {
    running = false;
    if (timer) clearInterval(timer);
    timer = null;
  }

  return {
    // Live, not a construction snapshot: after a 401 self-destruct the pair
    // is dead and callers must see that (test-fleet-desired-merge 3.3).
    get enabled() {
      return Boolean(state.token);
    },
    state,
    start() {
      if (running || !state.token) return;
      running = true;
      timer = setInterval(() => void tick().catch(() => {}), tickMs);
      timer.unref?.();
      void tick().catch(() => {});
    },
    stop: stopReporter_,
    tick,
    selfDestruct,
  };
}
