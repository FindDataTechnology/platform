// ── Server descriptor registry ──────────────────────────────────────────────
//
// Declares the backend servers the supervisor manages (spec: "Server
// descriptor registry"). Each descriptor is a transport-agnostic record:
//   - kind:        "node" | "http-external"
//   - transport:   "http-port" | "stdio-rpc" | "none"
//   - enabled:     whether the supervisor starts/probes it
//   - optional:    if false, failure blocks app launch (per graceful-degradation spec)
//   - start:       { cmd, args, cwd, env } for spawned kinds
//   - url/healthPath: for HTTP health probes
//   - dependsOn:   ids that must be healthy first (startup ordering)
//
// LiteLLM, Postgres and OpenConnector are no longer bundled — dsh's native
// plugins cover LLM routing and SaaS connectors, so server.js is the only
// process the supervisor spawns. A customer who wants those services runs them
// separately and points the app at their URL.

import path from "node:path";
import { existsSync } from "node:fs";
import { homedir } from "node:os";

export function getDescriptors({ serverPort, projectRoot, nodeBin, dataDir, agentEnv = {} }) {
  const childEnv = {
    PORT: String(serverPort),
    // Respect HOST from the environment so the backend can bind 0.0.0.0 in a
    // container (k8s probes + docker port-forward reach it). Defaults to
    // localhost for local dev (the Vite dev proxy + WS client expect it).
    HOST: process.env.HOST || "localhost",
    ...(dataDir ? { PLATFORM_DATA_DIR: dataDir } : {}),
    ...agentEnv,
  };

  // ── Wanxing fleet plugin (openspec: desktop-fleet-runner) ────────────────
  // Preinstalled, disabled by default. Flipping WANXING_PLUGIN_ENABLED in
  // settings.json + restarting the app turns the desktop into a Wanxing
  // runner seat. Optional: a failing/unhealthy runner degrades to a status
  // row and never blocks the chat backend or the window.
  const wanxingEnabled = agentEnv.WANXING_PLUGIN_ENABLED === "1";
  // The seat id is minted once by first-run bootstrap; a missing value (dev
  // without bootstrap) falls back to a per-boot ephemeral id rather than the
  // cloud default "runner-1" — a desktop must never host the untagged slice.
  const seatId = agentEnv.WANXING_PLUGIN_RUNNER_ID || `desktop-ephemeral-${process.pid}`;
  const runnerPort = Number(agentEnv.AGENT_RUNNER_PORT || 8790);
  // Same recipe dsh-bridge uses for the packaged layout: run the dependency
  // tree's dsh Node entry through the bundled Node — spawnable on Windows
  // (extensionless .bin shims are not) and ABI-consistent for native addons.
  const dshEntry = path.join(projectRoot, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
  const runnerEnv = {
    ...childEnv,
    DSH_BIN: nodeBin,
    ...(existsSync(dshEntry) ? { DSH_BIN_ARGS: JSON.stringify([dshEntry]) } : {}),
    AGENT_RUNNER_HOME: path.join(dataDir || projectRoot, "wanxing-runner"),
    AGENT_RUNNER_PORT: String(runnerPort),
    // Loopback only on the desktop: agent A2A ports must not face the LAN.
    AGENT_RUNNER_HOST: "127.0.0.1",
    // Pod density by default (grill Q6): same-pack agents co-host one runtime.
    AGENT_RUNNER_POD_MODE: "1",
    // Sharding safety (design D3): the seat id is a fleet id nothing else
    // uses, and the default-runner sentinel can never match a real machine —
    // so the desktop polls only entries explicitly tagged to this seat.
    AGENT_RUNNER_FLEET_ID: seatId,
    AGENT_RUNNER_DEFAULT_ID: "cloud-default",
    // Desktop seat self-report (③): the board marks this runner as scheduling-
    // invisible. Fleet uplink itself stays user-configured (Preferences) — an
    // unconfigured seat simply never appears on any board.
    AGENT_RUNNER_DESKTOP: "1",
    ...(agentEnv.AGENT_RUNNER_FLEET_URL ? { AGENT_RUNNER_FLEET_URL: agentEnv.AGENT_RUNNER_FLEET_URL } : {}),
    ...(agentEnv.AGENT_RUNNER_FLEET_TOKEN ? { AGENT_RUNNER_FLEET_TOKEN: agentEnv.AGENT_RUNNER_FLEET_TOKEN } : {}),
    // Profile scaffold source: the same shared dsh home the chat cell uses
    // (~/.dsh — the cell's ensureDshHome establishes it on first boot).
    // Cloud images keep their baked /opt/dsh-home default by never running
    // through this descriptor.
    ...(() => {
      const shared = path.join(homedir(), ".dsh");
      return existsSync(path.join(shared, "profiles", "platform")) ? { AGENT_RUNNER_SEED_HOME: shared } : {};
    })(),
  };

  return [
    {
      id: "server-js",
      name: "Platform backend",
      kind: "node",
      transport: "http-port",
      enabled: true,
      optional: false,
      start: {
        cmd: nodeBin,
        args: [path.join(projectRoot, "server.js")],
        cwd: projectRoot,
        env: childEnv,
      },
      // Probe the address the backend actually BOUND (childEnv.HOST — agentEnv
      // may pin it to 127.0.0.1 on desktop): a hardcoded "localhost" probe
      // stayed green while the window's 127.0.0.1 load hit a closed IPv4
      // socket on hosts where localhost resolves ::1-only (v1.3.5 black screen).
      url: `http://${childEnv.HOST}:${serverPort}`,
      healthPath: "/api/config",
      dependsOn: [],
    },
    {
      id: "agent-runner-js",
      name: "Wanxing fleet runner",
      kind: "node",
      transport: "http-port",
      enabled: wanxingEnabled,
      optional: true,
      start: {
        cmd: nodeBin,
        args: [path.join(projectRoot, "agent-runner", "index.js")],
        cwd: projectRoot,
        env: runnerEnv,
      },
      // AGENT_RUNNER_HOST is pinned to 127.0.0.1 above, so probe loopback.
      url: `http://127.0.0.1:${runnerPort}`,
      healthPath: "/health",
      dependsOn: [],
    },
  ];
}
