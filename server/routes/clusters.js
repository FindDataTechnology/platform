// Dynamic cluster management (agent-cluster-platform)
// Storage: SQLite via clusters-db.js (durable across restarts; the
// in-memory Map this module started with lost clusters on every rollout).

import * as db from "../../db.js";
import { getClusterDatabase } from "./clusters-db.js";

const CLUSTER_RATE_LIMIT = 10;
const CLUSTER_RATE_WINDOW = 60 * 60 * 1000;

const rateLimitBuckets = new Map();

function checkRateLimit(email) {
  const now = Date.now();
  let bucket = rateLimitBuckets.get(email);
  
  if (!bucket || now > bucket.resetAt) {
    bucket = { count: 0, resetAt: now + CLUSTER_RATE_WINDOW };
    rateLimitBuckets.set(email, bucket);
  }
  
  if (bucket.count >= CLUSTER_RATE_LIMIT) {
    return false;
  }
  
  bucket.count += 1;
  return true;
}

setInterval(() => {
  const cutoff = Date.now() - CLUSTER_RATE_WINDOW;
  for (const [key, bucket] of rateLimitBuckets) {
    if (bucket.resetAt <= cutoff) {
      rateLimitBuckets.delete(key);
    }
  }
}, CLUSTER_RATE_WINDOW).unref();

const clusterDb = getClusterDatabase();

// Same auth-off semantics as the pack market (server.js registerMarketPackRoutes):
// with auth on, identity is the forward-auth user; with auth off the requester
// is the machine owner. The unconditional req.user gate this module shipped
// with made every cluster route 401 in local/e2e auth-off mode.
function resolveUserFactory(ctx) {
  return (req) =>
    req.user ?? (ctx?.authEnabled ? null : { email: ctx?.cellUserEmail || "owner@local", groups: [] });
}

export function createClusterRoutes(app, ctx = null) {
  const resolveUser = resolveUserFactory(ctx);
  app.post("/api/clusters/dynamic", async (req, res) => {
    try {
      const user = resolveUser(req);
      if (!user) {
        return res.status(401).json({ error: "Authentication required" });
      }
      
      if (!checkRateLimit(user.email)) {
        return res.status(429).json({ 
          error: "Too many cluster creations, try again later" 
        });
      }
      
      const { name, description, tags, agents, activateAll = true, bindToSession, sessionId: bodySessionId } = req.body;

      if (!name || typeof name !== "string" || !name.trim()) {
        return res.status(400).json({ error: "Cluster name is required" });
      }

      // Session binding (dynamic-cluster-composer spec): the client names the
      // session it wants the cluster attached to. The old `req.sessionId` read
      // was dead — no middleware ever set it, so bindToSession silently no-op'd.
      const bindSessionId =
        bindToSession && typeof bodySessionId === "string" && bodySessionId.trim()
          ? bodySessionId.trim().slice(0, 128)
          : null;
      
      if (!Array.isArray(agents) || agents.length === 0) {
        return res.status(400).json({ error: "At least one agent is required" });
      }
      
      const invalidAgents = [];
      for (const agentRef of agents) {
        if (!agentRef.packId || !agentRef.agentId) {
          invalidAgents.push(agentRef);
          continue;
        }
        
        const subscription = db.getInstalledPack(agentRef.packId);
        if (!subscription) {
          invalidAgents.push({ ...agentRef, reason: "not_subscribed" });
        }
      }
      
      if (invalidAgents.length > 0) {
        return res.status(400).json({ 
          error: "Invalid agent references",
          invalidAgents 
        });
      }
      
      const clusterId = `dyn_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      const createdAt = Date.now();
      
      let hasInstalling = false;
      const processedAgents = agents.map(a => {
        const sub = db.getInstalledPack(a.packId);
        const status = sub ? "active" : "installing";
        if (!sub) hasInstalling = true;
        
        return {
          packId: a.packId,
          agentId: a.agentId,
          version: a.version,
          status
        };
      });
      
      const clusterData = {
        id: clusterId,
        name: name.trim(),
        description: description?.trim() || "",
        tags: tags?.filter(t => typeof t === "string" && t.trim()).slice(0, 5) || [],
        agents: processedAgents,
        activateAll,
        bindToSession,
        sessionId: bindSessionId,
        createdAt,
        lastUsedAt: createdAt,
        totalExecutions: 0,
        totalTokensUsed: 0,
        status: hasInstalling ? "loading" : "ready"
      };
      
      clusterDb.create(clusterData);

      if (bindSessionId) {
        if (!global.clusterSessionBindings) {
          global.clusterSessionBindings = new Map();
        }
        // One cluster per session: a newer binding replaces the older one.
        for (const [sid, cid] of global.clusterSessionBindings) {
          if (cid === clusterId || sid === bindSessionId) global.clusterSessionBindings.delete(sid);
        }
        global.clusterSessionBindings.set(bindSessionId, clusterId);
        ctx?.broadcast?.({
          type: "cluster_bound",
          clusterId,
          clusterName: clusterData.name,
          sessionId: bindSessionId,
        });
      }
      
      res.json({
        clusterId,
        status: clusterData.status,
        name: clusterData.name,
        agents: clusterData.agents.map(a => ({ ...a, status: a.status }))
      });
    
    } catch (err) {
      console.error("[cluster] handler error:", err);
      if (!res.headersSent) res.status(500).json({ error: err.message || "internal error" });
    }
  });
  
  // Session-derived listing (the UI has no email to pass): "my clusters".
  app.get("/api/clusters/mine", (req, res) => {
    try {
      const user = resolveUser(req);
      if (!user) return res.status(401).json({ error: "Authentication required" });
      const clusters = clusterDb.listByUser(user.email).map((cluster) => ({
        clusterId: cluster.id,
        name: cluster.name,
        status: cluster.status,
        agentCount: cluster.agents.length,
        // Session-binding recency: a reconnecting client matches this against
        // its current session id to restore the "running with cluster" chip.
        sessionId: cluster.sessionId ?? null,
        createdAt: cluster.createdAt,
        lastUsedAt: cluster.lastUsedAt,
      }));
      res.json({ clusters });
    } catch (err) {
      console.error("[cluster] handler error:", err);
      if (!res.headersSent) res.status(500).json({ error: err.message || "internal error" });
    }
  });

  app.get("/api/clusters/:id", (req, res) => {
    try {
      const clusterId = req.params.id;
      const cluster = clusterDb.get(clusterId);
      
      if (!cluster) {
        return res.status(404).json({ error: "Cluster not found" });
      }
      
      cluster.lastUsedAt = Date.now();
      
      res.json({
        clusterId: cluster.id,
        name: cluster.name,
        description: cluster.description,
        tags: cluster.tags,
        status: cluster.status,
        createdAt: cluster.createdAt,
        lastUsedAt: cluster.lastUsedAt,
        totalExecutions: cluster.totalExecutions,
        totalTokensUsed: cluster.totalTokensUsed,
        agents: cluster.agents
      });
    
    } catch (err) {
      console.error("[cluster] handler error:", err);
      if (!res.headersSent) res.status(500).json({ error: err.message || "internal error" });
    }
  });
  
  app.patch("/api/clusters/:id", (req, res) => {
    try {
      const clusterId = req.params.id;
      const cluster = clusterDb.get(clusterId);
      
      if (!cluster) {
        return res.status(404).json({ error: "Cluster not found" });
      }
      
      const { name, description, tags } = req.body;
      
      if (name !== undefined) {
        if (typeof name !== "string" || !name.trim()) {
          return res.status(400).json({ error: "Invalid cluster name" });
        }
        cluster.name = name.trim();
        clusterDb.update(clusterId, { name: cluster.name });
      }
      
      if (description !== undefined) {
        cluster.description = description?.trim() || "";
        clusterDb.update(clusterId, { description: cluster.description });
      }
      
      if (tags !== undefined) {
        if (!Array.isArray(tags)) {
          return res.status(400).json({ error: "Tags must be an array" });
        }
        cluster.tags = tags.filter(t => typeof t === "string" && t.trim()).slice(0, 5);
        clusterDb.update(clusterId, { tags: cluster.tags });
      }
      
      res.json({
        clusterId: cluster.id,
        name: cluster.name,
        description: cluster.description,
        tags: cluster.tags,
        updatedAt: Date.now()
      });
    
    } catch (err) {
      console.error("[cluster] handler error:", err);
      if (!res.headersSent) res.status(500).json({ error: err.message || "internal error" });
    }
  });
  
  app.delete("/api/clusters/:id", (req, res) => {
    try {
      const clusterId = req.params.id;
      const cluster = clusterDb.get(clusterId);
      
      if (!cluster) {
        return res.status(404).json({ error: "Cluster not found" });
      }
      
      clusterDb.update(clusterId, { status: "terminated" });

      if (cluster.bindToSession && cluster.sessionId) {
        global.clusterSessionBindings?.delete(cluster.sessionId);
        // Spec (dynamic-cluster-composer): a terminated bound session falls
        // back to the built-in agent — the event carries what the client
        // needs to switch and notify.
        ctx?.broadcast?.({
          type: "cluster_terminated",
          clusterId,
          clusterName: cluster.name,
          sessionId: cluster.sessionId,
        });
      }
      
      res.json({
        success: true,
        message: "Cluster terminated"
      });
    
    } catch (err) {
      console.error("[cluster] handler error:", err);
      if (!res.headersSent) res.status(500).json({ error: err.message || "internal error" });
    }
  });
  
  app.post("/api/clusters/:id/agents", (req, res) => {
    try {
      const clusterId = req.params.id;
      const cluster = clusterDb.get(clusterId);
      
      if (!cluster) {
        return res.status(404).json({ error: "Cluster not found" });
      }
      
      const { agents } = req.body;
      
      if (!Array.isArray(agents) || agents.length === 0) {
        return res.status(400).json({ error: "At least one agent is required" });
      }
      
      const added = [];
      for (const agentRef of agents) {
        const exists = cluster.agents.some(a => 
          a.packId === agentRef.packId && a.agentId === agentRef.agentId
        );
        
        if (exists) {
          continue;
        }
        
        const sub = db.getInstalledPack(agentRef.packId);
        if (!sub) {
          continue;
        }
        
        cluster.agents.push({
          packId: agentRef.packId,
          agentId: agentRef.agentId,
          version: agentRef.version,
          status: "active"
        });
        
        added.push(agentRef.agentId);
      }
      
      res.json({
        clusterId: cluster.id,
        added,
        totalAgents: cluster.agents.length
      });
    
    } catch (err) {
      console.error("[cluster] handler error:", err);
      if (!res.headersSent) res.status(500).json({ error: err.message || "internal error" });
    }
  });
  
  app.delete("/api/clusters/:id/agents/:agentId", (req, res) => {
    try {
      const clusterId = req.params.id;
      const agentId = req.params.agentId;
      const cluster = clusterDb.get(clusterId);
      
      if (!cluster) {
        return res.status(404).json({ error: "Cluster not found" });
      }
      
      const index = cluster.agents.findIndex(a => a.agentId === agentId);
      
      if (index === -1) {
        return res.status(404).json({ error: "Agent not found in cluster" });
      }
      
      cluster.agents.splice(index, 1);
      
      res.json({
        clusterId: cluster.id,
        removedAgentId: agentId,
        remainingAgents: cluster.agents.length
      });
    
    } catch (err) {
      console.error("[cluster] handler error:", err);
      if (!res.headersSent) res.status(500).json({ error: err.message || "internal error" });
    }
  });
  
  app.get("/api/clusters/user/:email", (req, res) => {
    try {
      const requestedEmail = req.params.email;
      const user = resolveUser(req);

      if (!user || user.email !== requestedEmail) {
        return res.status(403).json({ error: "Forbidden" });
      }
      
      const userClusters = [];
      for (const cluster of clusterDb.listByUser(user.email)) {
        userClusters.push({
          clusterId: cluster.id,
          name: cluster.name,
          status: cluster.status,
          agentCount: cluster.agents.length,
          createdAt: cluster.createdAt,
          lastUsedAt: cluster.lastUsedAt
        });
      }
      
      res.json({ clusters: userClusters });
    
    } catch (err) {
      console.error("[cluster] handler error:", err);
      if (!res.headersSent) res.status(500).json({ error: err.message || "internal error" });
    }
  });
}

// ── Auto-termination (dynamic-cluster-composer spec: usage tracking) ────────
//
// Idle clusters (≥24h unused with <5 executions, or ≥7d unused) get a warning
// event, then a 1h grace period, then termination — re-checked at fire time
// so a cluster that was used during the grace period survives. One pending
// timer per cluster (the hourly scan would otherwise stack timers), and the
// termination releases the session binding + broadcasts cluster_terminated
// exactly like the manual DELETE, so a bound session falls back cleanly.
//
// The tick is exported (with injectable clock/db/scheduler) so the threshold
// and grace logic is unit-testable without real timers.
const AUTO_TERM_GRACE_MS = 24 * 60 * 60 * 1000;
const AUTO_TERM_ABSOLUTE_MS = 7 * 24 * 60 * 60 * 1000;
const AUTO_TERM_WARN_LEAD_MS = 60 * 60 * 1000;

export function autoTerminationTick({
  db = clusterDb,
  now = Date.now(),
  broadcast = null,
  pending = new Map(),
  schedule = (fn, ms) => setTimeout(fn, ms).unref?.(),
  graceMs = AUTO_TERM_GRACE_MS,
  absoluteMs = AUTO_TERM_ABSOLUTE_MS,
  warnLeadMs = AUTO_TERM_WARN_LEAD_MS,
} = {}) {
  const candidates = db.findExpiring(graceMs, absoluteMs);
  const scheduled = [];
  for (const cluster of candidates) {
    if (pending.has(cluster.id)) continue;
    broadcast?.({
      type: "cluster_expiring",
      clusterId: cluster.id,
      clusterName: cluster.name,
      terminatesAt: now + warnLeadMs,
    });
    const fire = () => {
      pending.delete(cluster.id);
      const fresh = db.get(cluster.id);
      if (!fresh || fresh.status === "terminated") return;
      // Still idle? A use during the grace period moved lastUsedAt forward.
      const stillExpiring = db.findExpiring(graceMs, absoluteMs).some((c) => c.id === cluster.id);
      if (!stillExpiring) return;
      db.update(cluster.id, { status: "terminated" });
      if (fresh.bindToSession && fresh.sessionId) {
        global.clusterSessionBindings?.delete(fresh.sessionId);
        broadcast?.({
          type: "cluster_terminated",
          clusterId: cluster.id,
          clusterName: fresh.name,
          sessionId: fresh.sessionId,
        });
      }
      console.log(`[cluster] Auto-terminated: ${cluster.id}`);
    };
    pending.set(cluster.id, fire);
    schedule(fire, warnLeadMs);
    scheduled.push(cluster.id);
  }
  return scheduled;
}

export function startAutoTerminationJob(ctx = null) {
  const pending = new Map();
  setInterval(() => {
    try {
      autoTerminationTick({ broadcast: ctx?.broadcast ?? null, pending });
    } catch (err) {
      console.warn(`[cluster] auto-termination tick failed: ${err.message}`);
    }
  }, 60 * 60 * 1000).unref();
}
