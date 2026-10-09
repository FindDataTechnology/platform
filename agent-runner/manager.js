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

// Flatten a dsh usage payload to a token count; null when absent (metering
// records the turn without tokens rather than guessing).
function tokensOf(usage) {
  if (!usage || typeof usage !== "object") return null;
  const t = usage.total_tokens ?? usage.totalTokens ?? usage.tokens;
  return Number.isFinite(Number(t)) ? Number(t) : null;
}
import { agentKeyFor, materializeAgentHome, mcpEntry, applyBillingKey, applyDeploymentSecrets, workspaceChildEnv } from "./compose.js";
import { scrubbedChildEnv } from "./child.js";
import { createNotifier } from "./notify.js";
import { maskSecretRef } from "../lib/agent-serving.js";
import { createAgentApp, agentPortFor } from "./a2a.js";

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

export class ChildManager {
  #slotWaiters = new Set(); // capacity-queue interval timers, cleared on shutdown
  #listeners = new Map(); // agentKey → http server (per-agent port, upstream #1734)
  #quotaAlerted = new Set(); // workspace over-quota episodes already reported
  constructor({ config, registryClient, clientFactory, log = console, now = () => Date.now(), notifyFetchImpl, events = null }) {
    this.config = config;
    this.registryClient = registryClient;
    this.clientFactory = clientFactory;
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
    this.children = new Map(); // agentKey → AgentChild (live processes)
    this.entries = new Map(); // agentKey → registry entry (card source)
    this.versions = new Map(); // agentKey → descriptor version identity
    this.pending = new Map(); // agentKey → promise chain while a slot is awaited
    this.waiting = 0; // queued turn requests at capacity
    this.pausedKeys = new Set(); // registry-marked paused (agent-residency D5)
    this.delegationInFlight = new Map(); // agentKey → live depth≥1 turns (a2a delegation D4)
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

  health() {
    const agents = [];
    for (const [key, entry] of this.entries) {
      const child = this.children.get(key);
      agents.push({
        key,
        path: entry?.path ?? null,
        port: agentPortFor(entry.path, { base: this.config.portBase ?? 8791, span: this.config.portSpan ?? 32 }),
        // Five states (spec: agent-runner health): paused > draining >
        // starting > serving (a turn in flight) > resident (warm and idle);
        // no live process = warm (never touched, or demoted by budget/pause).
        state: this.pausedKeys.has(key)
          ? "paused"
          : child
            ? child.draining
              ? "draining"
              : child.ready
                ? child.activeTurns > 0 ? "serving" : "resident"
                : "starting"
            : "warm",
        version: child?.version ?? entry?.metadata?.packVersion ?? null,
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
    // hashes when it registers the URL (lib/agent-serving agentPortFor).
    const port = agentPortFor(entry.path, { base: this.config.portBase ?? 8791, span: this.config.portSpan ?? 32 });
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
    server.listen(port, "0.0.0.0");
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

    // Undeployed / disabled: drain + forget (spec: undeploy stops serving).
    // Entries can exist without a child (card-only service never messaged),
    // so cleanup iterates every known key, not just spawned children.
    for (const key of new Set([...this.children.keys(), ...this.entries.keys(), ...this.#listeners.keys()])) {
      if (wanted.has(key)) continue;
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

    // Known entries refresh card/version views; version changes mark the
    // child draining so the next message spawns the new composition
    // (spec: upgrade swaps in place with drain — one entry, no proliferation).
    for (const [key, entry] of wanted) {
      const identity = JSON.stringify({
        v: entry.metadata?.packVersion,
        persona: entry.metadata?.persona,
        skills: entry.metadata?.skills,
        mcp: entry.metadata?.mcpServers,
        name: entry.name,
        // The effective turn budget materializes at spawn (the child's
        // timeout); a redeploy that changes it drains the old child so the
        // new bound takes effect on the next touch.
        budget: entry.metadata?.effective_budget_minutes,
        // Deployment-secret refs (add-deployment-secrets): a rebind mints a
        // fresh reference, and the pinned values live in the home — the
        // descriptor change must drain the old child so the next spawn
        // re-fetches and re-pins.
        secretRefs: entry.metadata?.secret_refs,
        // The notification binding (add-agent-notifications D2) is captured by
        // the spawn's notify handler; a rebind must drain the old child or it
        // would keep notifying the previous channel.
        notify: entry.metadata?.notify_channel,
        // The data workspace (facet-mcp-foundation-v1 3.1) is captured by the
        // spawn's env (AGENT_DATA_DIR / AGENT_DATA_QUOTA_MB); a declaration
        // change must drain so the next spawn materializes and exports it.
        // Draining never touches the home — data/ persists verbatim.
        workspace: entry.metadata?.workspace,
        // Per-deployment model (agent-service-config / ADR-0019): the spawn's
        // LLM is derived from this field, so a model change must drain the
        // old child — the upgrade-grade channel, no third restart path.
        model: entry.metadata?.effective_model,
      });
      const existing = this.children.get(key);
      this.entries.set(key, entry);
      this.#ensureListener(key, entry);
      // Pause/resume (agent-residency D5): the registry flag is the single
      // source of truth. Pausing demotes a live child (state on disk) and the
      // A2A adapter answers explicit -32010s; resuming just clears the flag —
      // the next event re-warms, and the scheduler resumes from the NEXT due
      // (missed dues are never caught up).
      if (entry.metadata?.paused === true) {
        this.pausedKeys.add(key);
        if (existing && !existing.draining) {
          this.log.log(`[agent-runner] ${key} paused; demoting to warm zone`);
          this.children.delete(key);
          existing.stop().catch(() => {});
        }
      } else {
        this.pausedKeys.delete(key);
      }
      if (existing && this.pausedKeys.has(key)) continue;
      if (existing && this.versions.get(key) !== identity) {
        this.log.log(`[agent-runner] ${key} descriptor changed; draining old child for in-place upgrade`);
        this.versions.set(key, identity);
        this.children.delete(key);
        existing.drainAndStop(this.config.drainMs).catch((e) => this.log.warn(`[agent-runner] upgrade drain failed for ${key}: ${e.message}`));
      } else if (!existing) {
        this.versions.set(key, identity);
      }
    }
    return served.length;
  }

  // Acquire the child for a key, materializing + spawning on demand (a warm
  // re-warm after budget/pause demotion, or a first touch). At capacity:
  // first demote an IDLE child to the warm zone (least-recently-active — the
  // next message re-warms it); if every child is busy, the request QUEUES —
  // it never fails and never demotes a busy child (spec: "without evicting a
  // busy child").
  async acquire(entry) {
    const key = agentKeyFor(entry);
    for (;;) {
      const live = this.children.get(key);
      if (live && !live.draining) return live;
      if (this.children.size < this.config.maxChildren || this.#evictIdleChild()) {
        const child = await this.#spawnChild(key, entry);
        if (!child.draining) {
          this.#fleetEmit("woken", entry, { reason: this.everSpawned.has(key) ? "warm" : "first-touch" });
          this.everSpawned.add(key);
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
  // before a spawn reports its RSS.
  #footprintMb(extraChildren = 0) {
    let bytes = 0;
    for (const child of this.children.values()) {
      const rss = sampleRssBytes(child.pid);
      bytes += Math.max(rss ?? 0, this.config.agentCostMb * 1024 * 1024);
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
          if (ent.name.startsWith("srv-wx-")) {
            candidates.push({ name: ent.name, sessionPath: path.join(dirPath, ent.name) });
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
            if (child.name.startsWith("srv-wx-")) {
              candidates.push({ name: child.name, sessionPath: path.join(dirPath, ent.name, child.name) });
            }
          }
        }
        for (const { name, sessionPath } of candidates) {
          if (this.#sessionActive(agentKey, name)) continue;
          const minutes = parseReapWindow(name);
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
    const startedAt = this.now();
    this.#fleetEmit("turn_started", entry, { turn_kind: kind });
    try {
      const child = await this.acquire(entry);
      try {
        const out = await child.turn(sessionId, text, { onDelta });
        this.#meterLine(key, kind, {
          ok: true,
          tokens: tokensOf(out?.usage),
          durationMs: this.now() - startedAt,
          depth: delegationDepth || undefined,
        });
        this.#fleetEmit("turn_ended", entry, {
          turn_kind: kind,
          duration_ms: this.now() - startedAt,
          outcome: "ok",
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
      seedHome: config.seedHome,
    });
    // Per-agent billing key (add-agent-platform-ops D2): fetch by reference
    // from the pack gateway (runner service credential) and pin it into the
    // private home's credential store — this child's turns bill the deployer.
    // A fetch failure keeps the runner-level key but is never silent.
    const keyRef = descriptor.billing_key_ref;
    if (keyRef != null && config.packsBaseUrl) {
      try {
        const r = await fetch(`${config.packsBaseUrl}/api/packs/internal/llm-key/${encodeURIComponent(keyRef)}`, {
          headers: { Authorization: `Bearer ${config.registryToken}` },
          signal: AbortSignal.timeout(10_000),
        });
        const doc = await r.json().catch(() => ({}));
        if (!r.ok || !doc?.keyValue) throw new Error(doc?.error || `HTTP ${r.status}`);
        await applyBillingKey(spec.home, doc.keyValue);
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
          const r = await fetch(`${config.packsBaseUrl}/api/packs/internal/secret/${encodeURIComponent(ref)}`, {
            headers: { Authorization: `Bearer ${config.registryToken}` },
            signal: AbortSignal.timeout(10_000),
          });
          const doc = await r.json().catch(() => ({}));
          if (!r.ok || typeof doc?.secretValue !== "string" || doc.secretValue.length === 0) {
            throw new Error(doc?.error || `HTTP ${r.status}`);
          }
          values[name] = doc.secretValue;
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
    const child = new AgentChild({
      key,
      version: descriptor.packVersion ?? null,
      turnTimeoutMs: turnBudgetMs,
      budgetLabel,
      clientFactory: this.clientFactory({ ...spec, turnBudgetMs }),
      log: this.log,
      notifyHandler: (payload) => this.notifier.send({ agent: key, boundChannel: notifyChannel, ...payload }),
      spawnSpec: {
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
      },
    });
    this.children.set(key, child);
    this.log.log(`[agent-runner] cold-starting ${key} (v${child.version ?? "?"}, ${mcpServers.length} MCP, ${(descriptor.skills ?? []).length} skills)`);
    await child.start();
    // Residency hooks (add-agent-residency): the rollover's deferred day roll
    // rides a warm agent's re-warm. Fire-and-forget — never blocks serving.
    this.onSpawnHook?.(key, entry);
    return child;
  }

  // (reapIdle removed — residency is the default since add-agent-residency;
  // the warm-zone budget's enforceBudget() is the only demotion path.)

  async stopAll() {
    for (const timer of this.#slotWaiters ?? []) clearInterval(timer);
    await Promise.allSettled([...this.children.values()].map((c) => c.drainAndStop(2000)));
    this.children.clear();
    for (const key of [...this.#listeners.keys()]) this.#stopListener(key);
  }
}
