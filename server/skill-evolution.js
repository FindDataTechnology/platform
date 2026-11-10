// ── Skill self-evolution store + gate (add-skill-self-evolution) ────────────
//
// The closed loop: agent proposes a skill CANDIDATE (via the skill-evolution
// MCP tool over the loopback bridge) → candidate is evaluated (two-arm A/B:
// the same scenario task answered with and without the candidate skill
// injected, judge blind-ranked with arm names anonymized) → a human accepts
// (promote into custom_skills, materializer hot-loads it) or rejects (final,
// audited). supersedes candidates record lineage on the OLD skill — never
// delete (永不删页只 lineage).
//
// Structural guarantees this module owns:
//   - candidates NEVER touch custom_skills (promotion is the only bridge)
//   - evaluation is LLM-only over the cell's default lane: no filesystem,
//     no turn execution, no production data touched (the scratch-root
//     discipline degenerates to "no side effects" for a text-only harness)
//   - "评测没跑成 ≠ 通过" (laneError 分界): an interrupted evaluation leaves
//     the candidate in `candidate` status with an honest reason
//   - budget: per-day proposal cap + store cap + same-title debounce

import * as dbModule from "../db.js";

// db.js exposes getDb(); keep a short local handle (module-level `db` there is
// initialized by initDb() at boot — call-time access, never import-time).
const D = () => dbModule.getDb();

export const PROPOSAL_DAILY_CAP = () => Number(process.env.SKILL_PROPOSE_DAILY_CAP || 20);
export const STORE_CAP = () => Number(process.env.SKILL_CANDIDATE_STORE_CAP || 200);
export const DEBOUNCE_HOURS = () => Number(process.env.SKILL_PROPOSE_DEBOUNCE_HOURS || 24);

// 8.1 回链：source_doc_id 是 studio 发起提案时带的工作区文档 id（可空——
// cell 内 MCP 提案没有文档上下文，缺席是常态而非缺数据）。
const ROW = "id, name, description, body, evidence, supersedes, status, eval_report, proposed_by, created_at, decided_at, decided_by, source_doc_id";

function deserialize(r) {
  if (!r) return null;
  let evidence = r.evidence;
  let evalReport = null;
  try { evidence = JSON.parse(r.evidence); } catch { /* keep raw */ }
  try { evalReport = r.eval_report ? JSON.parse(r.eval_report) : null; } catch { evalReport = { raw: r.eval_report }; }
  return { ...r, evidence, evalReport, sourceDocId: r.source_doc_id ?? null };
}

export function skillEvolutionStore() {
  return {
    // ── proposals (the tool face's only write) ──────────────────────────────
    proposeGate({ name }) {
      const dayAgo = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
      const today = D().prepare(
        `SELECT COUNT(*) AS n FROM skill_candidates WHERE proposed_by IS NOT NULL AND created_at >= ?`,
      ).get(new Date(new Date().toDateString()).toISOString());
      if (today.n >= PROPOSAL_DAILY_CAP()) {
        return { ok: false, code: "budget", error: `daily proposal budget exhausted (${PROPOSAL_DAILY_CAP()}/day) — try tomorrow` };
      }
      const total = D().prepare(`SELECT COUNT(*) AS n FROM skill_candidates`).get().n;
      if (total >= STORE_CAP()) {
        return { ok: false, code: "store-cap", error: `candidate store full (${STORE_CAP()}) — the owner must review or reject pending candidates first` };
      }
      const dupe = D().prepare(
        `SELECT id, created_at FROM skill_candidates WHERE lower(name) = lower(?) AND created_at >= ?`,
      ).get(String(name), dayAgo);
      if (dupe) {
        return { ok: false, code: "debounce", error: `a candidate named '${name}' was proposed within ${DEBOUNCE_HOURS()}h (id ${dupe.id}) — same-task re-proposals are debounced` };
      }
      return { ok: true };
    },

    createCandidate({ name, description, body, evidence, supersedes, proposedBy, sourceDocId }) {
      // supersedes must reference a REAL custom skill (pack-owned rows are
      // refused at the tool face; this is the store-side re-check).
      if (supersedes != null) {
        const target = D().prepare(`SELECT name, origin_pack_id FROM custom_skills WHERE name = ?`).get(String(supersedes));
        if (!target) return { error: `supersedes references unknown skill '${supersedes}'` };
        if (target.origin_pack_id) return { error: `skill '${supersedes}' belongs to a pack (origin_pack_id) — pack skills are not evolvable` };
      }
      const id = `sc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      D().prepare(
        `INSERT INTO skill_candidates (id, name, description, body, evidence, supersedes, status, proposed_by, created_at, source_doc_id)
         VALUES (?, ?, ?, ?, ?, ?, 'candidate', ?, ?, ?)`,
      ).run(id, String(name).slice(0, 120), String(description).slice(0, 2000), String(body), JSON.stringify(evidence ?? {}), supersedes ?? null, proposedBy ?? "agent", dbModule.nowIso(), typeof sourceDocId === "string" && sourceDocId.trim() ? sourceDocId.trim() : null);
      return { candidate: deserialize(D().prepare(`SELECT ${ROW} FROM skill_candidates WHERE id = ?`).get(id)) };
    },

    // ── read faces ────────────────────────────────────────────────────────────
    listCandidates(status = null) {
      const rows = status
        ? D().prepare(`SELECT ${ROW} FROM skill_candidates WHERE status = ? ORDER BY created_at DESC`).all(status)
        : D().prepare(`SELECT ${ROW} FROM skill_candidates ORDER BY created_at DESC`).all();
      return rows.map(deserialize);
    },
    getCandidate(id) {
      return deserialize(D().prepare(`SELECT ${ROW} FROM skill_candidates WHERE id = ?`).get(id));
    },

    // ── evaluation ────────────────────────────────────────────────────────────
    saveEvalReport(id, report) {
      D().prepare(`UPDATE skill_candidates SET eval_report = ? WHERE id = ?`).run(JSON.stringify(report), id);
    },

    // ── decisions (human-only; the routes gate identity) ──────────────────────
    markEvaluated(id) {
      D().prepare(`UPDATE skill_candidates SET status = 'evaluated' WHERE id = ? AND status = 'candidate'`).run(id);
    },
    markUnevaluated(id, reason) {
      D().prepare(`UPDATE skill_candidates SET status = 'candidate', eval_report = ? WHERE id = ?`)
        .run(JSON.stringify({ error: "evaluation failed", reason }), id);
    },
    promote(id, { by }) {
      const cand = this.getCandidate(id);
      if (!cand) return { error: "not found" };
      if (cand.status !== "evaluated") return { error: `candidate is '${cand.status}' — promote requires a green evaluation` };
      // Lineage first (on the OLD row), then insert the new skill. The
      // materializer mirrors custom_skills on the next CRUD broadcast — the
      // skill goes live with zero restarts.
      if (cand.supersedes) {
        const old = D().prepare(`SELECT id FROM custom_skills WHERE name = ?`).get(cand.supersedes);
        if (old) {
          D().prepare(`UPDATE custom_skills SET evolution_lineage = ? WHERE id = ?`).run(
            JSON.stringify({ supersededBy: cand.name, candidateId: cand.id, at: dbModule.nowIso(), evalReport: cand.evalReport ?? null }), old.id);
        }
      }
      const exists = D().prepare(`SELECT id FROM custom_skills WHERE name = ?`).get(cand.name);
      if (exists) return { error: `a skill named '${cand.name}' already exists — promotion would collide` };
      D().prepare(
        `INSERT INTO custom_skills (id, name, description, content, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, 1, ?, ?)`,
      ).run(`cs_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, cand.name, cand.description, cand.body, dbModule.nowIso(), dbModule.nowIso());
      D().prepare(`UPDATE skill_candidates SET status = 'promoted', decided_at = ?, decided_by = ? WHERE id = ?`).run(dbModule.nowIso(), by, id);
      return { ok: true, promoted: cand.name };
    },
    reject(id, { by, reason }) {
      const cand = this.getCandidate(id);
      if (!cand) return { error: "not found" };
      if (cand.status === "promoted") return { error: "already promoted" };
      D().prepare(`UPDATE skill_candidates SET status = 'rejected', decided_at = ?, decided_by = ? WHERE id = ?`).run(dbModule.nowIso(), by, id);
      return { ok: true, rejected: cand.name, reason: reason ?? null };
    },
  };
}
