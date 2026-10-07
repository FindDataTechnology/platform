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

// The platform bot relay's default address: the pack gateway's origin plus the
// relay route (add-agent-notifications D3). Empty when no pack gateway is
// configured — the notify face then declines not-configured.
function relayFromPacks(env) {
  const base = String(env.AGENT_RUNNER_PACKS_URL || env.AGENT_SERVING_PACKS_URL || "");
  if (!base) return "";
  try {
    return new URL("/api/bots/relay/send", base).toString();
  } catch {
    return "";
  }
}

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

    // LLM defaults (ADR-0019, superseding design D8's runner-level single
    // model): the runner's deployment-level DEFAULT model — a deployment
    // whose descriptor records `effective_model` (per-agent service config)
    // runs on that instead; provider stays runner-level, the model string
    // resolves through the routing store.
    provider: env.AGENT_RUNNER_PROVIDER || "deepseek-official",
    model: env.AGENT_RUNNER_MODEL || "deepseek-v4-flash",

    // Gateway-injected backend credential (design D6): when set, every
    // inbound request (card + JSON-RPC) must carry it as a Bearer token, so
    // direct-to-runner calls that skipped the registry gateway are rejected.
    // Empty = dev mode (warn once, accept) — production sets it.
    backendToken: env.AGENT_RUNNER_BACKEND_TOKEN || "",

    // Child lifecycle (add-agent-residency): residency is the default — there
    // is NO idle reap timer anymore. The warm zone governs: when the host
    // memory budget would be exceeded, the idle-most resident is demoted
    // (process stopped, home/state on disk, next touch re-warms in seconds).
    // Concurrency stays bounded with queueing; upgrade/undeploy drain as before.
    maxChildren: num(env.AGENT_RUNNER_MAX_CHILDREN, 4),
    drainMs: num(env.AGENT_RUNNER_DRAIN_SECS, 300) * 1000,
    // Deployment default turn budget (add-serving-budgets): the per-turn
    // ceiling for roles whose descriptor carries no effective_budget_minutes.
    // Over it the turn is hard-stopped either way — the env value is the
    // default bound, not a separate timeout regime.
    turnTimeoutMs: num(env.AGENT_RUNNER_TURN_TIMEOUT_MS, 180_000),
    // External contexts (facade-derived `wx:` ids) are short-lived by
    // contract (add-wanxing-serving-api): their sessions reap after this much
    // idle. Rhythm day-sessions and internal contexts never reap.
    externalContextTtlSecs: num(env.AGENT_RUNNER_EXTERNAL_CONTEXT_TTL_SECS, 86_400),

    // Warm-zone budget (design D1). Footprint = sampled RSS when the harness
    // exposes a pid, else the fixed per-agent cost (the planning number from
    // the residency probe: 96MB; recalibrate on Linux hosts — see the ops runbook).
    budgetMb: num(env.AGENT_RUNNER_RESIDENT_BUDGET_MB, 3072),
    agentCostMb: num(env.AGENT_RUNNER_AGENT_COST_MB, 96),
    sampleSecs: num(env.AGENT_RUNNER_SAMPLE_SECS, 30),
    // Hysteresis: a child spawned within this window is not a demotion
    // candidate unless the budget is hard-exceeded (x hardBudgetFactor).
    demoteCooldownMs: num(env.AGENT_RUNNER_DEMOTE_COOLDOWN_SECS, 600) * 1000,
    hardBudgetFactor: Number(env.AGENT_RUNNER_HARD_BUDGET_FACTOR) > 1 ? Number(env.AGENT_RUNNER_HARD_BUDGET_FACTOR) : 1.2,

    // Work rhythm (design D2/D3): the scheduler tick and the timezone daily
    // entries fire in.
    rhythmTickMs: num(env.AGENT_RUNNER_RHYTHM_TICK_SECS, 30) * 1000,
    tz: env.AGENT_RUNNER_TZ || "Asia/Shanghai",
    // Day rollover (design D4): digest prompt cap and the external archive
    // target (NFS/object volume mounts here).
    digestMaxChars: num(env.AGENT_RUNNER_DIGEST_MAX_CHARS, 512),
    archiveDir: env.AGENT_RUNNER_ARCHIVE_DIR || path.join(env.AGENT_RUNNER_HOME || path.join(repoRoot, "runner-home"), "agent-archive"),
    // Platform billing (add-agent-platform-ops D2): where the runner fetches
    // per-agent LLM keys by reference — the pack gateway's internal route,
    // authenticated by the registry service credential both sides share.
    packsBaseUrl: (env.AGENT_RUNNER_PACKS_URL || env.AGENT_SERVING_PACKS_URL || "").replace(/\/+$/, ""),

    // Bot relay (add-agent-notifications D3): where a child's bot_notify call
    // is forwarded. The URL defaults to the pack gateway's own origin (the
    // same host the runner already talks to for billing keys); the TOKEN is
    // the platform's BOTS_RELAY_TOKEN value and lives in runner configuration
    // ONLY — the child's environment is scrubbed of it at spawn. No token =
    // the notify face declines structurally (matching the relay's own lazy
    // 404), never a silent drop.
    relayUrl: (env.AGENT_RUNNER_RELAY_URL || relayFromPacks(env)).replace(/\/+$/, ""),
    relayToken: env.AGENT_RUNNER_RELAY_TOKEN || "",
    // Per-agent notification rate bound (D3): token bucket, capacity per
    // minute. Per agent, so a respawned child inherits the same budget.
    notifyRatePerMin: num(env.AGENT_RUNNER_NOTIFY_RATE_PER_MIN, 6),
    // Runner-side notify audit (D5): one jsonl line per decision
    // ({agent, channel, outcome, reason, textLen} — never the text).
    notifyLogFile: env.AGENT_RUNNER_NOTIFY_LOG || path.join(env.AGENT_RUNNER_HOME || path.join(repoRoot, "runner-home"), "notify.jsonl"),

    // Delegation bounds (add-agent-delegation-a2a D4): the depth at which the
    // adapter refuses chained calls, and the per-agent cap on concurrent
    // delegation-originated turns (over-cap queues, never fails).
    delegationDepthMax: num(env.AGENT_RUNNER_DELEGATION_DEPTH_MAX, 3),
    delegationMax: num(env.AGENT_RUNNER_DELEGATION_MAX, 2),

    // Per-turn metering (design D6): jsonl {agent, kind, tokens, ms, at} —
    // the settlement input for platform-ops (slice ③).
    meterFile: env.AGENT_RUNNER_METER_FILE || path.join(env.AGENT_RUNNER_HOME || path.join(repoRoot, "runner-home"), "meter.jsonl"),

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

    // Fleet observability (add-fleet-event-backbone 3.1): direct-post toward
    // the Wanxing observer. Empty URL = fully inert (no spool, no timer);
    // the token is the observer's ingest credential.
    fleetUrl: (env.AGENT_RUNNER_FLEET_URL || "").replace(/\/+$/, ""),
    fleetToken: env.AGENT_RUNNER_FLEET_TOKEN || "",
    fleetRunnerId: env.AGENT_RUNNER_FLEET_ID || "runner-1",
    fleetSampleSecs: num(env.AGENT_RUNNER_FLEET_SAMPLE_SECS, 30),
  };
}
