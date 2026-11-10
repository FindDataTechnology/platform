// ── Persona self-evolution store + gate (add-persona-self-evolution) ────────
//
// The role-bucket twin of skill-evolution.js (same four-stage skeleton, same
// disciplines): agent proposes a persona AMENDMENT CANDIDATE (via the
// persona-evolution MCP tool over the loopback bridge) → candidate is
// evaluated (two-arm persona A/B: the same scenario task answered under the
// current vs the amended persona, judge blind-ranked with arm names
// anonymized) → a human accepts — SPLIT by target (design D3):
//   - a custom preset's persona materializes through the preset CRUD path
//     (old text kept as lineage on the candidate — 可溯可回退);
//   - a PACK persona is NEVER written in place — acceptance opens a fork
//     DRAFT (provenance.forkOf stamped) through the same drafts store the
//     studio fork flow uses; pack versions stay immutable.
// or rejects (final, audited).
//
// Structural guarantees this module owns:
//   - candidates NEVER touch custom_presets, packs, or any live/parked
//     session persona (promotion is the only bridge; sessions re-cast at
//     their own rhythm — 会话人格零热改, D4)
//   - "评测没跑成 ≠ 通过" (laneError 分界): an interrupted evaluation leaves
//     the candidate in `candidate` status with an honest reason
//   - budget: per-day proposal cap + store cap + same-target debounce
//   - a structural sanity scan on the amendment text (credential/endpoint
//     literals are document-forbidden material — the agent-document rule
//     applied to candidates)

import * as dbModule from "../db.js";

const D = () => dbModule.getDb();

export const PROPOSAL_DAILY_CAP = () => Number(process.env.PERSONA_AMEND_DAILY_CAP || 10);
export const STORE_CAP = () => Number(process.env.PERSONA_CANDIDATE_STORE_CAP || 100);
export const DEBOUNCE_HOURS = () => Number(process.env.PERSONA_AMEND_DEBOUNCE_HOURS || 24);
export const PERSONA_MAX_CHARS = 8000; // mirrors the base persona cap discipline

// Credential/endpoint-shaped literals are document-forbidden material
// (openspec: agent-document "carries no endpoints or credentials"). The scan
// is deliberately narrow (high-signal patterns only) — it is a floor, not the
// judgment; the A/B judge sees the amendment in context and the human reads
// the diff before accepting.
const SANITY_PATTERNS = [
  { re: /\b(sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/, label: "credential-like literal" },
  { re: /\b(Bearer\s+[A-Za-z0-9._-]{16,})/i, label: "bearer token literal" },
  { re: /\b(?:password|passwd|api[_-]?key|secret)\s*[:=]\s*\S{8,}/i, label: "credential assignment" },
  { re: /\bhttps?:\/\/\S+\.(?:internal|local|svc)\b/i, label: "internal endpoint literal" },
];

export function personaSanityFindings(text) {
  const s = String(text ?? "");
  const out = [];
  for (const { re, label } of SANITY_PATTERNS) {
    const m = re.exec(s);
    if (m) out.push(label);
  }
  return out;
}

// Resolve the CURRENT persona text a target addresses. `preset` targets read
// db.getUserPreset; `pack` targets read the installed pack manifest's agent.
export function currentPersonaFor({ targetKind, targetRef, agentId }) {
  if (targetKind === "preset") {
    const preset = D().prepare(`SELECT persona FROM user_presets WHERE id = ?`).get(String(targetRef));
    if (!preset) return { error: `preset '${targetRef}' not found` };
    return { persona: preset.persona ?? "" };
  }
  if (targetKind === "pack") {
    const pack = dbModule.listInstalledPacks().find((p) => p.packId === String(targetRef));
    if (!pack) return { error: `pack '${targetRef}' is not installed on this cell` };
    let manifest = pack.manifest;
    if (typeof manifest === "string") {
      try { manifest = JSON.parse(manifest); } catch { manifest = null; }
    }
    const agent = (manifest?.agents ?? []).find((a) => a.id === String(agentId));
    if (!agent) return { error: `pack '${targetRef}' does not declare agent '${agentId}'` };
    if (!pack.manifest) return { error: `pack '${targetRef}' manifest unreadable` };
    return { persona: agent.persona ?? "" };
  }
  return { error: `unknown target kind '${targetKind}'` };
}

// 8.1 回链：source_doc_id 只有 studio 发起的提案才带（cell MCP 提案诚实缺席）。
const ROW = "id, target_kind, target_ref, agent_id, current_persona, amended_persona, evidence, status, eval_report, proposed_by, created_at, decided_at, decided_by, lineage, source_doc_id";

function deserialize(r) {
  if (!r) return null;
  let evidence = r.evidence;
  let evalReport = null;
  try { evidence = JSON.parse(r.evidence); } catch { /* keep raw */ }
  try { evalReport = r.eval_report ? JSON.parse(r.eval_report) : null; } catch { evalReport = { raw: r.eval_report }; }
  return { ...r, evidence, evalReport, sourceDocId: r.source_doc_id ?? null };
}

export function personaEvolutionStore() {
  return {
    // ── proposals (the tool face's only write) ──────────────────────────────
    proposeGate({ targetKind, targetRef, agentId }) {
      const today = D().prepare(
        `SELECT COUNT(*) AS n FROM persona_candidates WHERE proposed_by IS NOT NULL AND created_at >= ?`,
      ).get(new Date(new Date().toDateString()).toISOString());
      if (today.n >= PROPOSAL_DAILY_CAP()) {
        return { ok: false, code: "budget", error: `daily amendment budget exhausted (${PROPOSAL_DAILY_CAP()}/day) — try tomorrow` };
      }
      const total = D().prepare(`SELECT COUNT(*) AS n FROM persona_candidates`).get().n;
      if (total >= STORE_CAP()) {
        return { ok: false, code: "store-cap", error: `candidate store full (${STORE_CAP()}) — the owner must review or reject pending amendments first` };
      }
      const dayAgo = new Date(Date.now() - DEBOUNCE_HOURS() * 3600 * 1000).toISOString();
      const dupe = D().prepare(
        `SELECT id, created_at FROM persona_candidates WHERE target_kind = ? AND target_ref = ? AND IFNULL(agent_id,'') = IFNULL(?, '') AND created_at >= ?`,
      ).get(String(targetKind), String(targetRef), agentId ?? null, dayAgo);
      if (dupe) {
        return { ok: false, code: "debounce", error: `this persona was amended within ${DEBOUNCE_HOURS()}h (id ${dupe.id}) — same-target re-proposals are debounced` };
      }
      return { ok: true };
    },

    createCandidate({ targetKind, targetRef, agentId, amendedPersona, evidence, proposedBy, sourceDocId }) {
      const current = currentPersonaFor({ targetKind, targetRef, agentId });
      if (current.error) return { error: current.error };
      const findings = personaSanityFindings(amendedPersona);
      if (findings.length) {
        return { error: `amendment text failed the sanity scan (${findings.join(", ")}) — credential/endpoint literals are document-forbidden` };
      }
      const id = `pc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      D().prepare(
        `INSERT INTO persona_candidates (id, target_kind, target_ref, agent_id, current_persona, amended_persona, evidence, status, proposed_by, created_at, source_doc_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'candidate', ?, ?, ?)`,
      ).run(
        id, String(targetKind), String(targetRef), agentId ?? null,
        current.persona ?? "", String(amendedPersona), JSON.stringify(evidence ?? {}), proposedBy ?? "agent", dbModule.nowIso(),
        typeof sourceDocId === "string" && sourceDocId.trim() ? sourceDocId.trim() : null,
      );
      return { candidate: deserialize(D().prepare(`SELECT ${ROW} FROM persona_candidates WHERE id = ?`).get(id)) };
    },

    // ── read faces ────────────────────────────────────────────────────────────
    listCandidates(status = null) {
      const rows = status
        ? D().prepare(`SELECT ${ROW} FROM persona_candidates WHERE status = ? ORDER BY created_at DESC`).all(status)
        : D().prepare(`SELECT ${ROW} FROM persona_candidates ORDER BY created_at DESC`).all();
      return rows.map(deserialize);
    },
    getCandidate(id) {
      return deserialize(D().prepare(`SELECT ${ROW} FROM persona_candidates WHERE id = ?`).get(id));
    },

    // ── evaluation ────────────────────────────────────────────────────────────
    saveEvalReport(id, report) {
      D().prepare(`UPDATE persona_candidates SET eval_report = ? WHERE id = ?`).run(JSON.stringify(report), id);
    },
    markEvaluated(id) {
      D().prepare(`UPDATE persona_candidates SET status = 'evaluated' WHERE id = ? AND status = 'candidate'`).run(id);
    },
    markUnevaluated(id, reason) {
      D().prepare(`UPDATE persona_candidates SET status = 'candidate', eval_report = ? WHERE id = ?`)
        .run(JSON.stringify({ error: "evaluation failed", reason }), id);
    },

    // ── decisions (human-only; the routes gate identity) ──────────────────────
    // Promotion SPLITS by target (design D3). The caller performs the
    // target-specific write (preset CRUD / fork draft) — this method only
    // owns the double-key guard, the lineage stamp and the terminal state.
    markPromoted(id, { by, outcome }) {
      const cand = this.getCandidate(id);
      if (!cand) return { error: "not found" };
      if (cand.status !== "evaluated") return { error: `candidate is '${cand.status}' — promote requires a green evaluation` };
      D().prepare(`UPDATE persona_candidates SET status = 'promoted', decided_at = ?, decided_by = ?, lineage = ? WHERE id = ?`)
        .run(dbModule.nowIso(), by, JSON.stringify({ ...outcome, at: dbModule.nowIso() }), id);
      return { ok: true, outcome };
    },
    reject(id, { by, reason }) {
      const cand = this.getCandidate(id);
      if (!cand) return { error: "not found" };
      if (cand.status === "promoted") return { error: "already promoted" };
      D().prepare(`UPDATE persona_candidates SET status = 'rejected', decided_at = ?, decided_by = ? WHERE id = ?`).run(dbModule.nowIso(), by, id);
      return { ok: true, rejected: cand.target_ref, reason: reason ?? null };
    },
  };
}
