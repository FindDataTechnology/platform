// Database persistence for dynamic clusters (agent-cluster-platform)
//
// Provides persistent storage for dynamic clusters using SQLite.
// Replaces the in-memory store with a durable solution.

import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import { storeDir } from "../../paths.js";

export function createClusterDatabase({ file }) {
  const dbPath = file || path.join(storeDir("data"), "clusters.db");
  
  // Ensure directory exists
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  
  // Create tables
  db.exec(`CREATE TABLE IF NOT EXISTS dynamic_clusters (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    tags TEXT DEFAULT '[]',
    agents TEXT NOT NULL DEFAULT '[]',
    activate_all INTEGER NOT NULL DEFAULT 1,
    bind_to_session INTEGER NOT NULL DEFAULT 0,
    session_id TEXT,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER NOT NULL,
    total_executions INTEGER NOT NULL DEFAULT 0,
    total_tokens_used INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'ready'
  )`);
  
  // Index for efficient queries
  db.exec(`CREATE INDEX IF NOT EXISTS idx_clusters_last_used ON dynamic_clusters(last_used_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_clusters_status ON dynamic_clusters(status)`);
  
  return {
    db,
    
    // CRUD operations
    create(cluster) {
      const now = Date.now();
      db.prepare(`
        INSERT INTO dynamic_clusters 
        (id, name, description, tags, agents, activate_all, bind_to_session, session_id, created_at, last_used_at, total_executions, total_tokens_used, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        cluster.id,
        cluster.name,
        cluster.description,
        JSON.stringify(cluster.tags || []),
        JSON.stringify(cluster.agents),
        cluster.activateAll ? 1 : 0,
        cluster.bindToSession ? 1 : 0,
        cluster.sessionId || null,
        now,
        now,
        0,
        0,
        cluster.status || "ready"
      );
      return cluster;
    },
    
    get(id) {
      const row = db.prepare(`SELECT * FROM dynamic_clusters WHERE id = ?`).get(id);
      if (!row) return null;
      return deserialize(row);
    },
    
    update(id, updates) {
      // camelCase (JS shape) → snake_case (column names)
      const COLUMNS = {
        name: "name",
        description: "description",
        tags: "tags",
        status: "status",
        lastUsedAt: "last_used_at",
        totalExecutions: "total_executions",
        totalTokensUsed: "total_tokens_used",
      };
      const setParts = [];
      const values = [];

      for (const [key, value] of Object.entries(updates)) {
        const col = COLUMNS[key];
        if (!col) continue;

        setParts.push(`${col} = ?`);
        if (key === "tags") values.push(JSON.stringify(value));
        else if (key === "lastUsedAt" || key === "totalExecutions" || key === "totalTokensUsed") values.push(Number(value));
        else values.push(value);
      }

      if (setParts.length === 0) return null;

      values.push(id);
      db.prepare(`UPDATE dynamic_clusters SET ${setParts.join(", ")} WHERE id = ?`).run(...values);
      return { id, updated: true };
    },

    delete(id) {
      const result = db.prepare("DELETE FROM dynamic_clusters WHERE id = ?").run(id);
      return result.changes > 0;
    },
    
    listAll() {
      return db.prepare(`SELECT * FROM dynamic_clusters WHERE status != 'terminated' ORDER BY last_used_at DESC`).all()
        .map(deserialize);
    },

    count() {
      return db.prepare(`SELECT COUNT(*) AS n FROM dynamic_clusters WHERE status != 'terminated'`).get().n;
    },

    countActive() {
      return db.prepare(`SELECT COUNT(*) AS n FROM dynamic_clusters WHERE status = 'ready'`).get().n;
    },

    // Per-cell store: every cluster in this db belongs to the cell's owner, so
    // the email is accepted for interface symmetry and not (yet) filtered on.
    listByUser(_email) {
      // For now, return all active clusters
      return db.prepare(`SELECT * FROM dynamic_clusters WHERE status != 'terminated' ORDER BY last_used_at DESC`).all()
        .map(deserialize);
    },
    
    findExpiring(gracePeriodMs, absoluteTimeoutMs) {
      const now = Date.now();
      return db.prepare(`
        SELECT * FROM dynamic_clusters 
        WHERE status != 'terminated'
        AND (
          (last_used_at < ? AND total_executions < 5)
          OR last_used_at < ?
        )
      `).all(now - gracePeriodMs, now - absoluteTimeoutMs)
        .map(deserialize);
    },
    
    incrementExecutions(id) {
      db.prepare(`
        UPDATE dynamic_clusters 
        SET total_executions = total_executions + 1, last_used_at = ?
        WHERE id = ?
      `).run(Date.now(), id);
    },
    
    incrementTokens(id, tokens) {
      db.prepare(`
        UPDATE dynamic_clusters 
        SET total_tokens_used = total_tokens_used + ?
        WHERE id = ?
      `).run(Number(tokens), id);
    },
    
    cleanupTerminated() {
      const result = db.prepare("DELETE FROM dynamic_clusters WHERE status = 'terminated'").run();
      return result.changes;
    },
    
    close() {
      db.close();
    }
  };
}

function deserialize(row) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    tags: JSON.parse(row.tags || "[]"),
    agents: JSON.parse(row.agents || "[]"),
    activateAll: !!row.activate_all,
    bindToSession: !!row.bind_to_session,
    sessionId: row.session_id,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    totalExecutions: row.total_executions || 0,
    totalTokensUsed: row.total_tokens_used || 0,
    status: row.status || "ready"
  };
}

// Export singleton instance
let clusterDb = null;

export function getClusterDatabase() {
  if (!clusterDb) {
    clusterDb = createClusterDatabase({});
  }
  return clusterDb;
}

export function setClusterDatabase(db) {
  clusterDb = db;
}
