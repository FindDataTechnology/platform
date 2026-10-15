// ── Runner-side fleet reporter (add-fleet-event-backbone 3.1) ───────────────
//
// Direct-post client toward the Wanxing plane's fleet-observer: at-least-once
// with a durable spool (JSONL in the runner's home root volume), batched
// flush, replay across restarts, id-dedupe on the observer (same ULID
// retried until acked never double-counts). Inert when no URL is configured
// — the runner's behavior is otherwise untouched. Does NOT ride the registry
// (design: the observer is its own endpoint; Qianmian stays out of the data
// path). slugFor/ulid are the annotated copies of the facade's helpers.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

// paas slugFor copy (gateway/wanxing/core.js) — the public agent identity.
const slugFor = (p) => String(p || "").replace(/^\/+/, "").replace(/[^A-Za-z0-9._-]+/g, "-").toLowerCase();

// ULID copy (fd-wanxing services/fleet-observer/ulid.js).
const ENC = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
function ulid(now) {
  let ts = now;
  let out = "";
  for (let i = 0; i < 10; i++) {
    out = ENC[ts % 32] + out;
    ts = Math.floor(ts / 32);
  }
  const rnd = randomBytes(10);
  for (let i = 0; i < 16; i++) {
    const b = rnd[i >> 1];
    out += ENC[i % 2 ? b & 0x0f : b >> 4];
  }
  return out;
}

const SPOOL_CAP = 50_000; // drop-oldest: observability must never wedge the runner

export function createFleetReporter({
  url,
  token,
  runnerId,
  spoolFile,
  log = null,
  fetchImpl = null,
  now = Date.now,
  flushIntervalMs = 5_000,
  maxBatch = 500,
}) {
  const say = log ?? (() => {});
  const queue = []; // {line, event}
  let timer = null;
  let flushing = false;

  const loadSpool = () => {
    try {
      if (!existsSync(spoolFile)) return;
      const lines = readFileSync(spoolFile, "utf8").split("\n").filter(Boolean);
      for (const line of lines.slice(-SPOOL_CAP)) {
        try {
          queue.push({ line, event: JSON.parse(line) });
        } catch { /* a torn tail line dies here — the event is lost, not the runner */ }
      }
    } catch { /* unreadable spool = start empty; the observer reconciles via bookkeeper */ }
  };

  const persist = () => {
    try {
      mkdirSync(path.dirname(spoolFile), { recursive: true });
      const tmp = `${spoolFile}.tmp`;
      writeFileSync(tmp, queue.map((q) => q.line).join("\n") + (queue.length ? "\n" : ""));
      renameSync(tmp, spoolFile); // atomic-ish: a crash never truncates to less
    } catch (e) {
      say(`spool persist failed: ${e.message}`);
    }
  };

  const emit = ({ kind, agent, payload = {}, traceId = null }) => {
    const event = {
      id: ulid(now()),
      source: `runner:${runnerId}`,
      agent: slugFor(agent),
      runner: runnerId,
      kind,
      ts: now(),
      trace_id: traceId,
      payload,
    };
    queue.push({ line: JSON.stringify(event), event });
    while (queue.length > SPOOL_CAP) queue.shift();
    persist();
  };

  async function flush() {
    if (flushing || queue.length === 0) return { sent: 0 };
    flushing = true;
    try {
      const batch = queue.slice(0, maxBatch);
      const res = await (fetchImpl ?? fetch)(`${url.replace(/\/+$/, "")}/ingest`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ events: batch.map((q) => q.event) }),
      });
      if (!res.ok) return { sent: 0, error: `ingest -> ${res.status}` };
      queue.splice(0, batch.length);
      persist();
      return { sent: batch.length };
    } catch (e) {
      return { sent: 0, error: e?.message || String(e) };
    } finally {
      flushing = false;
    }
  }

  return {
    emit,
    flush,
    start() {
      loadSpool();
      if (timer) return;
      void flush();
      timer = setInterval(() => void flush(), flushIntervalMs);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      persist();
    },
  };
}

// Periodic sampler: per-agent five-state transitions + one runner_stats row
// per tick. Riding the manager's health() view keeps hooks out of the
// manager's hot paths entirely.
//
// `rosterProvider` (add-deploy-roster-gate): the model ids this runner's
// composed child profiles can resolve — the same buildLlmProfile() source the
// child settings.yaml is written from, so the heartbeat can never disagree
// with what children actually run. The value rides runner_stats as `models`;
// the deploy gate reads it off the observer board. sample() stays synchronous
// (its consumers call it fire-and-forget): the roster is cached and refreshed
// in the background each tick — a provider failure OMITS the field (a missing
// roster degrades the deploy gate open; an empty array would refuse every
// model choice, and a read failure is not "no models").
// `harnessProvider` (add-harness-adapter D5): the harness names this runner's
// adapter registry can host — rides runner_stats as `harness` (a string
// array), and the deploy gate reads it off the observer board the same way it
// reads `models`. Absent provider or a throw → the field is OMITTED (unknown
// degrades the deploy gate open, exactly like the roster).
export function createFleetSampler({ manager, reporter, runnerId, rosterProvider = null, harnessProvider = null, podMode = false, desktopMode = false }) {
  let last = new Map(); // agentKey → state
  let rosterCache = null; // string[] | null — null until the first refresh lands
  const defaultRosterProvider = async () => {
    const { buildLlmProfile } = await import("../dsh-profile.js");
    const { models } = await buildLlmProfile();
    return models.map((m) => m.id);
  };
  const resolveRoster = rosterProvider ?? defaultRosterProvider;
  const refreshRoster = () => {
    try {
      const v = resolveRoster();
      if (Array.isArray(v)) {
        // Synchronous provider (tests): available on this very tick.
        rosterCache = v.map(String);
        return;
      }
      Promise.resolve(v)
        .then((ids) => {
          if (Array.isArray(ids)) rosterCache = ids.map(String);
          else rosterCache = null;
        })
        .catch(() => {
          rosterCache = null;
        });
    } catch {
      rosterCache = null;
    }
  };
  return {
    sample() {
      refreshRoster();
      const h = manager.health();
      for (const a of h.agents) {
        const prev = last.get(a.key);
        if (prev !== a.state) {
          last.set(a.key, a.state);
          reporter.emit({
            kind: "state_changed",
            agent: a.path ?? a.key,
            payload: { from: prev ?? null, to: a.state },
          });
        }
      }
      let harnessList = null;
      if (harnessProvider) {
        try {
          const v = harnessProvider();
          if (Array.isArray(v) && v.length) harnessList = v.map(String);
        } catch { /* a broken provider omits the field (degrade open) */ }
      }
      reporter.emit({
        kind: "runner_stats",
        agent: runnerId, // runner-level row: agent field is the runner identity
        payload: {
          children: h.children,
          queued: h.queued,
          budget_mb: Math.round(h.budget),
          budget_mb_limit: h.budgetMb,
          agents: h.agents.length,
          ...(Array.isArray(rosterCache) ? { models: rosterCache } : {}),
          ...(harnessList ? { harness: harnessList } : {}),
          // Density self-report (unify-wanxing-management-plane): fleet views
          // read this to tell solo runners from pod-cohosting ones; absent on
          // older runners and read as solo there (degrade open).
          pod: podMode === true,
          // Desktop seat self-report (add-desktop-fleet-runner ③): marks this
          // runner as owned territory on the board — visible to monitoring,
          // invisible to the cloud scheduler's failover/placement decisions.
          desktop: desktopMode === true,
        },
      });
    },
  };
}
