// ── Runner-side fleet bridge (add-fleet-bridge-endpoint-for-agent-runner 2.1) ─
//
// Why this exists: a fleet post running on an agent-runner pod could not reach
// its own fleet tools at all. Measured 2026-11-14 on the live runner: 19
// `mcp.patch.yml`, ZERO containing `fleet`; the cell's satellites listen on
// 127.0.0.1 only, and the platform bridge's trust is "loopback AND no
// x-forwarded-email" — a runner pod is neither. The row was not missing by
// accident, there was nothing for it to point at.
//
// What this module starts: ONE satellite host per runner pod (the same
// `createMcpSatelliteHost` the cell uses) serving the fleet MCP children at
// `/<name>/mcp`. Homes get plain streamable-http rows pointing at that loopback
// origin, which keeps `mcpEntry()` and the patch format unchanged.
//
// Identity deliberately does NOT live here. The runner hosts many homes per pod
// with one shared patch, so a member id in the child's env would make every
// home in the pack report as that member (that is a signature on someone else's
// work, not a weaker identity). The per-turn `turn_token` the platform writes
// into the round's prompt is the channel, and it is carrier-independent.
//
// Failure visibility (design 1.3): `failOnStartupError: false` turns "the row
// is there but the endpoint is dead" into "the tool is simply absent", which is
// indistinguishable from a pack that never declared it. So this module refuses
// to hand back a URL it could not prove: it probes the platform route first and
// records the outcome at `<homeRoot>/.fleet-bridge-status.json` — a fact
// something can fail on, instead of a log line nobody reads.

import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createMcpSatelliteHost } from "../server/mcp-satellite-host.js";
import { FLEET_BRIDGE_SERVERS, fleetBridgeMcpRows } from "./fleet-bridge-rows.js";

export { fleetBridgeMcpRows };

export const FLEET_BRIDGE_STATUS_FILE = ".fleet-bridge-status.json";

// The gateway mount the children call (`/api/runner-fleet/fleets/*` and
// `/api/runner-fleet/architect/*` — server.js registers both). ONE constant for
// the child env and the row header: the header is what actually reaches the
// child per call, so a base derived twice is a base that can drift into
// `unknown satellite endpoint`.
export const FLEET_BRIDGE_MOUNT = "/api/runner-fleet";

// The satellites a runner-hosted post needs: the report/decision lane, plus the
// read-only architect face (fleet_list). Draft/apply are NOT mounted on the
// runner side, so the child's write verbs cannot be used even if the model asks.
export const RUNNER_FLEET_SATELLITES = FLEET_BRIDGE_SERVERS;

const SCRIPT_FOR = {
  fleet: "fleet-mcp.js",
  "fleet-architect": "fleet-architect-mcp.js",
};

export function fleetBridgeStatusPath(homeRoot) {
  return path.join(homeRoot, FLEET_BRIDGE_STATUS_FILE);
}

/** Record the outcome where a judge can read it. Never throws: status I/O must
 * not be able to take the runner down. */
export function recordFleetBridgeStatus(homeRoot, status, log = console) {
  try {
    writeFileSync(fleetBridgeStatusPath(homeRoot), `${JSON.stringify(status, null, 2)}\n`);
  } catch (err) {
    log.warn?.(`[agent-runner:fleet-bridge] status write failed: ${err?.message || err}`);
  }
  const how = status.state === "ok" ? "ready" : status.state;
  log.log?.(`[agent-runner:fleet-bridge] ${how}: ${status.reason ?? status.origin ?? ""}`);
  return status;
}

/**
 * Probe the runner-facing platform route with the SAME bearer the child will
 * use. A probe that only checked reachability would pass while the token is
 * wrong — which is exactly the failure that looks like "tools are missing".
 *
 * The gateway door (add-fleet-bridge-endpoint-for-agent-runner 4.3) answers
 * `400 x-fleet-owner is required` to a caller that presents a VALID bearer but
 * no owner — and boot-time is exactly such a caller: the owner is a per-agent
 * coordinate, while this probe runs once per pod before any agent is composed.
 * So 400-with-that-error is the success signal here: it proves the request got
 * past the token check, which is the only thing the probe can know at boot.
 * Treating it as a failure would leave every healthy pod at `state:"missing"`;
 * treating 401/503 as success would hide the real thing the probe is for.
 */
export async function probeRunnerFleetBridge({ url, token, fetchImpl = fetch, timeoutMs = 8_000 }) {
  const res = await fetchImpl(`${url}/api/runner-fleet/architect/fleets`, {
    method: "GET",
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.ok) return true;
  const body = await res.json().catch(() => ({}));
  const error = String(body?.error ?? "");
  if (res.status === 400 && /x-fleet-owner/i.test(error)) return true;
  throw new Error(`HTTP ${res.status}${error ? ` ${error}` : ""}`);
}

/**
 * Start the per-pod fleet bridge. Returns `{ origin, base, host, status }` where
 * `origin` is null unless the probe AND the host both succeeded — callers add
 * MCP rows only when `origin` is non-null.
 *
 * Boot-time is the WORST moment for a single probe: the pod comes up while the
 * platform itself may be mid-roll (measured live 2026-11-14/15 — three times a
 * probe fired inside the rollout window and the pod stayed `missing` for its
 * whole life, because nothing retries). So a failed probe also arms a recovery
 * timer (see `scheduleRunnerFleetBridgeRecovery`); `index.js` calls it and the
 * handle flips in place on the first successful probe.
 */
export async function attachRunnerFleetBridge({
  url,
  token,
  homeRoot,
  log = console,
  fetchImpl = fetch,
  satellites = RUNNER_FLEET_SATELLITES,
} = {}) {
  const at = new Date().toISOString();
  const base = { url: url ?? null, at };
  if (!url || !token) {
    return {
      origin: null,
      host: null,
      base: null,
      url: url ?? null,
      token: token ?? null,
      homeRoot,
      log,
      fetchImpl,
      status: recordFleetBridgeStatus(
        homeRoot,
        { ...base, state: "off", reason: "AGENT_RUNNER_FLEET_BRIDGE_URL/TOKEN not set" },
        log,
      ),
    };
  }
  try {
    await probeRunnerFleetBridge({ url, token, fetchImpl });
  } catch (err) {
    return {
      origin: null,
      host: null,
      base: null,
      url,
      token,
      homeRoot,
      log,
      fetchImpl,
      status: recordFleetBridgeStatus(
        homeRoot,
        { ...base, state: "missing", reason: `probe failed: ${err?.message || err}` },
        log,
      ),
    };
  }
  const env = {
    ...process.env,
    FLEET_ARCHITECT_MCP_URL: String(url).replace(/\/+$/, ""),
    FLEET_MCP_BRIDGE_PREFIX: FLEET_BRIDGE_MOUNT,
    FLEET_MCP_BRIDGE_TOKEN: token,
  };
  const specs = satellites
    .filter((name) => SCRIPT_FOR[name])
    .map((name) => ({
      name,
      // Same discipline as the cell wiring: pin our own binary, never PATH.
      command: process.execPath,
      args: [fileURLToPath(new URL(`../server/${SCRIPT_FOR[name]}`, import.meta.url))],
      env,
    }));
  const host = createMcpSatelliteHost({ satellites: specs, port: 0, logger: log });
  try {
    await host.start();
  } catch (err) {
    await host.stop().catch(() => {});
    return {
      origin: null,
      host: null,
      url,
      token,
      homeRoot,
      log,
      fetchImpl,
      status: recordFleetBridgeStatus(
        homeRoot,
        { ...base, state: "missing", reason: `satellite host failed to start: ${err?.message || err}` },
        log,
      ),
    };
  }
  const origin = `http://127.0.0.1:${host.port}`;
  // The gateway mount (not `origin`): the rows put THIS in `x-fleet-bridge-base`
  // and the child appends `/fleets/…`. Recorded in the status file too, so a
  // `unknown satellite endpoint` report can be diagnosed without a shell.
  const bridgeBase = `${String(url).replace(/\/+$/, "")}${FLEET_BRIDGE_MOUNT}`;
  const status = recordFleetBridgeStatus(homeRoot, { ...base, base: bridgeBase, state: "ok", origin }, log);
  return { origin, base: bridgeBase, host, url, token, homeRoot, log, fetchImpl, status };
}

/**
 * Historical entry point. Same behavior as `attachRunnerFleetBridge` (one
 * probe, attach-or-record); recovery is opt-in via the scheduler below.
 */
export async function startRunnerFleetBridge(options = {}) {
  return attachRunnerFleetBridge(options);
}

/**
 * Boot-time probe retry, in the background. A single probe raced the platform
 * rollout window three times in one day (2026-11-14/15): the pod stayed
 * `missing` for its whole life while the SAME call from the same pod succeeded
 * seconds later. Retry with a bounded budget; on the first success flip the
 * handle in place (rows are composed per spawn, so the next agent home picks
 * the bridge up with no restart) and rewrite the status file.
 *
 * Returns the timer (caller owns clearing it on shutdown), or null when there
 * is nothing to recover (already ok, or off by config — an env-absence is a
 * decision, not a transient, so it must NOT silently turn itself on).
 */
export function scheduleRunnerFleetBridgeRecovery(
  handle,
  {
    intervalMs = 10_000,
    maxAttempts = 30,
    fetchImpl = null,
    attachImpl = attachRunnerFleetBridge,
    setIntervalImpl = setInterval,
    clearIntervalImpl = clearInterval,
  } = {},
) {
  if (!handle || handle.origin) return null;
  if (!handle.url || !handle.token) return null;
  const fetchFn = fetchImpl ?? handle.fetchImpl ?? fetch;
  const log = handle.log ?? console;
  let attempts = 0;
  const timer = setIntervalImpl(async () => {
    attempts += 1;
    let probeError = null;
    try {
      await probeRunnerFleetBridge({ url: handle.url, token: handle.token, fetchImpl: fetchFn });
    } catch (err) {
      probeError = err?.message || String(err);
    }
    if (probeError) {
      if (attempts >= maxAttempts) {
        clearIntervalImpl(timer);
        handle.status = recordFleetBridgeStatus(
          handle.homeRoot,
          { url: handle.url, at: new Date().toISOString(), state: "missing", reason: `probe still failing after ${attempts} recovery attempts: ${probeError}` },
          log,
        );
        log.warn?.(`[agent-runner:fleet-bridge] recovery gave up after ${attempts} attempts: ${probeError}`);
      }
      return;
    }
    clearIntervalImpl(timer);
    const attached = await attachImpl({
      url: handle.url,
      token: handle.token,
      homeRoot: handle.homeRoot,
      log,
      fetchImpl: fetchFn,
    });
    if (attached.origin) {
      handle.origin = attached.origin;
      handle.base = attached.base;
      handle.host = attached.host;
      handle.status = attached.status;
      log.log?.(`[agent-runner:fleet-bridge] recovered after ${attempts} attempt(s): ${handle.origin}`);
    }
  }, intervalMs);
  if (typeof timer?.unref === "function") timer.unref();
  return timer;
}
