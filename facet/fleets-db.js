// Facet-owned fleet organization store (facet-owns-its-fleets D1).
//
// Same pattern as facet/studio.js → studio-docs.db: the facet keeps its own
// SQLite file with the ORGANIZATION subset of the platform's fleet schema. The
// platform's fleets-db.js is 3191 lines (delegation, precedents, domain maps,
// run ledgers) — none of that is copied. What lives here is what the read face
// and the management actions actually use:
//
//   fleets        the team itself (+ origin: who is authoritative)
//   fleet_members the posts (title/parent/cadence/KPI slots/harness declaration)
//   fleet_edges   declared orchestration edges
//   decision_items owner approval queue (answer recording only — no dispatch)
//
// `origin` is the writability gate (D2): 'platform' rows are a read-only mirror
// of a team that lives elsewhere; the route layer answers 409 for their writes.
// `harness` is a DECLARATION string (D4) — the facet never imports, starts or
// validates an executor; any harness name is accepted verbatim.
//
// WAL, snake_case columns, camelCase API — identical to the other sqlite stores.

import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

export const FLEET_STATES = ["active", "paused", "archived"];
export const FLEET_ORIGINS = ["facet", "platform"];

export function createFleetDatabase({ file } = {}) {
  if (!file) throw new Error("createFleetDatabase needs { file }");
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const db = new Database(file);
  db.pragma("journal_mode = WAL");

  db.exec(`CREATE TABLE IF NOT EXISTS fleets (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    owner_email TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'active',
    origin TEXT NOT NULL DEFAULT 'facet',
    console_slug TEXT,
    console_published_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_fleets_console_slug ON fleets(console_slug)`);

  db.exec(`CREATE TABLE IF NOT EXISTS fleet_members (
    id TEXT PRIMARY KEY,
    fleet_id TEXT NOT NULL,
    title TEXT NOT NULL,
    parent_id TEXT,
    cadence TEXT,
    kpi_slots TEXT NOT NULL DEFAULT '[]',
    harness TEXT,
    sort_key INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_fleet_members_fleet ON fleet_members(fleet_id, sort_key)`);

  db.exec(`CREATE TABLE IF NOT EXISTS fleet_edges (
    id TEXT PRIMARY KEY,
    fleet_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    from_ref TEXT,
    to_ref TEXT,
    sort_key INTEGER NOT NULL DEFAULT 0
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_fleet_edges_fleet ON fleet_edges(fleet_id, sort_key)`);

  db.exec(`CREATE TABLE IF NOT EXISTS decision_items (
    id TEXT PRIMARY KEY,
    fleet_id TEXT NOT NULL,
    member_id TEXT,
    question TEXT NOT NULL,
    options TEXT NOT NULL DEFAULT '[]',
    severity TEXT NOT NULL DEFAULT 'normal',
    state TEXT NOT NULL DEFAULT 'open',
    resolution TEXT,
    submitted_at INTEGER NOT NULL,
    resolved_at INTEGER
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_facet_decision_items_fleet ON decision_items(fleet_id, state)`);

  const json = (v, fallback) => {
    if (v == null) return fallback;
    try {
      return JSON.parse(v);
    } catch {
      return fallback;
    }
  };

  const toFleet = (row) =>
    row && {
      id: row.id,
      name: row.name,
      ownerEmail: row.owner_email,
      state: row.state,
      origin: row.origin,
      consoleSlug: row.console_slug,
      consolePublishedAt: row.console_published_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };

  const toMember = (row) =>
    row && {
      id: row.id,
      fleetId: row.fleet_id,
      title: row.title,
      parentId: row.parent_id,
      cadence: json(row.cadence, null),
      kpiSlots: json(row.kpi_slots, []),
      harness: row.harness,
      sortKey: row.sort_key,
    };

  const toEdge = (row) =>
    row && { id: row.id, fleetId: row.fleet_id, kind: row.kind, from: row.from_ref, to: row.to_ref };

  const toDecision = (row) =>
    row && {
      id: row.id,
      fleetId: row.fleet_id,
      memberId: row.member_id,
      question: row.question,
      options: json(row.options, []),
      severity: row.severity,
      state: row.state,
      resolution: json(row.resolution, null),
      submittedAt: row.submitted_at,
      resolvedAt: row.resolved_at,
    };

  // ── fleets ────────────────────────────────────────────────────────────────
  function createFleet(fleet) {
    const now = Date.now();
    const origin = FLEET_ORIGINS.includes(fleet.origin) ? fleet.origin : "facet";
    db.prepare(`
      INSERT INTO fleets (id, name, owner_email, state, origin, console_slug, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      fleet.id,
      String(fleet.name),
      String(fleet.ownerEmail ?? ""),
      FLEET_STATES.includes(fleet.state) ? fleet.state : "active",
      origin,
      fleet.consoleSlug ?? null,
      now,
      now,
    );
    return getFleet(fleet.id);
  }

  function getFleet(id) {
    return toFleet(db.prepare("SELECT * FROM fleets WHERE id = ?").get(id));
  }

  function getFleetByConsoleSlug(slug) {
    if (!slug) return null;
    return toFleet(db.prepare("SELECT * FROM fleets WHERE console_slug = ?").get(slug));
  }

  function listFleets({ ownerEmail = null } = {}) {
    const rows = ownerEmail
      ? db.prepare("SELECT * FROM fleets WHERE owner_email = ? ORDER BY created_at DESC").all(ownerEmail)
      : db.prepare("SELECT * FROM fleets ORDER BY created_at DESC").all();
    return rows.map(toFleet);
  }

  function updateFleet(id, updates = {}) {
    const COLUMNS = {
      name: "name",
      state: "state",
      consoleSlug: "console_slug",
      consolePublishedAt: "console_published_at",
    };
    const setParts = [];
    const values = [];
    for (const [key, col] of Object.entries(COLUMNS)) {
      if (!Object.hasOwn(updates, key)) continue;
      if (key === "state" && !FLEET_STATES.includes(updates.state)) continue;
      setParts.push(`${col} = ?`);
      values.push(updates[key] ?? null);
    }
    if (!setParts.length) return getFleet(id);
    setParts.push("updated_at = ?");
    values.push(Date.now(), id);
    db.prepare(`UPDATE fleets SET ${setParts.join(", ")} WHERE id = ?`).run(...values);
    return getFleet(id);
  }

  function deleteFleet(id) {
    const tx = db.transaction(() => {
      db.prepare("DELETE FROM decision_items WHERE fleet_id = ?").run(id);
      db.prepare("DELETE FROM fleet_edges WHERE fleet_id = ?").run(id);
      db.prepare("DELETE FROM fleet_members WHERE fleet_id = ?").run(id);
      return db.prepare("DELETE FROM fleets WHERE id = ?").run(id);
    });
    return { ok: true, deleted: tx().changes };
  }

  // ── members (posts) ───────────────────────────────────────────────────────
  function createMember(member) {
    const now = Date.now();
    db.prepare(`
      INSERT INTO fleet_members (id, fleet_id, title, parent_id, cadence, kpi_slots, harness, sort_key, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      member.id,
      member.fleetId,
      String(member.title),
      member.parentId ?? null,
      member.cadence ? JSON.stringify(member.cadence) : null,
      JSON.stringify(member.kpiSlots ?? []),
      member.harness ?? null,
      Number.isFinite(member.sortKey) ? member.sortKey : now,
      now,
      now,
    );
    return getMember(member.id);
  }

  function getMember(id) {
    return toMember(db.prepare("SELECT * FROM fleet_members WHERE id = ?").get(id));
  }

  function listMembers(fleetId) {
    return db
      .prepare("SELECT * FROM fleet_members WHERE fleet_id = ? ORDER BY sort_key, created_at")
      .all(fleetId)
      .map(toMember);
  }

  function updateMember(id, updates = {}) {
    const PLAIN = { title: "title", parentId: "parent_id", harness: "harness" };
    const JSON_COLUMNS = { cadence: "cadence", kpiSlots: "kpi_slots" };
    const setParts = [];
    const values = [];
    for (const [key, col] of Object.entries(PLAIN)) {
      if (!Object.hasOwn(updates, key)) continue;
      setParts.push(`${col} = ?`);
      values.push(updates[key] ?? null);
    }
    for (const [key, col] of Object.entries(JSON_COLUMNS)) {
      if (!Object.hasOwn(updates, key)) continue;
      setParts.push(`${col} = ?`);
      values.push(JSON.stringify(updates[key] ?? null));
    }
    if (!setParts.length) return getMember(id);
    setParts.push("updated_at = ?");
    values.push(Date.now(), id);
    db.prepare(`UPDATE fleet_members SET ${setParts.join(", ")} WHERE id = ?`).run(...values);
    return getMember(id);
  }

  // ── edges (declared orchestration) ────────────────────────────────────────
  function createEdge(edge) {
    db.prepare(`INSERT INTO fleet_edges (id, fleet_id, kind, from_ref, to_ref, sort_key) VALUES (?, ?, ?, ?, ?, ?)`).run(
      edge.id,
      edge.fleetId,
      String(edge.kind),
      edge.from ?? null,
      edge.to ?? null,
      Number.isFinite(edge.sortKey) ? edge.sortKey : Date.now(),
    );
    return toEdge(db.prepare("SELECT * FROM fleet_edges WHERE id = ?").get(edge.id));
  }

  function listEdges(fleetId) {
    return db
      .prepare("SELECT * FROM fleet_edges WHERE fleet_id = ? ORDER BY sort_key")
      .all(fleetId)
      .map(toEdge);
  }

  // ── decisions (answer recording only — nothing here dispatches) ───────────
  function createDecision(item) {
    db.prepare(`
      INSERT INTO decision_items (id, fleet_id, member_id, question, options, severity, state, submitted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      item.id,
      item.fleetId,
      item.memberId ?? null,
      String(item.question),
      JSON.stringify(item.options ?? []),
      item.severity ?? "normal",
      item.state ?? "open",
      Number.isFinite(item.submittedAt) ? item.submittedAt : Date.now(),
    );
    return getDecision(item.id);
  }

  function getDecision(id) {
    return toDecision(db.prepare("SELECT * FROM decision_items WHERE id = ?").get(id));
  }

  function listDecisions({ fleetId, state = null } = {}) {
    const rows = state
      ? db.prepare("SELECT * FROM decision_items WHERE fleet_id = ? AND state = ? ORDER BY submitted_at").all(fleetId, state)
      : db.prepare("SELECT * FROM decision_items WHERE fleet_id = ? ORDER BY submitted_at").all(fleetId);
    return rows.map(toDecision);
  }

  // Records the owner's answer. Open-only (a second answer is a 409 upstream —
  // first resolution wins, same discipline as the platform's queue).
  function answerDecision(id, { choice, note = null, by = null } = {}) {
    const item = getDecision(id);
    if (!item) return null;
    if (item.state !== "open") return null;
    const now = Date.now();
    const resolution = JSON.stringify({ kind: "answer", choice, note, by, at: now });
    db.prepare("UPDATE decision_items SET state = ?, resolution = ?, resolved_at = ? WHERE id = ? AND state = 'open'").run(
      "resolved",
      resolution,
      now,
      id,
    );
    return getDecision(id);
  }

  function close() {
    db.close();
  }

  return {
    db,
    createFleet,
    getFleet,
    getFleetByConsoleSlug,
    listFleets,
    updateFleet,
    deleteFleet,
    createMember,
    getMember,
    listMembers,
    updateMember,
    createEdge,
    listEdges,
    createDecision,
    getDecision,
    listDecisions,
    answerDecision,
    close,
  };
}
