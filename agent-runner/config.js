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

function parseStringArray(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return [];
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new Error(`DSH_BIN_ARGS is not valid JSON: expected an array of strings`);
  }
  if (!Array.isArray(doc) || doc.some((a) => typeof a !== "string" || !a)) {
    throw new Error(`DSH_BIN_ARGS must be a JSON array of non-empty strings`);
  }
  return [...doc];
}

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

// ACP command allowlist (add-harness-adapter D5): JSON object, harness name →
// non-empty argv array. Kept here (not in harness/registry.js) so the parse
// failure surfaces at config load — the boot refuses before any child spawns.
function parseAcpCommands(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return {};
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    throw new Error(`AGENT_RUNNER_ACP_COMMANDS is not valid JSON: ${e.message}`);
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    throw new Error("AGENT_RUNNER_ACP_COMMANDS must be a JSON object mapping harness name → [command, ...args]");
  }
  const out = {};
  for (const [name, argv] of Object.entries(doc)) {
    if (!Array.isArray(argv) || argv.length === 0 || argv.some((a) => typeof a !== "string" || !a)) {
      throw new Error(`AGENT_RUNNER_ACP_COMMANDS['${name}'] must be a non-empty array of strings`);
    }
    out[name] = [...argv];
  }
  return out;
}

// ACP environment injection (add-harness-adapter D3): JSON object of env
// name → value. Values are secrets — never logged, never echoed.
function parseAcpEnv(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return {};
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    throw new Error(`AGENT_RUNNER_ACP_ENV is not valid JSON: ${e.message}`);
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    throw new Error("AGENT_RUNNER_ACP_ENV must be a JSON object mapping env name → value");
  }
  const out = {};
  for (const [name, value] of Object.entries(doc)) {
    if (typeof value !== "string" || !name) throw new Error(`AGENT_RUNNER_ACP_ENV['${name}'] must be a string value`);
    out[name] = value;
  }
  return out;
}

export function loadConfig(env = process.env) {
  return {
    repoRoot,
    // Where private per-agent DSH_HOMEs and skill compose roots live. A
    // volume in compose; a tmp dir in tests.
    homeRoot: env.AGENT_RUNNER_HOME || path.join(repoRoot, "runner-home"),
    port: num(env.AGENT_RUNNER_PORT, 8790),
    // Bind host for the ops listener and every agent A2A listener. Cloud
    // deployments leave it unset (0.0.0.0, the historical behavior, byte for
    // byte); the desktop fleet plugin injects 127.0.0.1 so a home machine
    // never exposes agent ports to the LAN (openspec: desktop-fleet-runner).
    host: String(env.AGENT_RUNNER_HOST || "0.0.0.0"),

    // Desktop seat self-report (add-desktop-fleet-runner ③): rides
    // runner_stats as `desktop` — the board consumer excludes desktop seats
    // from every cloud control decision.
    desktopMode: ["1", "true", "yes"].includes(String(env.AGENT_RUNNER_DESKTOP || "").toLowerCase()),

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
    // Pod co-hosting (add-dsh-pod-adapter): same-pack serving agents share ONE
    // dsh process (the process floor ~100-180MB is amortized across members —
    // the arithmetic behind hundreds of long-tail agents). 0 = solo, the
    // byte-identical legacy shape (one process per deployed role); 1 = eligible
    // packs co-host (billing-key/secret/persona/notify-channel gates fall back
    // to solo per member, never refusing a deployment).
    podMode: env.AGENT_RUNNER_POD_MODE === "1",
    // A pod's warm-zone planning floor (M2 measurement: boot peak 172-185MB,
    // settled 89-116MB — idle sessions cost ≈0 marginal). Counts ONCE per pod,
    // never per member.
    podCostMb: num(env.AGENT_RUNNER_POD_COST_MB, 160),
    // Per-pod in-flight turn bound. Turn-close serialization is PROCESS-level
    // on this dsh line (probe-concurrent-turn-close: two sessions, each with
    // its own agent context, still starve — 0.2.0-rc.2/0.2.1-a1), so a pod
    // cannot promise members independent turn convergence; 1 lane makes the
    // coupling deterministic (queued turns, never failed, never preempted).
    podMaxInflight: num(env.AGENT_RUNNER_POD_MAX_INFLIGHT, 1),
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
    // Prefix argv for the dsh command (desktop-fleet-runner): the packaged
    // desktop ships dsh as a Node entry (<app>/node_modules/@deepseek-ai/dsh/
    // lib/bin.js) run through the bundled Node — spawnable on Windows (no
    // extensionless .bin shim) and ABI-consistent. JSON string array in env;
    // empty default keeps cloud argv byte-identical.
    dshBinArgs: parseStringArray(env.DSH_BIN_ARGS),
    dshProfile: env.DSH_PROFILE || "platform",
    cwd: env.AGENT_RUNNER_CWD || repoRoot,

    // Harness adapters (add-harness-adapter D5): the ACP command allowlist —
    // harness name → [command, ...args] as JSON. A descriptor may only NAME a
    // harness from this map; commands are runner-side configuration because
    // descriptors arrive from the registry (untrusted). Absent = dsh only,
    // the legacy shape. Malformed JSON refuses the boot (a silently empty
    // allowlist would fail every ACP deploy late).
    acpCommands: parseAcpCommands(env.AGENT_RUNNER_ACP_COMMANDS),
    // Credentials for ACP harnesses (name → value JSON): claude-code-acp reads
    // ANTHROPIC_API_KEY from its environment (the Claude Agent SDK does the
    // reading — verified against the package's dist, 2026-10-14), so ACP
    // spawns get these injected on top of the scrubbed child env. Runner-side
    // configuration, same discipline as the relay token; per-agent ACP billing
    // keys are future work (recorded in the change design).
    acpEnv: parseAcpEnv(env.AGENT_RUNNER_ACP_ENV),

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
    // Seat mailbox cadence (add-desktop-fleet-runner ④).
    mailboxPollSecs: num(env.AGENT_RUNNER_MAILBOX_POLL_SECS, 30),
    // Sharding (add-runner-fleet-sharding D1): unassigned entries belong to
    // the default runner. Defaulting to the runner's own fleet id keeps a
    // legacy runner (no new env) hosting everything unassigned — zero
    // migration; a new runner with a distinct fleet id hosts only entries
    // explicitly tagged with it.
    defaultRunnerId: env.AGENT_RUNNER_DEFAULT_ID || env.AGENT_RUNNER_FLEET_ID || "runner-1",
  };
}
