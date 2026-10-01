// ── Child manager (add-a2a-agent-serving 4.4) ───────────────────────────────
//
// Reconciles the runner's children with the registry's served-agent list
// (poll-driven, design D4), bounds concurrency by queueing (never evicting a
// busy child), reaps idle children, and drains on upgrade/undeploy.

import http from "node:http";
import { AgentChild } from "./child.js";
import { agentKeyFor, materializeAgentHome, mcpEntry } from "./compose.js";
import { createAgentApp, agentPortFor } from "./a2a.js";

export class ChildManager {
  #slotWaiters = new Set(); // capacity-queue interval timers, cleared on shutdown
  #listeners = new Map(); // agentKey → http server (per-agent port, upstream #1734)
  constructor({ config, registryClient, clientFactory, log = console, now = () => Date.now() }) {
    this.config = config;
    this.registryClient = registryClient;
    this.clientFactory = clientFactory;
    this.log = log;
    this.now = now;
    this.children = new Map(); // agentKey → AgentChild
    this.entries = new Map(); // agentKey → registry entry (card source)
    this.versions = new Map(); // agentKey → descriptor version identity
    this.pending = new Map(); // agentKey → promise chain while a slot is awaited
    this.waiting = 0; // queued turn requests at capacity
  }

  health() {
    const agents = [];
    for (const [key, entry] of this.entries) {
      const child = this.children.get(key);
      agents.push({
        key,
        path: entry?.path ?? null,
        port: agentPortFor(entry.path, { base: this.config.portBase ?? 8791, span: this.config.portSpan ?? 32 }),
        state: child ? child.state : "idle",
        version: child?.version ?? entry?.metadata?.packVersion ?? null,
      });
    }
    return { ok: true, agents, children: this.children.size, queued: this.waiting };
  }

  // One HTTP listener per hosted agent (the registry proxy maps /agent/{path}
  // onto the registered origin — see a2a.js). Started on first reconcile that
  // wants the agent; stopped (drained) when the entry leaves.
  #ensureListener(key, entry) {
    if (this.#listeners.has(key)) return;
    // Port derives from the REGISTRY path — the same input the deploy side
    // hashes when it registers the URL (lib/agent-serving agentPortFor).
    const port = agentPortFor(entry.path, { base: this.config.portBase ?? 8791, span: this.config.portSpan ?? 32 });
    const server = http.createServer(createAgentApp({ entry, manager: this, config: this.config, log: this.log }));
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
      });
      const existing = this.children.get(key);
      this.entries.set(key, entry);
      this.#ensureListener(key, entry);
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

  // Acquire the child for a key, materializing + spawning on demand (cold
  // start after reap or first touch). At capacity: first try to evict an
  // IDLE child (least-recently-active — the same semantics as an idle reap,
  // which the next message pays back as a cold start); if every child is
  // busy, the request QUEUES — it never fails and never evicts a busy child
  // (spec: "without evicting a busy child").
  async acquire(entry) {
    const key = agentKeyFor(entry);
    for (;;) {
      const live = this.children.get(key);
      if (live && !live.draining) return live;
      if (this.children.size < this.config.maxChildren || this.#evictIdleChild()) {
        const child = await this.#spawnChild(key, entry);
        if (!child.draining) return child;
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

  // Best candidate for a capacity eviction: idle, not draining, least
  // recently active. Returns true when one was evicted.
  #evictIdleChild() {
    let victim = null;
    for (const [key, child] of this.children) {
      if (child.draining || child.activeTurns > 0) continue;
      if (!victim || child.lastActivityAt < victim.child.lastActivityAt) victim = { key, child };
    }
    if (!victim) return false;
    this.children.delete(victim.key);
    this.log.log(`[agent-runner] capacity: evicting idle ${victim.key} (next message cold-starts it)`);
    victim.child.stop().catch(() => {});
    return true;
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
    const child = new AgentChild({
      key,
      version: descriptor.packVersion ?? null,
      turnTimeoutMs: config.turnTimeoutMs,
      clientFactory: this.clientFactory(spec),
      log: this.log,
      spawnSpec: {
        profile: config.dshProfile,
        patchPaths: spec.patchPaths,
        cwd: config.cwd,
        env: process.env,
        provider: config.provider,
        model: config.model,
        presetId: spec.presetId,
      },
    });
    this.children.set(key, child);
    this.log.log(`[agent-runner] cold-starting ${key} (v${child.version ?? "?"}, ${mcpServers.length} MCP, ${(descriptor.skills ?? []).length} skills)`);
    await child.start();
    return child;
  }

  // Spec: idle children are reaped (default 30 min); the next message cold
  // starts. Never reaps a draining child mid-drain or one with active turns.
  reapIdle() {
    for (const [key, child] of this.children) {
      if (child.draining || child.activeTurns > 0) continue;
      if (this.now() - child.lastActivityAt >= this.config.idleMs) {
        this.children.delete(key);
        this.log.log(`[agent-runner] reaping idle ${key}`);
        child.stop().catch(() => {});
      }
    }
  }

  async stopAll() {
    for (const timer of this.#slotWaiters ?? []) clearInterval(timer);
    await Promise.allSettled([...this.children.values()].map((c) => c.drainAndStop(2000)));
    this.children.clear();
    for (const key of [...this.#listeners.keys()]) this.#stopListener(key);
  }
}
