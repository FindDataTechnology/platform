// ── Owner inbox: the cross-lane read face (openspec: owner-inbox) ───────────
//
// One request answers "what is waiting on me today?" across every lane that
// parks work for a human: fleet decisions, iteration cast chains, input
// requests, skill candidates, persona candidates, team call approvals.
//
// Two hard rules, both from the spec:
//
//   1. READ-ONLY. Every lane's `read` is an existing read path called verbatim.
//      The inbox never writes, never runs a turn, and never becomes a second
//      source of truth. Actions are DATA — each one names the lane's own
//      existing endpoint — so no lane's semantics are reimplemented here.
//
//   2. HONEST DEGRADATION. A lane that throws degrades to `status: "error"`
//      with its reason; the rest still render. A lane counted as 0 when it
//      could not be read would be the one lie this surface must never tell.
//
// The consequence text is derived HERE, server-side, from the same detail
// fields the approval callbacks read — never from anything the agent claimed.
// An unknown item type says so; it never borrows a generic sentence.

import * as dbModule from "../db.js";
import * as engine from "../task-engine.js";
import { getFleetDatabase } from "./routes/fleets-db.js";
import { listPendingForOwner } from "./input-requests.js";
import { skillEvolutionStore } from "./skill-evolution.js";
import { personaEvolutionStore } from "./persona-evolution.js";
import { listPendingApprovals, ensureTeamApprovalsTable } from "./team-approvals.js";
import { listPublications, cellIdFor, ensureTeamCardsTable } from "./team-card.js";

// Lanes are declared as data so the read/classify/consequence trio for each one
// sits together and a new lane cannot be half-added.
export const LANE_IDS = Object.freeze([
  "fleet-decision",
  "fleet-iteration",
  "input-request",
  "skill-candidate",
  "persona-candidate",
  "team-approval",
  "flow-acceptance",
]);

const BUCKETS = Object.freeze({ WAITING: "waiting", INFLIGHT: "inflight", CONTEXT: "context" });

// ── consequence text ────────────────────────────────────────────────────────
//
// Field bindings below are deliberate: each sentence names the SAME detail
// fields the approval callback in routes/fleets.js reads (carrier-change reads
// detail.changes.memberId/.carrier; config-change reads the iteration row's
// decisionId; a plain decision rides the member's delivery lane). If a callback
// starts reading something else, the text must be changed with it.

function clip(text, n = 160) {
  const s = String(text ?? "");
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/**
 * A grade a reader can act on, in three words (agent-decided-learning-loop D4).
 * The stored value is five-way; a person scanning a list needs to know only
 * whether it was theirs, an independently-checked agent's, or self-certified.
 * Never invents a fourth bucket — an unknown grade reads `unknown`, not `self`.
 */
export function gradeKind(grade) {
  switch (grade) {
    case "owner-authored":
    case "owner-approved":
      return "owner";
    case "agent-independent":
      return "agent-verified";
    case "agent-independent-unverified":
      return "agent-unverified";
    case "agent-self":
    case "deputy-ruled":
      return "agent-self";
    default:
      return "unknown";
  }
}

export function consequenceFor({ itemType, detail, memberTitle, memberTargetKind, memberDeleted, options, resolution }) {
  switch (itemType) {
    case "config-change": {
      const summary = detail?.changes ? Object.keys(detail.changes).join(", ") : null;
      return {
        approvedEffect: `批准后：现役集群导出为模板 → 铸成下一版 → 上架市场；订阅该模板的集群只收到「新版可用」提示，不会被自动迁移。${summary ? `改动键：${summary}。` : ""}`,
        boundFields: ["detail.changes", "detail.settlement"],
      };
    }
    case "carrier-change": {
      const changes = detail?.changes ?? {};
      const memberId = changes.memberId ?? null;
      const carrier = changes.carrier ?? null;
      return {
        approvedEffect: `批准后：岗位${memberId ? `(${clip(memberId, 40)})` : ""} 的执行承载改为 ${carrier ?? "auto（按解析链）"}；承载解析与 fail-open 语义不变。`,
        boundFields: ["detail.changes.memberId", "detail.changes.carrier"],
      };
    }
    case "decision":
    default: {
      if (itemType && itemType !== "decision") {
        return {
          approvedEffect: `未知条目类型（${clip(itemType, 40)}）——批准行为未定义，请先确认该类型由哪条车道消费。`,
          boundFields: [],
          unknownType: true,
        };
      }
      if (memberDeleted) {
        return {
          approvedEffect: "批准后：来源岗位已不存在，裁定停留在「待岗位恢复」，补岗后由下一次回合送达。",
          boundFields: ["memberId"],
        };
      }
      const chosen = resolution?.choice ?? null;
      const optionLabel = chosen ? (options ?? []).find((o) => o.value === chosen)?.label ?? chosen : null;
      if (memberTargetKind === "passive") {
        return {
          approvedEffect: "批准后：该岗位无节奏任务也无手动车道，裁定停留待送达，将由它下一次被委派的回合带走。",
          boundFields: ["targetKind"],
        };
      }
      return {
        approvedEffect: `批准后：裁定${optionLabel ? `（${clip(optionLabel, 40)}）` : ""}随岗位${memberTitle ? `「${clip(memberTitle, 40)}」` : ""}的下一次回合送达${memberTargetKind === "persona" ? "（无节奏任务时立即为它发起一个回合）" : ""}。`,
        boundFields: ["memberId", "targetKind", "resolution"],
      };
    }
  }
}

export function consequenceForInputRequest(request) {
  const policy = request?.policy ?? {};
  const onUnattended = policy?.onUnattended ?? "wait";
  const deadline = request?.expiresAt ?? null;
  const when = deadline ? new Date(deadline).toLocaleString() : null;
  const meaning = {
    wait: "一直等到有人作答或调用方取消",
    default: "按卡片声明的默认值收尾",
    abort: "以「未获输入」终止该请求",
    escalate: "升级进拍板队列",
  }[onUnattended] ?? `按策略 ${onUnattended} 收尾`;
  return {
    approvedEffect: `不答的后果：${when ? `${when} 到期后` : "到期后"}${meaning}。`,
    boundFields: ["policy.onUnattended", "expiresAt"],
  };
}

export function consequenceForCandidate(kind, candidate) {
  if (kind === "skill") {
    return {
      approvedEffect: `接受后：写入 custom_skills 并热载，下一回合起工具面即可用${candidate?.supersedes ? `（并给旧技能 ${clip(candidate.supersedes, 40)} 记 lineage）` : ""}。需先有通过的评测。`,
      boundFields: ["status", "supersedes"],
    };
  }
  if (candidate?.target_kind === "pack") {
    return {
      approvedEffect: "接受后：经既有 fork 管线开出草稿（携修订人格），pack 本体与已装实例零变化。需先有通过的评测。",
      boundFields: ["target_kind"],
    };
  }
  return {
    approvedEffect: "接受后：该自建预设的人格按既有 CRUD 物化，旧文本留 lineage；进行中会话的人格不变，新会话读到修订文本。需先有通过的评测。",
    boundFields: ["target_kind"],
  };
}

export function consequenceForTeamApproval(handle) {
  return {
    approvedEffect: `批准后：该调用方获得团队「${clip(handle, 40)}」的调用许可（一次性或限时），可再次呼入。`,
    boundFields: ["handle", "caller"],
  };
}

// ── lane readers ────────────────────────────────────────────────────────────
//
// Each returns a flat list of normalized items. Anything a lane cannot read
// throws, and the builder turns that into a per-lane error — never a zero.

function fleetItem({ fleet, item, member, bucket, memberDeleted }) {
  const consequence = consequenceFor({
    itemType: item.itemType,
    detail: item.detail,
    memberTitle: item.memberTitle,
    memberTargetKind: member?.targetKind,
    memberDeleted,
    options: item.options,
    resolution: item.resolution,
  });
  const actions = [];
  if (bucket === BUCKETS.WAITING) {
    actions.push(
      { op: "approve", label: "批准所选", endpoint: `/api/fleets/${encodeURIComponent(fleet.id)}/decisions/${encodeURIComponent(item.id)}/approve`, method: "POST", bodyShape: { choice: "string", note: "string?" }, safe: false },
      { op: "reject", label: "驳回", endpoint: `/api/fleets/${encodeURIComponent(fleet.id)}/decisions/${encodeURIComponent(item.id)}/reject`, method: "POST", bodyShape: { note: "string?" }, safe: false },
      { op: "amend", label: "改批", endpoint: `/api/fleets/${encodeURIComponent(fleet.id)}/decisions/${encodeURIComponent(item.id)}/amend`, method: "POST", bodyShape: { choice: "string", note: "string?" }, safe: false },
    );
  } else if (bucket === BUCKETS.CONTEXT && item.state === "expired") {
    actions.push({ op: "reopen", label: "重开", endpoint: `/api/fleets/${encodeURIComponent(fleet.id)}/decisions/${encodeURIComponent(item.id)}/reopen`, method: "POST", bodyShape: {}, safe: true });
  } else if (bucket === BUCKETS.INFLIGHT && item.state === "approved" && !memberDeleted) {
    actions.push({ op: "execute-now", label: "立即执行", endpoint: `/api/fleets/${encodeURIComponent(fleet.id)}/decisions/${encodeURIComponent(item.id)}/execute-now`, method: "POST", bodyShape: {}, safe: false });
  }
  return {
    laneId: "fleet-decision",
    itemRef: item.id,
    subjectKind: "fleet-decision",
    originLabel: `${fleet.name}${item.memberTitle ? ` · ${item.memberTitle}` : ""}`,
    originRefs: { fleetId: fleet.id, memberId: item.memberId },
    title: item.question,
    severity: item.severity,
    itemType: item.itemType ?? "decision",
    state: item.state,
    bucket,
    submittedAt: item.submittedAt ?? null,
    consequence: consequence.approvedEffect,
    evidence: item.detail ? { detail: item.detail } : null,
    // 签名链 (agent-decided-learning-loop 4.4)。已决条目上可读成一段：谁提的、
    // 谁判的、用什么模型、谁验的、独立性结论。这不是「待批」信息，是**事后
    // 审计**信息——人退到观察位之后，这是他唯一还能回答「当时凭什么成立」的材料。
    // 只读投影：字段原样来自 detail.chain，不做任何再加工。
    chain: item.detail?.chain ?? null,
    precedentGrade: item.precedentGrade ?? null,
    precedentGradeKind: gradeKind(item.precedentGradeNormalized ?? item.precedentGrade ?? null),
    options: item.options ?? [],
    recommendation: item.recommendation ?? null,
    actions,
  };
}

function readFleetDecisions(user) {
  const db = getFleetDatabase();
  const out = [];
  for (const fleet of db.listFleets({ ownerEmail: user.email })) {
    // NOTE: no expireOpenDecisions() here — the inbox is a READ face and the
    // spec forbids it writing. Expiry is derived from the fleet's policy
    // instead, so an overdue-but-un-swept row still counts as expired rather
    // than as something waiting on the owner.
    const expiryHours = fleet.decisionPolicy?.expiryHours ?? 72;
    const cutoff = expiryHours > 0 ? Date.now() - expiryHours * 3600_000 : null;
    const effectiveState = (item) =>
      item.state === "open" && cutoff != null && (item.submittedAt ?? 0) < cutoff ? "expired" : item.state;
    const members = new Map(db.listMembers(fleet.id).map((m) => [m.id, m]));
    // Owner-routed only. Deputy and triage lanes belong to the deputy's own
    // queue view (agent-fleet-decision-delegate: 角标只计需要主人的事项).
    const rows = db
      .listDecisions({ fleetId: fleet.id })
      .filter((d) => (d.route ?? "owner") === "owner");
    for (const item of rows) {
      const state = effectiveState(item);
      const member = members.get(item.memberId) ?? null;
      const memberDeleted = !member;
      let bucket;
      if (state === "open") bucket = BUCKETS.WAITING;
      else if (state === "approved" || state === "rejected") {
        bucket = item.deliveredAt == null ? BUCKETS.INFLIGHT : BUCKETS.CONTEXT;
      } else bucket = BUCKETS.CONTEXT; // expired / delivered
      out.push(
        fleetItem({
          fleet,
          item: { ...item, state, memberTitle: member?.title ?? null },
          member,
          bucket,
          memberDeleted,
        }),
      );
    }
  }
  return out;
}

function readFleetIterations(user) {
  const db = getFleetDatabase();
  const out = [];
  for (const fleet of db.listFleets({ ownerEmail: user.email })) {
    for (const it of db.listIterations(fleet.id, { limit: 20 }) ?? []) {
      const failed = it.state === "failed";
      if (!failed) continue; // the cast chain only needs a human when it broke
      out.push({
        laneId: "fleet-iteration",
        itemRef: it.id,
        subjectKind: "fleet-iteration",
        originLabel: fleet.name,
        originRefs: { fleetId: fleet.id },
        title: `铸版链失败${it.axis ? `（${it.axis}）` : ""}`,
        severity: "high",
        itemType: "iteration-chain",
        state: it.state,
        bucket: BUCKETS.INFLIGHT,
        submittedAt: it.createdAt ?? null,
        consequence: `重试后：重新走铸版与发版链，市场不会产生半成品版本。${it.note ? `失败原因：${clip(it.note, 200)}` : ""}`,
        evidence: it.note ? { note: it.note } : null,
        actions: [
          { op: "retry", label: "重试", endpoint: `/api/fleets/${encodeURIComponent(fleet.id)}/iterations/${encodeURIComponent(it.id)}/retry`, method: "POST", bodyShape: {}, safe: false },
        ],
      });
    }
  }
  return out;
}

function readInputRequests(user) {
  const db = dbModule.getDb();
  return listPendingForOwner(db, user.email, { limit: 50 }).map((r) => {
    const c = consequenceForInputRequest(r);
    return {
      laneId: "input-request",
      itemRef: r.id,
      subjectKind: "input-request",
      originLabel: r.card?.title ? clip(r.card.title, 60) : "待填表",
      originRefs: { requestId: r.id, sessionId: r.sessionId ?? null },
      title: r.card?.title ?? "有一张待填的表",
      severity: "normal",
      itemType: "input-request",
      state: r.state,
      bucket: BUCKETS.WAITING,
      submittedAt: r.createdAt ?? null,
      consequence: c.approvedEffect,
      evidence: { card: r.card, policy: r.policy, expiresAt: r.expiresAt ?? null },
      actions: [
        { op: "answer", label: "去填写", endpoint: `/api/input-requests/${encodeURIComponent(r.id)}/answer`, method: "POST", bodyShape: { values: "object" }, safe: false },
      ],
    };
  });
}

function readSkillCandidates() {
  return skillEvolutionStore()
    .listCandidates()
    .filter((c) => c.status === "candidate" || c.status === "evaluated")
    .map((c) => {
      const verdict = c.evalReport?.passed === true;
      const unevaluated = !c.evalReport || c.evalReport?.error != null;
      return {
        laneId: "skill-candidate",
        itemRef: c.id,
        subjectKind: "skill-candidate",
        originLabel: "技能候选",
        originRefs: { candidateId: c.id },
        title: c.name,
        severity: c.status === "evaluated" ? "normal" : "low",
        itemType: "skill-candidate",
        state: c.status,
        bucket: BUCKETS.WAITING,
        submittedAt: c.created_at ? Date.parse(c.created_at) || null : null,
        consequence: consequenceForCandidate("skill", c).approvedEffect,
        evaluation: {
          status: c.status === "evaluated" && verdict ? "passed" : unevaluated ? "unevaluated" : "failed",
          reason: c.evalReport?.reason ?? c.evalReport?.error ?? null,
        },
        evidence: { description: c.description, evidence: c.evidence, evalReport: c.evalReport ?? null },
        actions: [
          ...(c.status === "evaluated"
            ? [{ op: "accept", label: "接受热载", endpoint: `/api/skill-evolution/candidates/${encodeURIComponent(c.id)}/promote`, method: "POST", bodyShape: {}, safe: false }]
            : []),
          { op: "evaluate", label: "重跑评测", endpoint: `/api/skill-evolution/candidates/${encodeURIComponent(c.id)}/evaluate`, method: "POST", bodyShape: {}, safe: true },
          { op: "reject", label: "驳回", endpoint: `/api/skill-evolution/candidates/${encodeURIComponent(c.id)}/reject`, method: "POST", bodyShape: { reason: "string?" }, safe: false },
        ],
      };
    });
}

function readPersonaCandidates() {
  return personaEvolutionStore()
    .listCandidates()
    .filter((c) => c.status === "candidate" || c.status === "evaluated")
    .map((c) => {
      const verdict = c.evalReport?.passed === true;
      const unevaluated = !c.evalReport || c.evalReport?.error != null;
      return {
        laneId: "persona-candidate",
        itemRef: c.id,
        subjectKind: "persona-candidate",
        originLabel: "人格修订",
        originRefs: { candidateId: c.id },
        title: `${c.target_ref}${c.agent_id ? ` · ${c.agent_id}` : ""}`,
        severity: c.status === "evaluated" ? "normal" : "low",
        itemType: "persona-candidate",
        state: c.status,
        bucket: BUCKETS.WAITING,
        submittedAt: c.created_at ? Date.parse(c.created_at) || null : null,
        consequence: consequenceForCandidate("persona", c).approvedEffect,
        evaluation: {
          status: c.status === "evaluated" && verdict ? "passed" : unevaluated ? "unevaluated" : "failed",
          reason: c.evalReport?.reason ?? c.evalReport?.error ?? null,
        },
        evidence: { current: c.current_persona, amended: c.amended_persona, evidence: c.evidence, evalReport: c.evalReport ?? null },
        actions: [
          ...(c.status === "evaluated"
            ? [{ op: "accept", label: c.target_kind === "pack" ? "接受并开 fork 草稿" : "接受并物化", endpoint: `/api/persona-evolution/candidates/${encodeURIComponent(c.id)}/promote`, method: "POST", bodyShape: {}, safe: false }]
            : []),
          { op: "evaluate", label: "重跑评测", endpoint: `/api/persona-evolution/candidates/${encodeURIComponent(c.id)}/evaluate`, method: "POST", bodyShape: {}, safe: true },
          { op: "reject", label: "驳回", endpoint: `/api/persona-evolution/candidates/${encodeURIComponent(c.id)}/reject`, method: "POST", bodyShape: { reason: "string?" }, safe: false },
        ],
      };
    });
}

// Team call approvals live per published card handle. There is no cross-handle
// enumerator today, so the lane reads this cell's publications and unions their
// pending rows. Only teams this owner published are considered — a foreign
// handle never enters the list, so it cannot influence the count.
function readTeamApprovals(user) {
  const db = getFleetDatabase();
  const raw = db.db ?? db;
  // A cell that never published a team has no card tables yet. The inbox is a
  // read face, but creating an EMPTY table is not a write of user data — and
  // the alternative (reporting "no such table") would make a fresh deploy look
  // broken. Same idempotent DDL the publish route runs at boot.
  ensureTeamCardsTable(raw);
  ensureTeamApprovalsTable(raw);
  const cellId = cellIdFor(user?.email);
  const handles = listPublications(raw)
    .filter((p) => p.cellId === cellId && (p.publishedBy == null || p.publishedBy === user?.email))
    .map((p) => p.handle);
  const out = [];
  for (const handle of handles) {
    for (const row of listPendingApprovals(raw, { cellId, handle })) {
      out.push({
        laneId: "team-approval",
        itemRef: `${handle}:${row.caller}`,
        subjectKind: "team-approval",
        originLabel: `团队 ${handle}`,
        originRefs: { handle, caller: row.caller },
        title: `${row.caller} 请求调用团队「${handle}」`,
        severity: "normal",
        itemType: "team-approval",
        state: "pending",
        bucket: BUCKETS.WAITING,
        submittedAt: row.requestedAt ?? null,
        consequence: consequenceForTeamApproval(handle).approvedEffect,
        evidence: { handle, caller: row.caller },
        actions: [
          { op: "approve", label: "授予（一次性）", endpoint: `/api/teams/cards/${encodeURIComponent(handle)}/approvals`, method: "POST", bodyShape: { caller: "string", expiresAt: "number|null" }, safe: false },
          { op: "reject", label: "拒绝", endpoint: `/api/teams/cards/${encodeURIComponent(handle)}/approvals/${encodeURIComponent(row.caller)}`, method: "DELETE", bodyShape: {}, safe: false },
        ],
      });
    }
  }
  return out;
}

// ── builder ─────────────────────────────────────────────────────────────────

export function laneTable(user) {
  return {
    "fleet-decision": () => readFleetDecisions(user),
    "fleet-iteration": () => readFleetIterations(user),
    "input-request": () => readInputRequests(user),
    "skill-candidate": () => readSkillCandidates(),
    "persona-candidate": () => readPersonaCandidates(),
    "team-approval": () => readTeamApprovals(user),
    "flow-acceptance": () => readFlowAcceptance(user),
  };
}

const LANE_LABELS = {
  "fleet-decision": "舰队拍板",
  "fleet-iteration": "迭代铸版",
  "input-request": "待填表",
  "skill-candidate": "技能候选",
  "persona-candidate": "人格修订",
  "team-approval": "团队调用授权",
  "flow-acceptance": "待签收",
};

// ── Flow acceptance lane (add-task-flow task 7.1) ───────────────────────────
//
// Cards whose execution ended without a ruling. Read-only, like every lane: the
// action points at the flow route's own accept endpoint, so this file adds no
// second write path into signing off.
//
// The consequence sentence is derived from the SAME fields the accept endpoint
// reads (`flow.acceptance`), so the copy cannot promise a check the callback
// does not run — the owner-inbox spec's rule, applied here.
function readFlowAcceptance(user) {
  const email = user?.email ?? null;
  const out = [];
  for (const task of engine.listTasks()) {
    const flow = task.flow;
    if (!flow || !flow.flowId) continue;
    // Owner-scoped: a card with no owner belongs to nobody and must not leak
    // into whoever happens to open the inbox.
    if ((flow.owner ?? null) !== email) continue;
    if (flow.verdict?.outcome === "pass") continue;
    // Only cards that actually ran: a backlog card is not waiting on a
    // signature, it is waiting on a dispatch, and that is the board's business.
    const settled = task.state === "done";
    if (!settled) continue;

    const criteria = Array.isArray(flow.acceptance) ? flow.acceptance : [];
    const judged = criteria.filter((c) => c.kind === "llm-judged").length;
    const machine = criteria.length - judged;
    const consequence =
      criteria.length === 0
        ? "签收后：卡片进入已完成。该站点未声明验收判据，本次签收以你的名义记录，可被审计。"
        : `签收后：按 ${machine} 条机器判据${judged ? ` + ${judged} 条判据型断言` : ""}求值，全部通过进入已完成。`;

    out.push({
      laneId: "flow-acceptance",
      itemRef: task.id,
      subjectKind: "flow-card",
      originLabel: flow.flowId,
      originRefs: { flowId: flow.flowId, stationId: flow.stationId ?? null },
      title: task.sessionTitle || task.prompt?.slice(0, 80) || task.id,
      severity: criteria.length === 0 ? "normal" : "high",
      itemType: "flow-acceptance",
      state: task.state,
      bucket: BUCKETS.WAITING,
      submittedAt: task.lastRun ?? null,
      consequence,
      // Evidence rides verbatim from the lane's own record — never recomputed
      // here (owner-inbox spec: 读面 MUST NOT 重新计算).
      evidence: { acceptance: criteria, stakedAt: flow.stakedAt ?? null },
      actions: [
        {
          op: "accept",
          label: "签收",
          endpoint: `/api/flows/cards/${encodeURIComponent(task.id)}/accept`,
          method: "POST",
          bodyShape: {},
          safe: false,
        },
      ],
    });
  }
  return out;
}

/**
 * Build the inbox payload for one user.
 *
 * `lanes` narrows which lanes are read (`?lanes=a,b`). A lane that throws
 * yields `{ status: "error", error }` and an empty item list — never a zero
 * that reads as "nothing to do here".
 *
 * Note on timeouts: the reads are synchronous SQLite queries, so a per-lane
 * wall-clock timeout cannot preempt a hung query. We therefore do NOT fake
 * one; we isolate failures by try/catch instead, which is the property that
 * actually matters (one lane cannot take the surface down).
 */
export function buildInbox(user, { lanes = null, table = null } = {}) {
  const wanted = Array.isArray(lanes) && lanes.length
    ? LANE_IDS.filter((id) => lanes.includes(id))
    : [...LANE_IDS];
  const readers = table ?? laneTable(user);
  const out = [];
  const counts = { waiting: 0, inflight: 0 };
  for (const id of wanted) {
    const read = readers[id];
    if (!read) {
      out.push({ id, label: LANE_LABELS[id] ?? id, status: "error", error: `unknown lane '${id}'`, items: [] });
      continue;
    }
    try {
      const items = read() ?? [];
      for (const it of items) {
        if (it.bucket === BUCKETS.WAITING) counts.waiting += 1;
        else if (it.bucket === BUCKETS.INFLIGHT) counts.inflight += 1;
      }
      out.push({ id, label: LANE_LABELS[id] ?? id, status: "ok", items });
    } catch (err) {
      out.push({ id, label: LANE_LABELS[id] ?? id, status: "error", error: String(err?.message || err), items: [] });
    }
  }
  return { v: 1, sampledAt: Date.now(), lanes: out, counts };
}
