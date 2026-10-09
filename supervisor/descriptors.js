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
  ];
}
