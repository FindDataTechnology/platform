// ── Agent-runner configuration (add-a2a-agent-serving D2/D10) ───────────────
//
// One place that reads the runner's env so the rest of the service stays
// injection-friendly for tests. Everything has a default that makes an inert
// local boot possible; production values come from the compose env file
// (operator runbook).

import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);

export function loadConfig(env = process.env) {
  return {
    repoRoot,
    // Where private per-agent DSH_HOMEs and skill compose roots live. A
    // volume in compose; a tmp dir in tests.
    homeRoot: env.AGENT_RUNNER_HOME || path.join(repoRoot, "runner-home"),
    port: num(env.AGENT_RUNNER_PORT, 8790),

    // Registry (the runtime distribution plane — design D2/ADR-0004).
    registryUrl: (env.AGENT_SERVING_REGISTRY_URL || env.REGISTRY_URL || "").replace(/\/+$/, ""),
    registryToken: env.AGENT_SERVING_REGISTRY_TOKEN || env.MARKET_REGISTRY_TOKEN || "",
    // Poll cadence; spec bound is "effective within five minutes".
    pollSecs: num(env.AGENT_RUNNER_POLL_SECS, 60),

    // The LLM every child uses — runner-level by design (design D8): model
    // choice is a deployment concern, never a serving-contract field.
    provider: env.AGENT_RUNNER_PROVIDER || "deepseek-official",
    model: env.AGENT_RUNNER_MODEL || "deepseek-v4-flash",

    // Gateway-injected backend credential (design D6): when set, every
    // inbound request (card + JSON-RPC) must carry it as a Bearer token, so
    // direct-to-runner calls that skipped the registry gateway are rejected.
    // Empty = dev mode (warn once, accept) — production sets it.
    backendToken: env.AGENT_RUNNER_BACKEND_TOKEN || "",

    // Child lifecycle (spec: agent-runner "Child lifecycle is bounded and
    // queued"): reap after idle, bound concurrency with queueing, drain
    // in-flight turns on upgrade/undeploy.
    idleMs: num(env.AGENT_RUNNER_IDLE_SECS, 30 * 60) * 1000,
    maxChildren: num(env.AGENT_RUNNER_MAX_CHILDREN, 4),
    drainMs: num(env.AGENT_RUNNER_DRAIN_SECS, 300) * 1000,
    turnTimeoutMs: num(env.AGENT_RUNNER_TURN_TIMEOUT_MS, 180_000),

    // dsh spawn knobs (mirror dsh-bridge.js).
    dshBin: env.DSH_BIN || "dsh",
    dshProfile: env.DSH_PROFILE || "platform",
    cwd: env.AGENT_RUNNER_CWD || repoRoot,

    // Per-agent listener port pool (the registry proxy maps /agent/{path} onto
    // the registered origin — one agent per origin, upstream #1734).
    portBase: num(env.AGENT_RUNNER_PORT_BASE, 8791),
    portSpan: num(env.AGENT_RUNNER_PORT_SPAN, 32),

    // The image's baked dsh home (Dockerfile /opt/dsh-home) — profile
    // scaffold source for each private home (node_modules shared by symlink).
    seedHome: env.AGENT_RUNNER_SEED_HOME ?? "/opt/dsh-home",
  };
}
