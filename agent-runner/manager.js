// ── Child manager (add-a2a-agent-serving 4.4; add-agent-residency 3.x) ──────
//
// Reconciles the runner's children with the registry's served-agent list
// (poll-driven), bounds concurrency by queueing (never evicting a busy child),
// and drains on upgrade/undeploy. Residency (add-agent-residency, ADR-0010):
// idle children are NOT reaped on a timer — they stay resident until the host
// memory budget demotes the idle-most into the warm zone (process stopped,
// home/state on disk, next touch re-warms in seconds). Paused agents (the
// registry's metadata flag) sit in the warm zone by definition and answer
// callers with an explicit error.

import http from "node:http";
import { appendFileSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, existsSync } from "node:fs";
import { execFileSync, execSync } from "node:child_process";
import path from "node:path";
import { AgentChild } from "./child.js";

// Best-effort RSS of a pid in bytes (Linux /proc first — the runner's
// container home; macOS ps for local runs). null when unknown: the caller
// falls back to the fixed per-agent planning cost.
function sampleRssBytes(pid) {
  if (!pid || !Number.isFinite(pid)) return null;
  try {
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    const m = /VmRSS:\s+(\d+)\s+kB/.exec(status);
    if (m) return Number(m[1]) * 1024;
  } catch { /* not linux, or the process is gone */ }
  try {
    const out = execSync(`ps -o rss= -p ${pid}`, { encoding: "utf8" });
    const kb = Number(String(out).trim());
    if (Number.isFinite(kb) && kb > 0) return kb * 1024;
  } catch { /* gone */ }
  return null;
}

// Liveness probe by signal 0: throws ESRCH for a dead pid, succeeds (or EPERM)
// for a live one. Entries whose pid is not a number yet (pre-start) are the
// floor's original domain and stay out of this check.
function pidAlive(pid) {
  if (!pid || !Number.isFinite(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === "EPERM";
  }
}

// Flatten a dsh usage payload to a token count; null when absent (metering
// records the turn without tokens rather than guessing). Two shapes: OpenAI
// totals (total_tokens/totalTokens/tokens) first, then the dsh harness shape
// the pi-ai adapter emits on EVERY terminal event — separate camelCase
// input/output counts with no total field, which is why 700/700 live meter
// rows read tokens:null before this (live finding 2026-10-14; cache counts
// stay excluded — the sum is input+output, the spec's 合计口径).
function tokensOf(usage) {
  if (!usage || typeof usage !== "object") return null;
  const t = usage.total_tokens ?? usage.totalTokens ?? usage.tokens;
  if (Number.isFinite(Number(t))) return Number(t);
  const input = Number(usage.inputTokens ?? usage.input_tokens);
  const output = Number(usage.outputTokens ?? usage.output_tokens);
  if (Number.isFinite(input) && Number.isFinite(output)) return input + output;
  return null;
}
import { agentKeyFor, materializeAgentHome, materializePackHome, mcpEntry, packPodEligibility, podKeyFor, applyBillingKey, applyDeploymentSecrets, workspaceChildEnv } from "./compose.js";
import { materializeAcpWorkspace, acpMcpServers, acpCredentialEnv, acpSecretsRefusal } from "./compose-acp.js";

// Cold-start respawn escalation (fix-agent-serving-stability 2.2): after the
// child's own initialize retries are exhausted, the manager retries the
// WHOLE spawn this many extra times — fresh dsh process each — with this
// backoff between attempts. The in-process window covers the adapter-
// registration race; this loop covers a boot that lost it anyway or came up
// broken. Error code -32004: below the child's -32000..-32003 turn codes
// and the facade's -32032/-32033; it means "this agent could not start",
// never "this turn failed".
const RESPAWN_ATTEMPTS = 3;
const RESPAWN_BACKOFF_MS = [2_000, 4_000, 8_000];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
import { scrubbedChildEnv } from "./child.js";
import { DshHarnessAdapter } from "./harness/dsh.js";
import { createHarnessRegistry, DEFAULT_HARNESS } from "./harness/registry.js";
import { createNotifier } from "./notify.js";
import { maskSecretRef, resolveAgentPort } from "../lib/agent-serving.js";
import { createAgentApp } from "./a2a.js";

// Per-session reap window (add-caller-preferences): minimal copy of the
// facade's parseReapWindow (fd-wanxing wanxing-facade a2a.js) — one
// definition, two repos, keep the two in lockstep (the slugFor discipline).
// Accepts a context id ("wx:…") or a session name ("srv-wx-…"); returns
// minutes or null (null = the runner's platform default). The `x` suffix
// cannot occur inside the hex digest, so an unencoded hash never matches.
export function parseReapWindow(value) {
  const body = String(value ?? "").replace(/^wx:/, "").replace(/^srv-wx-/, "");
  const m = body.match(/^(\d{1,6})x(?:-|$)/);
  return m ? Number(m[1]) : null;
}

// The bare sessionKeyFor tail of an on-disk session name — pod homes prefix
// wire ids with `<agentKey>--` (child.js wireSessionId), solo names are their
// own tail. Returns null when the name is not an external-context session.
// Splits on the LAST `--`: agent keys are single-dash alphabets, so the tail
// is always the unprefixed session id.
function externalContextTail(name) {
  const idx = name.lastIndexOf("--");
  const tail = idx >= 0 ? name.slice(idx + 2) : name;
  return tail.startsWith("srv-wx-") ? tail : null;
}

export class ChildManager {
  #slotWaiters = new Set(); // capacity-queue interval timers, cleared on shutdown
  #podLaneWaiters = new Set(); // pod in-flight-lane interval timers, cleared on shutdown
  #listeners = new Map(); // agentKey → http server (per-agent port, upstream #1734)
  #quotaAlerted = new Set(); // workspace over-quota episodes already reported
  #spawnFailures = new Map(); // agentKey → consecutive exhausted cold-start cycles (2.2)
  constructor({ config, registryClient, clientFactory, log = console, now = () => Date.now(), notifyFetchImpl, events = null, harnessRegistry = null }) {
    this.config = config;
    this.registryClient = registryClient;
    this.clientFactory = clientFactory;
    // Harness registry (add-harness-adapter D5): descriptor-declared harness →
    // adapter. Built from the runner's ACP allowlist; dsh is always present.
    this.harnessRegistry = harnessRegistry ?? createHarnessRegistry({
      acpCommands: config.acpCommands ?? {},
      acpEnv: config.acpEnv ?? {},
      log,
    });
    this.log = log;
    this.now = now;
    // Fleet observability sink (add-fleet-event-backbone 3.1): optional
    // {kind, agent, payload} callback; null = fully inert.
    this.events = events;
    this.everSpawned = new Set(); // agentKey → ever had a child (woken reason: first-touch vs warm)
    // Notification egress (add-agent-notifications D3/D5): one forwarder for
    // every child — the relay credential and the per-agent rate bound live
    // here, never in a child's environment.
    this.notifier = createNotifier({ config, log, fetchImpl: notifyFetchImpl, now });
    this.children = new Map(); // childKey → AgentChild (agentKey solo, podKey pod — add-dsh-pod-adapter)
    this.entries = new Map(); // agentKey → registry entry (card source)
    this.versions = new Map(); // childKey → identity of the composition running there
    this.pending = new Map(); // agentKey → promise chain while a slot is awaited
    this.waiting = 0; // queued turn requests at capacity
    this.pausedKeys = new Set(); // registry-marked paused (agent-residency D5)
    this.delegationInFlight = new Map(); // agentKey → live depth≥1 turns (a2a delegation D4)
    // Pod routing (add-dsh-pod-adapter): agentKey → { childKey, pod }, rebuilt
    // every reconcile; `groups` (childKey → group) lives per-reconcile.
    this.groups = new Map();
    // PackIds whose spawned runtime failed the pod capabilities probe — sticky
    // until the pack's composition identity changes (reconcile clears on drain),
    // so one old runtime never loops a pack through pod spawn failures.
    this.podCapRefused = new Set();
  }

  // Delegation-originated (depth ≥ 1) concurrency bound per agent
  // (add-agent-delegation-a2a): acquire a delegation slot; resolves when one
  // frees. Over-cap callers queue — never fail, never preempt.
  async #acquireDelegationSlot(key) {
    for (;;) {
      const live = this.delegationInFlight.get(key) ?? 0;
      if (live < this.config.delegationMax) {
        this.delegationInFlight.set(key, live + 1);
        return () => {
          const n = this.delegationInFlight.get(key) ?? 1;
          this.delegationInFlight.set(key, Math.max(0, n - 1));
        };
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  isPaused(entry) {
    return this.pausedKeys.has(agentKeyFor(entry));
  }

  // Wait for a free in-flight lane on the route's pod (see turn). A child
  // that is absent or draining passes — acquire handles both — and the wait
  // uses interval timers registered for shutdown clearing, exactly like the
  // capacity slot waiters (a stopped manager must not leave queued turns
  // hanging on a timer nobody clears).
  async #awaitPodLane(route) {
    const laneMax = this.config.podMaxInflight ?? 1;
    for (;;) {
      const child = this.children.get(route.childKey);
      const inflight = child && !child.draining ? child.activeTurns : 0;
      if (inflight < laneMax) return;
      await new Promise((resolve) => {
        const timer = setInterval(() => {
          const c = this.children.get(route.childKey);
          const n = c && !c.draining ? c.activeTurns : 0;
          if (n < laneMax) {
            clearInterval(timer);
            this.#podLaneWaiters.delete(timer);
            resolve();
          }
        }, 250);
        this.#podLaneWaiters.add(timer);
      });
    }
  }

  health() {
    const agents = [];
    for (const [key, entry] of this.entries) {
      const route = this.groups.get(key);
      const child = route ? this.children.get(route.childKey) : undefined;
      agents.push({
        key,
        path: entry?.path ?? null,
        port: resolveAgentPort(entry, { base: this.config.portBase ?? 8791, span: this.config.portSpan ?? 32 }),
        // Five states (spec: agent-runner health): paused > draining >
        // starting > serving (a turn in flight) > resident (warm and idle);
        // no live process = warm (never touched, or demoted by budget/pause).
        // A pod member's process state comes from the shared pod; its
        // serving/resident split is the MEMBER's own turn activity.
        state: this.pausedKeys.has(key)
          ? "paused"
          : child
            ? child.draining
              ? "draining"
              : child.ready
                ? child.agentActiveTurns(key) > 0 ? "serving" : "resident"
                : "starting"
            : "warm",
        version: entry?.metadata?.packVersion ?? null,
      });
    }
    return {
      ok: true,
      agents,
      children: this.children.size,
      queued: this.waiting,
      budget: this.#footprintMb(),
      budgetMb: this.config.budgetMb,
    };
  }

  // One HTTP listener per hosted agent (the registry proxy maps /agent/{path}
  // onto the registered origin — see a2a.js). Started on first reconcile that
  // wants the agent; stopped (drained) when the entry leaves.
  #ensureListener(key, entry) {
    if (this.#listeners.has(key)) return;
    // Port derives from the REGISTRY path — the same input the deploy side
    // hashes — with a valid descriptor port_override (collision avoidance)
    // winning. One shared definition (lib/agent-serving resolveAgentPort) so
    // the registered URL and this bind can never disagree.
    const port = resolveAgentPort(entry, { base: this.config.portBase ?? 8791, span: this.config.portSpan ?? 32 });
    const server = http.createServer(
      createAgentApp({
        entry,
        // Resolve the LIVE entry per request: this listener survives in-place
        // upgrades, so a captured object would keep serving the stale
        // descriptor to composition (upgrades/rebinds must reach the child).
        getEntry: () => this.entries.get(key) ?? entry,
        manager: this,
        config: this.config,
        log: this.log,
      }),
    );
    // config.host: 0.0.0.0 on cloud (historical default), 127.0.0.1 on the
    // desktop fleet plugin — agent A2A ports must not face the LAN there.
    server.listen(port, this.config.host || "0.0.0.0");
    this.#listeners.set(key, server);
    this.log.log(`[agent-runner] serving ${key} on :${port} (registry path ${entry.path})`);
  }

  #stopListener(key) {
    const server = this.#listeners.get(key);
    if (!server) return;
    this.#listeners.delete(key);
    server.close();
    this.log.log(`[agent-runner] stopped listener for ${key}`);
  }

  // One poll: list served agents → reconcile. Cheap when nothing changed
  // (child spawns only happen on first touch or after reap — see acquire).
  async reconcile() {
    const served = await this.registryClient.listServedAgents();
    const wanted = new Map(served.map((e) => [agentKeyFor(e), e]));
    const groups = this.#groupEntries(wanted);

    // Undeployed / disabled: drain + forget (spec: undeploy stops serving).
    // Entries can exist without a child (card-only service never messaged),
    // so cleanup iterates every known key, not just spawned children. A pod's
    // childKey survives while its group exists — a member leaving is a group
    // identity change, handled by the identity pass below.
    for (const key of new Set([...this.children.keys(), ...this.entries.keys(), ...this.#listeners.keys()])) {
      if (wanted.has(key) || groups.has(key)) continue;
      const child = this.children.get(key);
      this.children.delete(key);
      this.entries.delete(key);
      this.versions.delete(key);
      this.#stopListener(key);
      if (child) {
        this.log.log(`[agent-runner] ${key} left the registry; draining`);
        child.drainAndStop(this.config.drainMs).catch((e) => this.log.warn(`[agent-runner] drain failed for ${key}: ${e.message}`));
      } else {
        this.log.log(`[agent-runner] ${key} left the registry`);
      }
    }

    // Known entries refresh card views; pause/resume (agent-residency D5)
    // stays per entry — the registry flag is the single source of truth, and
    // the A2A adapter answers explicit -32010s. In pod mode pausing a member
    // does NOT drain the pod (its siblings keep serving): pause is a serving
    // refusal, not a resource reclamation — the warm zone owns reclamation at
    // pod granularity.
    for (const [key, entry] of wanted) {
      this.entries.set(key, entry);
      this.#ensureListener(key, entry);
      if (entry.metadata?.paused === true) {
        this.pausedKeys.add(key);
        const soloChild = this.children.get(key);
        if (!this.groups.get(key)?.pod && soloChild && !soloChild.draining) {
          this.log.log(`[agent-runner] ${key} paused; demoting to warm zone`);
          this.children.delete(key);
          soloChild.stop().catch(() => {});
        }
      } else {
        this.pausedKeys.delete(key);
      }
    }

    // Identity pass per child group: any member's descriptor change drains
    // the WHOLE child (solo: the role's own; pod: the pack's — upgrade
    // granularity is the co-hosting key, the accepted pod trade) so the next
    // touch spawns the new composition.
    for (const [childKey, group] of groups) {
      const identity = JSON.stringify(
        [...group.members.entries()]
          .map(([k, e]) => [k, this.#identityOf(e)])
          .sort(([a], [b]) => String(a).localeCompare(String(b))),
      );
      const existing = this.children.get(childKey);
      if (existing && this.versions.get(childKey) !== identity) {
        this.log.log(`[agent-runner] ${childKey} descriptor changed; draining old runtime for in-place upgrade`);
        this.versions.set(childKey, identity);
        this.children.delete(childKey);
        existing.drainAndStop(this.config.drainMs).catch((e) => this.log.warn(`[agent-runner] upgrade drain failed for ${childKey}: ${e.message}`));
        // A rebuilt composition gets a fresh pod-capabilities probe (the
        // refusal marked the RUNTIME generation, not the pack forever).
        if (group.pod) this.podCapRefused.delete(group.packId);
      } else if (!existing) {
        this.versions.set(childKey, identity);
      }
    }
    return served.length;
  }

  // The composition-identity fields of one entry: everything that drains a
  // child when it changes (the solo-era list, verbatim — pods merge their
  // members' identities in reconcile).
  #identityOf(entry) {
    const m = entry?.metadata ?? {};
    return {
      v: m.packVersion,
      persona: m.persona,
      skills: m.skills,
      mcp: m.mcpServers,
      // Tool allowlists (add-mcp-tool-scoping): a redeploy that narrows or
      // widens a reference's tools must drain the old child so the next
      // spawn composes the new filter — the filter is materialized into the
      // home, so an unchanged identity would keep serving the old allowlist.
      mcpTools: m.mcpTools ?? null,
      name: entry.name,
      // The effective turn budget materializes at spawn (the child's
      // timeout); a redeploy that changes it drains the old child so the
      // new bound takes effect on the next touch.
      budget: m.effective_budget_minutes,
      // Deployment-secret refs (add-deployment-secrets): a rebind mints a
      // fresh reference, and the pinned values live in the home — the
      // descriptor change must drain the old child so the next spawn
      // re-fetches and re-pins.
      secretRefs: m.secret_refs,
      // The notification binding (add-agent-notifications D2) is captured by
      // the spawn's notify handler; a rebind must drain the old child or it
      // would keep notifying the previous channel.
      notify: m.notify_channel,
      // The data workspace (facet-mcp-foundation-v1 3.1) is captured by the
      // spawn's env (AGENT_DATA_DIR / AGENT_DATA_QUOTA_MB); a declaration
      // change must drain so the next spawn materializes and exports it.
      // Draining never touches the home — data/ persists verbatim.
      workspace: m.workspace,
      // Per-deployment model (agent-service-config / ADR-0019): the spawn's
      // LLM is derived from this field, so a model change must drain the
      // old child — the upgrade-grade channel, no third restart path.
      model: m.effective_model,
    };
  }

  // Group wanted entries by hosting child (add-dsh-pod-adapter). Solo mode
  // (and every ineligible case) is one group per entry under its agentKey;
  // pod mode groups same-pack serving agents (≥2 members, eligibility
  // checked) under one podKey. Fail-open by construction: nothing here can
  // refuse a deployment — ineligible packs simply keep dedicated children.
  #groupEntries(wanted) {
    const groups = new Map(); // childKey → { pod, packId, members: Map<agentKey, entry> }
    this.groups = new Map(); // agentKey → { childKey, pod }
    const byPack = new Map(); // packId → [[agentKey, entry]]
    for (const [key, entry] of wanted) {
      const packId = entry?.metadata?.packId ?? null;
      if (this.config.podMode && packId && !this.podCapRefused.has(packId)) {
        const arr = byPack.get(packId) ?? [];
        arr.push([key, entry]);
        byPack.set(packId, arr);
      } else {
        groups.set(key, { pod: false, packId: null, members: new Map([[key, entry]]) });
      }
    }
    for (const [packId, arr] of byPack) {
      if (arr.length < 2) {
        // A lone member gains nothing from a pod — keep it on the
        // battle-tested solo path (a pack growing its second serving agent
        // migrates via the identity drain, like any composition change).
        for (const [key, entry] of arr) groups.set(key, { pod: false, packId: null, members: new Map([[key, entry]]) });
        continue;
      }
      const verdict = packPodEligibility(arr.map(([, e]) => e));
      if (!verdict.ok) {
        this.log.log(`[agent-runner] pod-ineligible pack ${packId}: ${verdict.reason} — members serve solo`);
        for (const [key, entry] of arr) groups.set(key, { pod: false, packId: null, members: new Map([[key, entry]]) });
        continue;
      }
      groups.set(podKeyFor(packId), { pod: true, packId, members: new Map(arr) });
    }
    for (const [childKey, group] of groups) {
      for (const key of group.members.keys()) this.groups.set(key, { childKey, pod: group.pod });
    }
    return groups;
  }

  // Acquire the child for a key, materializing + spawning on demand (a warm
  // re-warm after budget/pause demotion, or a first touch). At capacity:
  // first demote an IDLE child to the warm zone (least-recently-active — the
  // next message re-warms it); if every child is busy, the request QUEUES —
  // it never fails and never demotes a busy child (spec: "without evicting
  // a busy child"). Pod mode routes the entry to its pack's pod (the group
  // map from the last reconcile); a capabilities-refused pack spawns solo.
  async acquire(entry) {
    const key = agentKeyFor(entry);
    const route = this.groups.get(key) ?? { childKey: key, pod: false };
    for (;;) {
      const live = this.children.get(route.childKey);
      if (live && !live.draining) return live;
      if (this.children.size < this.config.maxChildren || this.#evictIdleChild()) {
        // Respawn escalation (fix-agent-serving-stability 2.2): a failed
        // cold start is retried WHOLE — a fresh spawn (fresh dsh process)
        // per attempt with backoff between. The child's in-process
        // initialize retries only cover the adapter-registration race; a
        // race lost at the end of that window, or a runtime that failed to
        // boot cleanly, deserves a fresh process before the caller ever
        // sees an error. Exhausted: a structured cold-start error (code
        // -32004) distinct from turn errors; the NEXT message attempts a
        // fresh spawn — the runner never wedges until restart.
        const attempts = this.config.respawnAttempts ?? RESPAWN_ATTEMPTS;
        const backoff = this.config.respawnBackoffMs ?? RESPAWN_BACKOFF_MS;
        let child = null;
        let lastErr = null;
        for (let attempt = 0; attempt <= attempts; attempt++) {
          if (attempt > 0) await sleep(backoff[Math.min(attempt - 1, backoff.length - 1)]);
          const raced = this.children.get(route.childKey);
          if (raced && !raced.draining && raced !== child) { child = raced; lastErr = null; break; }
          try {
            child = await this.#spawnRouted(route, entry);
            lastErr = null;
            break;
          } catch (e) {
            lastErr = e;
            this.log.warn(`[agent-runner] cold-start attempt ${attempt + 1}/${RESPAWN_ATTEMPTS + 1} for ${route.childKey} failed: ${e?.message || e}`);
          }
        }
        if (!child) {
          this.#spawnFailures.set(key, (this.#spawnFailures.get(key) ?? 0) + 1);
          throw Object.assign(
            new Error(`cold start failed after ${RESPAWN_ATTEMPTS + 1} attempts (${lastErr?.message || lastErr})`),
            { code: -32004, cause: lastErr },
          );
        }
        this.#spawnFailures.delete(key);
        if (!child.draining) {
          // woken is per MEMBER (fleet attribution), not per child: a pod's
          // spawn wakes every member it hosts.
          if (route.pod) {
            for (const [memberKey, memberEntry] of this.#groupMembersOf(route) ?? []) {
              this.#fleetEmit("woken", memberEntry, { reason: this.everSpawned.has(memberKey) ? "warm" : "first-touch" });
              this.everSpawned.add(memberKey);
            }
          } else {
            this.#fleetEmit("woken", entry, { reason: this.everSpawned.has(key) ? "warm" : "first-touch" });
            this.everSpawned.add(key);
          }
          return child;
        }
        continue; // lost a race with a concurrent upgrade drain
      }
      // All slots busy: wait for a turn to finish (drain/reap frees entries).
      this.waiting += 1;
      try {
        await new Promise((resolve) => {
          const timer = setInterval(() => {
            if (this.children.size < this.config.maxChildren || this.#evictIdleChild()) {
              clearInterval(timer);
              this.#slotWaiters.delete(timer);
              resolve();
            }
          }, 250);
          this.#slotWaiters.add(timer); // cleared on shutdown
        });
      } finally {
        this.waiting -= 1;
      }
    }
  }

  // The member set a route points at (pods): recovered from the live entry
  // map so a spawn between reconciles still composes the pack's CURRENT
  // members — entries.set happens every poll, so this is at most one poll
  // interval stale, exactly like every other spawn input.
  #groupMembersOf(route) {
    if (!route?.pod) return null;
    const members = new Map();
    for (const [key, { childKey }] of this.groups) {
      if (childKey === route.childKey) {
        const entry = this.entries.get(key);
        if (entry) members.set(key, entry);
      }
    }
    return members.size ? members : null;
  }

  // Dispatch one spawn through the route: solo children as ever; pods with a
  // sticky capabilities refusal (this.podCapRefused) fall back to the
  // member's dedicated child — fail-open, the deployment is never refused.
  async #spawnRouted(route, entry) {
    if (!route.pod || this.podCapRefused.has(route.packId)) {
      return this.#spawnChild(agentKeyFor(entry), entry);
    }
    try {
      return await this.#spawnPod(route);
    } catch (e) {
      if (e?.code === "POD_CAPABILITIES_MISSING") {
        this.podCapRefused.add(route.packId);
        this.log.warn(`[agent-runner] pack ${route.packId} falls back to solo children: its runtime lacks the live methods pod serving requires (${e?.message || e})`);
        return this.#spawnChild(agentKeyFor(entry), entry);
      }
      throw e;
    }
  }

  // Best candidate for a capacity demotion: idle, not draining, least
  // recently active. Returns true when one was demoted to the warm zone.
  #evictIdleChild() {
    let victim = null;
    for (const [key, child] of this.children) {
      if (child.draining || child.activeTurns > 0) continue;
      if (!victim || child.lastActivityAt < victim.child.lastActivityAt) victim = { key, child };
    }
    if (!victim) return false;
    this.children.delete(victim.key);
    this.#fleetEmit("reaped", victim.key, { reason: "capacity" });
    this.log.log(`[agent-runner] capacity: demoting idle ${victim.key} to warm zone (next message re-warms it)`);
    victim.child.stop().catch(() => {});
    return true;
  }

  // ── Warm-zone budget (add-agent-residency D1) ─────────────────────────────
  // Footprint in MB: sampled RSS per child when a pid is exposed, else the
  // fixed per-agent planning cost. The floor keeps budgeting honest even
  // before a spawn reports its RSS. A child that exited on its own (crash,
  // idle reaper — nothing hooks the process exit) leaves its entry behind;
  // its floor would ghost-count forever (measured live 2026-10-11: three dead
  // entries × 96MB while the pod's real dsh footprint lived elsewhere), so
  // the accounting point re-verifies liveness and prunes the ghosts it finds.
  #footprintMb(extraChildren = 0) {
    let bytes = 0;
    for (const [key, child] of this.children) {
      const rss = sampleRssBytes(child.pid);
      if (rss == null && Number.isFinite(child?.pid) && !pidAlive(child.pid)) {
        if (this.children.get(key) === child) this.children.delete(key);
        this.log.warn(`[agent-runner] ${key} child pid ${child.pid} is gone — pruned ghost entry from the warm-zone budget`);
        continue;
      }
      // A pod counts its floor ONCE (add-dsh-pod-adapter): idle sessions are
      // ≈0 marginal (M2), so per-member flooring would ghost-count N× the
      // process floor the host never pays.
      bytes += Math.max(rss ?? 0, (child.costFloorMb ?? this.config.agentCostMb) * 1024 * 1024);
    }
    return (bytes + extraChildren * this.config.agentCostMb * 1024 * 1024) / (1024 * 1024);
  }

  // Demote idle residents until the footprint fits the budget. Cooldown
  // hysteresis (design D1): a child spawned within demoteCooldownMs is not a
  // candidate unless the budget is HARD-exceeded (× hardBudgetFactor) — no
  // promote/demote thrash at a boundary-hovering load.
  enforceBudget() {
    const limit = this.config.budgetMb * 1024 * 1024;
    for (;;) {
      const footprint = this.#footprintMb() * 1024 * 1024;
      if (footprint <= limit) return;
      const hard = footprint > limit * this.config.hardBudgetFactor;
      let victim = null;
      for (const [key, child] of this.children) {
        if (child.draining || child.activeTurns > 0) continue;
        if (!hard && this.now() - child.spawnedAt < this.config.demoteCooldownMs) continue;
        if (!victim || child.lastActivityAt < victim.child.lastActivityAt) victim = { key, child };
      }
      if (!victim) return; // nothing demotable; over budget until a turn ends
      this.children.delete(victim.key);
      this.#fleetEmit("reaped", victim.key, { reason: "budget" });
      this.log.log(
        `[agent-runner] budget: demoting idle ${victim.key} to warm zone (footprint ${Math.round(footprint / 1024 / 1024)}MB > ${this.config.budgetMb}MB${hard ? ", hard" : ""})`,
      );
      victim.child.stop().catch(() => {});
    }
  }

  // ── External-context reap (add-wanxing-serving-api D10; per-caller window:
  // add-caller-preferences) ───────────────────────────────────────────────────
  // Facade-derived `wx:` contexts are single-interaction by contract: their
  // sessions (storage name srv-wx-*) reap after the idle TTL, freeing the
  // private home's session storage. Walks homeRoot directly — the homes of
  // warm (demoted) and undeployed agents persist, and their stale external
  // sessions should not outlive the agent's own residency. Rhythm day-
  // sessions (srv-day-*) and internal contexts are name-spaced away and never
  // touched. A session with a turn in flight on a live child is skipped;
  // both the flat and the workspace-nested dsh storage layouts are scanned.
  //
  // The TTL is PER SESSION (add-caller-preferences): a caller's reap-window
  // preference rides encoded in the context id — the facade derives
  // `wx:<minutes>x-<hash>`, the session lands as `srv-wx-<minutes>x-<hash>`,
  // and parseReapWindow (minimal copy of the facade's, keep the two in
  // lockstep — the slugFor discipline) resolves it here. No segment (legacy
  // ids, caller-supplied contexts) → the runner's platform default.
  reapExternalContexts() {
    const defaultTtlMs = this.config.externalContextTtlSecs * 1000;
    let reaped = 0;
    let agentKeys;
    try {
      agentKeys = readdirSync(this.config.homeRoot);
    } catch {
      return 0;
    }
    for (const agentKey of agentKeys) {
      for (const dir of ["sessions", "projects", ".sessions"]) {
        const dirPath = path.join(this.config.homeRoot, agentKey, dir);
        if (!existsSync(dirPath)) continue;
        let entries;
        try {
          entries = readdirSync(dirPath, { withFileTypes: true });
        } catch {
          continue;
        }
        // Two dsh storage generations (live finding 2026-10-07): older homes
        // keep sessions FLAT (`sessions/srv-wx-…`); current dsh nests them
        // under a workspace-group dir (`sessions/--data-…--/srv-wx-…`). Scan
        // both — a one-level walk left every nested wx session unreaped
        // (observed in production: three stale wx dirs from probes).
        const candidates = [];
        for (const ent of entries) {
          const tail = externalContextTail(ent.name);
          if (tail) {
            candidates.push({ name: ent.name, sessionPath: path.join(dirPath, ent.name), tail });
            continue;
          }
          if (!ent.isDirectory()) continue;
          let inner;
          try {
            inner = readdirSync(path.join(dirPath, ent.name), { withFileTypes: true });
          } catch {
            continue;
          }
          for (const child of inner) {
            const innerTail = externalContextTail(child.name);
            if (innerTail) {
              candidates.push({ name: child.name, sessionPath: path.join(dirPath, ent.name, child.name), tail: innerTail });
            }
          }
        }
        for (const { name, sessionPath, tail } of candidates) {
          if (this.#sessionActive(agentKey, name)) continue;
          const minutes = parseReapWindow(tail);
          const ttlMs = minutes == null ? defaultTtlMs : minutes * 60_000;
          if (Date.now() - this.#lastTouched(sessionPath) < ttlMs) continue;
          try {
            rmSync(sessionPath, { recursive: true, force: true });
            reaped += 1;
          } catch (e) {
            this.log.warn(`[agent-runner] external-context reap failed (${agentKey}/${name}): ${e.message}`);
          }
        }
      }
    }
    if (reaped > 0) this.log.log(`[agent-runner] external-context reap: removed ${reaped} idle wx session(s)`);
    return reaped;
  }

  // A live child's collector for this session means a turn is running on it.
  #sessionActive(agentKey, sessionName) {
    return this.children.get(agentKey)?.isActive(sessionName) === true;
  }

  // Latest mtime within one level of the session dir — dsh writes transcripts
  // as turns happen, so the newest file is the honest idle timestamp.
  #lastTouched(sessionPath) {
    let latest = 0;
    try {
      latest = statSync(sessionPath).mtimeMs;
      for (const ent of readdirSync(sessionPath)) {
        try {
          const m = statSync(path.join(sessionPath, ent)).mtimeMs;
          if (m > latest) latest = m;
        } catch { /* raced away */ }
      }
    } catch { /* raced away */ }
    return latest;
  }

  // ── Data-workspace quota guard (facet-mcp-foundation-v1 3.1) ───────────────
  // A light `du -sk` estimate per enabled, quota-declared workspace. Over the
  // bound it logs and lands ONE meter line + fleet event per over-limit
  // episode — never deletes, never blocks a turn: the workspace is durable
  // customer data and this guardrail only speaks.
  checkWorkspaceQuotas() {
    for (const [key, entry] of this.entries) {
      const ws = entry?.metadata?.workspace;
      const quotaMb = Number(ws?.quotaMb);
      if (ws?.enabled !== true || !Number.isInteger(quotaMb) || quotaMb <= 0) continue;
      const dataDir = path.join(this.config.homeRoot, key, "data");
      let usageMb = null;
      try {
        const out = execFileSync("du", ["-sk", dataDir], { encoding: "utf8" });
        usageMb = Math.ceil(Number(String(out).split(/\s+/)[0]) / 1024);
      } catch {
        continue; // no workspace dir yet (or du unavailable) — nothing to guard
      }
      if (!(usageMb > quotaMb)) {
        this.#quotaAlerted.delete(key); // back under — the next breach alerts anew
        continue;
      }
      if (this.#quotaAlerted.has(key)) continue; // episode already reported
      this.#quotaAlerted.add(key);
      this.#meterLine(key, "workspace_quota", { ok: true, usageMb, quotaMb });
      this.#fleetEmit("workspace_quota_exceeded", entry, { usage_mb: usageMb, quota_mb: quotaMb });
      this.log.warn(`[agent-runner] ${key} data workspace over quota: ~${usageMb}MB > ${quotaMb}MB (guardrail only — nothing deleted)`);
    }
  }

  // ── Metered turns (add-agent-residency D3/D6) ─────────────────────────────
  // ONE queueing discipline for every turn source: messages (A2A), self-turns
  // (rhythm), and digests (day rollover) all acquire through here, and every
  // completed/failed turn lands one jsonl meter line (the ③ settlement input).
  async turn(entry, sessionId, text, { kind = "message", onDelta, delegationDepth = 0 } = {}) {
    const key = agentKeyFor(entry);
    if (this.pausedKeys.has(key)) {
      throw Object.assign(new Error("agent paused"), { code: -32010 });
    }
    const release = delegationDepth >= 1 ? await this.#acquireDelegationSlot(key) : null;
    // Pod in-flight discipline (add-dsh-pod-adapter D7): turn CLOSE is
    // serialized process-wide on this dsh line (probe-concurrent-turn-close —
    // two sessions each with their own agent context still starve), so a
    // pod's turns share a bounded lane count. Queue under the same
    // bounded-queue law as capacity: never fail, never preempt.
    const route = this.groups.get(key);
    if (route?.pod) await this.#awaitPodLane(route);
    const startedAt = this.now();
    // Session attribution (add-mission-runner-attribution D1): the session
    // name rides both turn events so the observer can attribute turns to
    // their origin (mission dispatches arrive as srv-mission-<id>).
    this.#fleetEmit("turn_started", entry, { turn_kind: kind, session: sessionId });
    try {
      const child = await this.acquire(entry);
      try {
        const out = await child.turn(sessionId, text, { onDelta, agentKey: route?.pod ? key : undefined });
        this.#meterLine(key, kind, {
          ok: true,
          tokens: tokensOf(out?.usage),
          durationMs: this.now() - startedAt,
          depth: delegationDepth || undefined,
        });
        this.#fleetEmit("turn_ended", entry, {
          turn_kind: kind,
          session: sessionId,
          duration_ms: this.now() - startedAt,
          outcome: "ok",
          ...(() => { const t = tokensOf(out?.usage); return t == null ? {} : { tokens: t }; })(),
        });
        return out;
      } catch (e) {
        // Budget kill (add-serving-budgets D3): the child's timeout marker
        // plus the timeout code — this turn (message/self/digest alike) is
        // recorded as a budget kill and the child is hard-stopped. A
        // concurrent turn settling via _child_exit (-32002) is never
        // mislabeled: only the marker+codes pair matches.
        const budgetKilled = e?.code === -32001 && child.budgetKilled === true;
        this.#meterLine(key, kind, {
          ok: false,
          error: String(e?.message || e),
          durationMs: this.now() - startedAt,
          budgetKill: budgetKilled || undefined,
        });
        this.#fleetEmit("turn_ended", entry, {
          turn_kind: kind,
          session: sessionId,
          duration_ms: this.now() - startedAt,
          outcome: "error",
          budget_killed: budgetKilled || undefined,
        });
        if (budgetKilled) {
          this.#fleetEmit("budget_killed", entry, { turn_kind: kind, duration_ms: this.now() - startedAt });
          this.#hardStopOnBudget(key, child);
        }
        throw e;
      }
    } finally {
      release?.();
    }
  }

  // Over-budget hard stop (add-serving-budgets D3, ADR-0014 ④): the child is
  // dead to the manager — it re-spawns on the role's next touch (private
  // home, session storage, and written files survive on disk). The delete is
  // guarded so a concurrently replaced child is never evicted by a stale kill.
  #hardStopOnBudget(key, child) {
    if (this.children.get(key) === child) this.children.delete(key);
    this.log.warn(`[agent-runner] ${key} over turn budget (${child.budgetLabel}) — hard stop; next touch re-warms`);
    child.stop().catch(() => {});
  }

  // A rhythm self-turn (the scheduler calls this): the platform-injected turn
  // whose initiator is the agent itself. Rides the same acquire/queue face.
  async selfTurn(entry, prompt, sessionId) {
    return this.turn(entry, sessionId, prompt, { kind: "self" });
  }

  #meterLine(key, kind, info) {
    try {
      mkdirSync(path.dirname(this.config.meterFile), { recursive: true });
      appendFileSync(
        this.config.meterFile,
        `${JSON.stringify({ agent: key, kind, at: new Date(this.now()).toISOString(), ...info })}\n`,
      );
    } catch (e) {
      this.log.warn(`[agent-runner] meter write failed: ${e.message}`);
    }
  }

  // Fleet event emit (add-fleet-event-backbone): the reporter slugifies the
  // agent identity; a broken sink never breaks serving.
  #fleetEmit(kind, entryOrKey, payload = {}) {
    if (!this.events) return;
    try {
      const entry = typeof entryOrKey === "string" ? this.entries.get(entryOrKey) : entryOrKey;
      this.events({ kind, agent: entry?.path ?? String(entryOrKey), payload });
    } catch { /* observability must never break a turn */ }
  }

  async #spawnChild(key, entry) {
    // Harness selection (add-harness-adapter D5, hoisted by
    // add-harness-materializer D1): the descriptor's declared harness wins,
    // else the runner default. The registry resolves it to an adapter; an
    // unknown name throws UNSUPPORTED_HARNESS inside create() below (the
    // deploy gate normally refused earlier — the runner never assumes it
    // did) and the cold-start escalation retries it like any other spawn
    // failure. COMPOSITION is harness-aware: an ACP harness branches to its
    // own materializer and never builds a DSH_HOME; dsh keeps the exact
    // pre-existing pipeline below.
    const harnessName = typeof entry.metadata?.harness === "string" && entry.metadata.harness ? entry.metadata.harness : DEFAULT_HARNESS;
    if (this.harnessRegistry.kindOf(harnessName) === "acp") {
      return this.#spawnAcpChild(key, entry, harnessName);
    }
    const { config } = this;
    const descriptor = entry.metadata;
    const skillContents = {};
    for (const p of descriptor.skills ?? []) {
      skillContents[p] = await this.registryClient.fetchSkillContent(p);
    }
    const mcpServers = (descriptor.mcpServers ?? []).map((name) =>
      mcpEntry(name, { url: this.registryClient.mcpUrlFor(name), token: config.registryToken }),
    );
    const spec = await materializeAgentHome({
      homeRoot: config.homeRoot,
      agentKey: key,
      entry,
      skillContents,
      mcpServers,
      mcpTools: descriptor.mcpTools ?? null,
      seedHome: config.seedHome,
    });
    // Per-agent billing key (add-agent-platform-ops D2): fetch by reference
    // from the pack gateway (runner service credential) and pin it into the
    // private home's credential store — this child's turns bill the deployer.
    // A fetch failure keeps the runner-level key but is never silent.
    const keyRef = descriptor.billing_key_ref;
    if (keyRef != null && config.packsBaseUrl) {
      try {
        await applyBillingKey(spec.home, await this.#fetchBillingKeyValue(keyRef));
        this.log.log(`[agent-runner] ${key} running on its own billing key (ref ${keyRef})`);
      } catch (e) {
        this.log.warn(`[agent-runner] billing key fetch failed for ${key} — falling back to the runner-level key: ${e.message}`);
      }
    }
    // Deployment secrets (add-deployment-secrets D4): fetch EVERY declared
    // secret by reference first, then pin the complete set in one write. A
    // fetch that cannot resolve fails composition loudly with the reference
    // named — no partial set, no fallback value; the child is never
    // half-credentialed and never runs on a substitute.
    const secretRefs = descriptor.secret_refs ?? {};
    if (Object.keys(secretRefs).length > 0) {
      if (!config.packsBaseUrl) {
        throw new Error(`deployment secrets declared (${Object.keys(secretRefs).join(", ")}) but the pack gateway URL is not configured (AGENT_RUNNER_PACKS_URL)`);
      }
      const values = {};
      for (const [name, ref] of Object.entries(secretRefs)) {
        try {
          values[name] = await this.#fetchSecretValue(ref);
        } catch (e) {
          throw new Error(`deployment secret '${name}' (ref ${maskSecretRef(ref)}) could not be fetched — refusing to compose ${key}: ${e.message}`);
        }
      }
      applyDeploymentSecrets(spec.home, values);
      this.log.log(`[agent-runner] ${key} pinned ${Object.keys(values).length} deployment secret(s): ${Object.entries(secretRefs).map(([n, ref]) => `${n} ${maskSecretRef(ref, values[n])}`).join(", ")}`);
    }
    // Effective turn budget (add-serving-budgets D3): the descriptor's
    // declared minutes take precedence; otherwise the runner's deployment
    // default. Over it the turn is hard-stopped (see turn()). The spawn
    // spec carries the resolved ms so the harness client's own request
    // timeout rides just past the budget instead of past the default.
    const budgetMinutes = Number(descriptor.effective_budget_minutes);
    const hasBudget = Number.isFinite(budgetMinutes) && budgetMinutes > 0;
    const turnBudgetMs = hasBudget ? budgetMinutes * 60_000 : config.turnTimeoutMs;
    const budgetLabel = hasBudget ? `${budgetMinutes}m` : `${Math.max(1, Math.ceil(config.turnTimeoutMs / 60_000))}m`;
    // Notification binding (add-agent-notifications D2/D3): captured at spawn;
    // a binding change is part of the identity hash, so a rebind re-spawns
    // instead of talking to the previous channel. The handler runs host-side
    // with the runner-held relay credential — the child never holds either.
    const notifyChannel = typeof descriptor.notify_channel === "string" && descriptor.notify_channel ? descriptor.notify_channel : null;
    // (harness selection lives at the top of #spawnChild — see the acp
    // dispatch note; the dsh pipeline below is its consumer.)
    const spawnSpec = {
      profile: config.dshProfile,
      patchPaths: spec.patchPaths,
      // Sandbox writable root (fix-agent-data-workspace-writes): dsh derives
      // the workspace-write boundary from the session cwd (initialize cwd,
      // else the spawn process cwd), so a declared data workspace becomes
      // the child's cwd — the data dir turns writable, nothing else widens
      // (home stays out: it holds credentials and the persona preset).
      // No declaration → config.cwd exactly as before.
      cwd: spec.dataDir ?? config.cwd,
      // The child sees the runner's environment minus every relay
      // credential (add-agent-notifications D2): the token's sole owner is
      // this process's configuration. A declared data workspace adds
      // AGENT_DATA_DIR (+ AGENT_DATA_QUOTA_MB) on top — no declaration,
      // no keys (facet-mcp-foundation-v1 3.1).
      env: workspaceChildEnv(spec, scrubbedChildEnv(process.env)),
      provider: config.provider,
      // Per-deployment model (ADR-0019): the descriptor's effective model
      // wins; absent falls back to the runner's deployment-level default.
      // The provider family stays the runner's — the model string resolves
      // through the routing store (LLM_PROVIDERS_STORE).
      model: typeof descriptor.effective_model === "string" && descriptor.effective_model
        ? descriptor.effective_model
        : config.model,
      presetId: spec.presetId,
      version: descriptor.packVersion ?? null,
    };
    let child = null;
    const onExit = () => {
      if (child && this.children.get(key) === child) this.children.delete(key);
    };
    const adapter = this.harnessRegistry.create(harnessName, {
      key,
      log: this.log,
      onNotify: (payload) => this.notifier.send({ agent: key, boundChannel: notifyChannel, ...payload }),
      onExit,
      turnTimeoutMs: turnBudgetMs,
      budgetLabel,
      spawnSpec,
      // The dsh factory needs the manager-owned client factory (which carries
      // the private home) — an ACP harness ignores it.
      dshFactory: (args) => new DshHarnessAdapter({
        ...args,
        clientFactory: this.clientFactory({ ...spec, turnBudgetMs }),
      }),
    });
    child = new AgentChild({ key, spawnSpec, turnTimeoutMs: turnBudgetMs, budgetLabel, log: this.log, adapter });
    this.children.set(key, child);
    this.log.log(`[agent-runner] cold-starting ${key} (v${child.version ?? "?"}, harness=${harnessName}, ${mcpServers.length} MCP, ${(descriptor.skills ?? []).length} skills)`);
    try {
      await child.start();
    } catch (e) {
      // A failed cold-start must not leave a half-built child in the map —
      // the next turn would reuse it and crash on its null client (live
      // finding 2026-10-11: an adapter-miss start left "reading 'prompt'"
      // for every later turn until restart). Identity-guarded so a
      // concurrently replaced child is never evicted.
      if (this.children.get(key) === child) this.children.delete(key);
      throw e;
    }
    // Residency hooks (add-agent-residency): the rollover's deferred day roll
    // rides a warm agent's re-warm. Fire-and-forget — never blocks serving.
    this.onSpawnHook?.(key, entry);
    return child;
  }

  // ── ACP composition (add-harness-materializer D1/D2/D4) ────────────────────
  // Pack content lands in the layout the ACP binary natively reads — a
  // private workspace, never a DSH_HOME. The credential honesty matrix lives
  // here: the deployment's billing key overrides the runner's standing
  // credential through spawnSpec.acpCredentialEnv (attribution parity with
  // the dsh path's applyBillingKey); deployment secrets are REFUSED — the
  // process env is not a controlled channel for an arbitrary ACP binary, and
  // fail-closed beats the pre-slice④ silent loss into a home nobody read;
  // tool allowlists degrade open with a warning (no ACP equivalent).
  async #spawnAcpChild(key, entry, harnessName) {
    const { config } = this;
    const descriptor = entry.metadata;
    const skillContents = {};
    for (const p of descriptor.skills ?? []) {
      skillContents[p] = await this.registryClient.fetchSkillContent(p);
    }
    const mcpServers = acpMcpServers(descriptor.mcpServers ?? [], this.registryClient, config.registryToken);
    const spec = materializeAcpWorkspace({
      homeRoot: config.homeRoot,
      agentKey: key,
      entry,
      skillContents,
      harnessName,
      log: this.log,
    });
    if (descriptor.mcpTools && typeof descriptor.mcpTools === "object" && Object.keys(descriptor.mcpTools).length > 0) {
      this.log.warn(`[agent-runner] ${key}: mcpTools allowlist has no ACP-harness equivalent — MCP tools run unscoped (dsh-only depth)`);
    }
    const refusal = acpSecretsRefusal(descriptor.secret_refs ?? {}, harnessName);
    if (refusal) throw refusal;
    // Per-deployment billing key: fetch by reference (the same route the dsh
    // path uses), then override the standing credential. A fetch failure
    // degrades to the standing credential with a warning — verbatim the dsh
    // contract.
    let acpCredentialEnvValue = null;
    const keyRef = descriptor.billing_key_ref;
    if (keyRef != null && config.packsBaseUrl) {
      try {
        acpCredentialEnvValue = acpCredentialEnv(await this.#fetchBillingKeyValue(keyRef));
        this.log.log(`[agent-runner] ${key} running on its own billing key (ref ${keyRef})`);
      } catch (e) {
        this.log.warn(`[agent-runner] billing key fetch failed for ${key} — falling back to the runner-level key: ${e.message}`);
      }
    }
    const budgetMinutes = Number(descriptor.effective_budget_minutes);
    const hasBudget = Number.isFinite(budgetMinutes) && budgetMinutes > 0;
    const turnBudgetMs = hasBudget ? budgetMinutes * 60_000 : config.turnTimeoutMs;
    const budgetLabel = hasBudget ? `${budgetMinutes}m` : `${Math.max(1, Math.ceil(config.turnTimeoutMs / 60_000))}m`;
    const notifyChannel = typeof descriptor.notify_channel === "string" && descriptor.notify_channel ? descriptor.notify_channel : null;
    const spawnSpec = {
      // cwd = the materialized workspace: the harness's project root — the
      // persona file and native skills live there and the SDK's project
      // settings load from it. A declared data workspace no longer MOVES the
      // cwd (the dsh sandbox rule does not apply); AGENT_DATA_DIR points the
      // tools at the writable volume instead.
      cwd: spec.workspace,
      env: workspaceChildEnv(spec, scrubbedChildEnv(process.env)),
      provider: config.provider,
      model: typeof descriptor.effective_model === "string" && descriptor.effective_model ? descriptor.effective_model : config.model,
      version: descriptor.packVersion ?? null,
      acpMcpServers: mcpServers,
      ...(acpCredentialEnvValue ? { acpCredentialEnv: acpCredentialEnvValue } : {}),
    };
    let child = null;
    const onExit = () => {
      if (child && this.children.get(key) === child) this.children.delete(key);
    };
    const adapter = this.harnessRegistry.create(harnessName, {
      key,
      log: this.log,
      onNotify: (payload) => this.notifier.send({ agent: key, boundChannel: notifyChannel, ...payload }),
      onExit,
      turnTimeoutMs: turnBudgetMs,
      budgetLabel,
      spawnSpec,
    });
    child = new AgentChild({ key, spawnSpec, turnTimeoutMs: turnBudgetMs, budgetLabel, log: this.log, adapter });
    this.children.set(key, child);
    this.log.log(`[agent-runner] cold-starting ${key} (v${child.version ?? "?"}, harness=${harnessName}, ${mcpServers.length} MCP, ${(descriptor.skills ?? []).length} skills, layout=${spec.layout ?? "bare"})`);
    try {
      await child.start();
    } catch (e) {
      // The dsh path's half-built-child rule, verbatim: a failed cold-start
      // must not leave a dead child in the map for later turns to reuse.
      if (this.children.get(key) === child) this.children.delete(key);
      throw e;
    }
    this.onSpawnHook?.(key, entry);
    return child;
  }

  // (reapIdle removed — residency is the default since add-agent-residency;
  // the warm-zone budget's enforceBudget() is the only demotion path.)

  // ── Pod spawn (add-dsh-pod-adapter) ─────────────────────────────────────────
  // Fetch helpers shared by solo and pod composition — same routes, same
  // credential discipline; callers own the failure policy (solo: billing
  // degrades with a warning, secrets refuse; pods mirror both).
  async #fetchBillingKeyValue(keyRef) {
    const r = await fetch(`${this.config.packsBaseUrl}/api/packs/internal/llm-key/${encodeURIComponent(keyRef)}`, {
      headers: { Authorization: `Bearer ${this.config.registryToken}` },
      signal: AbortSignal.timeout(10_000),
    });
    const doc = await r.json().catch(() => ({}));
    if (!r.ok || !doc?.keyValue) throw new Error(doc?.error || `HTTP ${r.status}`);
    return doc.keyValue;
  }

  async #fetchSecretValue(ref) {
    const r = await fetch(`${this.config.packsBaseUrl}/api/packs/internal/secret/${encodeURIComponent(ref)}`, {
      headers: { Authorization: `Bearer ${this.config.registryToken}` },
      signal: AbortSignal.timeout(10_000),
    });
    const doc = await r.json().catch(() => ({}));
    if (!r.ok || typeof doc?.secretValue !== "string" || doc.secretValue.length === 0) {
      throw new Error(doc?.error || `HTTP ${r.status}`);
    }
    return doc.secretValue;
  }

  async #spawnPod(route) {
    const { config } = this;
    const members = this.#groupMembersOf(route) ?? route.members;
    const memberSpecs = [];
    const mcpRows = new Map(); // name → loader row (union across members)
    const secretValues = new Map(); // name → value (same-name-same-ref by eligibility)
    let billingKeyValue = null;
    let billingRef = null;
    const faces = new Map(); // agentKey → per-member turn face
    let maxBudgetMs = config.turnTimeoutMs;
    for (const [key, entry] of members) {
      const descriptor = entry.metadata;
      const skillContents = {};
      for (const p of descriptor.skills ?? []) {
        skillContents[p] = await this.registryClient.fetchSkillContent(p);
      }
      for (const name of descriptor.mcpServers ?? []) {
        if (!mcpRows.has(name)) {
          mcpRows.set(name, mcpEntry(name, { url: this.registryClient.mcpUrlFor(name), token: config.registryToken }));
        }
      }
      if (billingRef == null && descriptor.billing_key_ref != null) billingRef = descriptor.billing_key_ref;
      if (Object.keys(descriptor.secret_refs ?? {}).length > 0 && !config.packsBaseUrl) {
        throw new Error(`deployment secrets declared but the pack gateway URL is not configured (AGENT_RUNNER_PACKS_URL) — refusing to compose pod ${route.childKey}`);
      }
      for (const [name, ref] of Object.entries(descriptor.secret_refs ?? {})) {
        if (!secretValues.has(name)) {
          try {
            secretValues.set(name, await this.#fetchSecretValue(ref));
          } catch (e) {
            throw new Error(`deployment secret '${name}' (ref ${maskSecretRef(ref)}) could not be fetched — refusing to compose pod ${route.childKey}: ${e.message}`);
          }
        }
      }
      const budgetMinutes = Number(descriptor.effective_budget_minutes);
      const hasBudget = Number.isFinite(budgetMinutes) && budgetMinutes > 0;
      const turnBudgetMs = hasBudget ? budgetMinutes * 60_000 : config.turnTimeoutMs;
      maxBudgetMs = Math.max(maxBudgetMs, turnBudgetMs);
      faces.set(key, {
        presetId: null, // filled from the materialized roster below
        provider: config.provider,
        model: typeof descriptor.effective_model === "string" && descriptor.effective_model
          ? descriptor.effective_model
          : config.model,
        turnTimeoutMs: turnBudgetMs,
        budgetLabel: hasBudget ? `${budgetMinutes}m` : `${Math.max(1, Math.ceil(config.turnTimeoutMs / 60_000))}m`,
      });
      memberSpecs.push({ entry, skillContents, secrets: null, billingKeyValue: null });
    }
    // One shared billing key (eligibility guaranteed a single distinct ref):
    // fetch once, pin once — a fetch failure degrades to the runner-level key
    // with a warning, exactly the solo contract.
    if (billingRef != null && config.packsBaseUrl) {
      try {
        billingKeyValue = await this.#fetchBillingKeyValue(billingRef);
      } catch (e) {
        this.log.warn(`[agent-runner] billing key fetch failed for pod ${route.childKey} — falling back to the runner-level key: ${e.message}`);
      }
    }
    if (billingKeyValue != null) memberSpecs[0].billingKeyValue = billingKeyValue;
    // materializePackHome takes merged secrets as ONE set on the first spec.
    if (secretValues.size) memberSpecs[0].secrets = Object.fromEntries(secretValues);

    const spec = await materializePackHome({
      homeRoot: config.homeRoot,
      packId: route.packId,
      memberSpecs,
      mcpServers: [...mcpRows.values()],
      seedHome: config.seedHome,
    });
    for (const [key, face] of faces) face.presetId = spec.presetIds.get(key) ?? null;
    // The notify binding (eligibility: one shared channel or none) — the
    // audit identity is the pod (bot_notify carries no session identity on
    // this wire, so member attribution is structurally unavailable).
    const notifyChannel = [...members.values()]
      .map((e) => e.metadata?.notify_channel)
      .find((c) => typeof c === "string" && c) ?? null;
    const version = members.values().next().value?.metadata?.packVersion ?? null;
    const child = new AgentChild({
      key: route.childKey,
      version,
      turnTimeoutMs: config.turnTimeoutMs,
      budgetLabel: `${Math.max(1, Math.ceil(config.turnTimeoutMs / 60_000))}m`,
      costFloorMb: config.podCostMb,
      podMembers: faces,
      clientFactory: this.clientFactory({
        home: spec.home,
        patchPaths: spec.patchPaths,
        // The shared writable root: any member's data-workspace declaration
        // turns the pack volume on (one pod = one cwd/env).
        cwd: spec.dataDir ?? config.cwd,
        env: workspaceChildEnv(spec, scrubbedChildEnv(process.env)),
        provider: config.provider,
        model: config.model,
        presetId: null,
        version,
        turnBudgetMs: maxBudgetMs,
      }),
      log: this.log,
      notifyHandler: (payload) => this.notifier.send({ agent: route.childKey, boundChannel: notifyChannel, ...payload }),
      onExit: () => {
        if (this.children.get(route.childKey) === child) this.children.delete(route.childKey);
      },
      spawnSpec: {
        profile: config.dshProfile,
        patchPaths: spec.patchPaths,
        cwd: spec.dataDir ?? config.cwd,
        env: workspaceChildEnv(spec, scrubbedChildEnv(process.env)),
        provider: config.provider,
        // Process-level defaults are a fallback only — every member session
        // parks its own preset and model before its first prompt (child.js).
        model: config.model,
        presetId: null,
        version,
      },
    });
    this.children.set(route.childKey, child);
    this.log.log(`[agent-runner] cold-starting pod ${route.childKey} (${members.size} members, ${mcpRows.size} MCP)`);
    try {
      await child.start();
    } catch (e) {
      if (this.children.get(route.childKey) === child) this.children.delete(route.childKey);
      throw e;
    }
    // Runtime-capabilities gate (design D2): pod serving requires the bridge
    // live methods — parked persona/model selection and native cancel. An
    // older runtime missing any method must not wedge a pack: stop the pod
    // and hand the pack back to solo children (sticky until the composition
    // identity changes).
    try {
      const caps = await child.request("platform/capabilities", {});
      const methods = Array.isArray(caps?.methods) ? caps.methods : [];
      for (const required of ["preset/set", "model/set", "session/cancel"]) {
        if (!methods.includes(required)) throw new Error(`runtime does not report '${required}'`);
      }
    } catch (e) {
      await child.stop().catch(() => {});
      if (this.children.get(route.childKey) === child) this.children.delete(route.childKey);
      throw Object.assign(
        new Error(`pod capabilities probe failed (${e?.message || e})`),
        { code: "POD_CAPABILITIES_MISSING" },
      );
    }
    // Residency hooks fire per member, exactly like a solo re-warm — the
    // rollover's deferred day roll rides a member's re-warm whichever child
    // hosts it.
    for (const [key, entry] of members) {
      this.onSpawnHook?.(key, entry);
    }
    return child;
  }

  async stopAll() {
    for (const timer of this.#slotWaiters ?? []) clearInterval(timer);
    for (const timer of this.#podLaneWaiters ?? []) clearInterval(timer);
    await Promise.allSettled([...this.children.values()].map((c) => c.drainAndStop(2000)));
    this.children.clear();
    for (const key of [...this.#listeners.keys()]) this.#stopListener(key);
  }
}
