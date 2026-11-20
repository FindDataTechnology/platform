// Blueprint trial executor (add-blueprint-studio task 4.1, design D8).
//
// 「装一台跑一轮」= 既有链的编排，不新增第二调度器/第二写路径：
//   市场读面 → installPack（既有装作链）→ provisionFleetFromTemplate（既有装台器，
//   dedup 同 pack+owner 复用）→ 起点火（同 POST /:id/start 的写面语义）→
//   cron.runJobNow 逐作业点火一轮（既有调度器，非新调度）→ 报数/决策收证 →
//   断言闭集判绿 → trial_report_json 落账（既有存储位）。
//
// deps 全注入：测试用假宇宙（零真市场/零真任务），生产走 createLiveTrialDeps()，
// 其装配与 routes/fleets.js 的 from-template 路由逐字同源。
// 断言闭集（D8-5）：post-materialized / first-round-fired / report-landed /
// escalate-bounded；未知 kind 判不绿并如实报（4.2 的结构性闸由此而来）。

import * as cron from "../cron.js";
import * as catalog from "../catalog.js";
import { rosterPresetId } from "../dsh-profile.js";
import { installPack } from "../pack-store.js";
import { fetchMarketManifest } from "./pack-manifest-source.js";
import { provisionFleetFromTemplate } from "./fleet-provisioner.js";
import { reconcileFleet } from "./fleet-reconcile.js";
import { getFleetDatabase } from "./routes/fleets-db.js";
import { getClusterDatabase } from "./routes/clusters-db.js";
import { resolveFleetTarget } from "./routes/fleets.js";
import { normalizeAcceptance } from "./blueprint-validate.js";
import { judgeAssertion, laneForModel } from "./blueprint-judge.js";
import { getDefault } from "../llm-providers.js";

function membersFor(assertion, members) {
  if (!assertion.target) return members;
  return members.filter((m) => m.title === assertion.target);
}

// 逐断言判绿并附证据三元组（turnIds / reportIds / sourceRefs）。
export function evaluateTrial({ assertions, evidence, since }) {
  return assertions.map((a) => {
    const members = membersFor(a, evidence.members ?? []);
    const memberIds = new Set(members.map((m) => m.memberId));
    const evidenceOut = { turnIds: [], reportIds: [], sourceRefs: [] };
    const inWindow = (at) => typeof at === "number" && at >= since;

    if (a.kind === "post-materialized") {
      const unstaffed = members.filter((m) => !m.targetId);
      const pass = members.length > 0 && unstaffed.length === 0;
      return {
        id: a.id,
        kind: a.kind,
        pass,
        detail: pass
          ? `${members.length} post(s) staffed`
          : members.length === 0
            ? `no post matches '${a.target ?? "(any)"}'`
            : `unstaffed post(s): ${unstaffed.map((m) => m.title).join(", ")}`,
        evidence: evidenceOut,
      };
    }

    if (a.kind === "first-round-fired") {
      const fired = (evidence.turns ?? []).filter((t) => memberIds.has(t.memberId) && inWindow(t.at));
      evidenceOut.turnIds = fired.map((t) => t.turnId).filter(Boolean);
      evidenceOut.sourceRefs = fired.map((t) => `turn:${t.jobId ?? t.memberId}`);
      const pass = fired.length > 0;
      return {
        id: a.id,
        kind: a.kind,
        pass,
        detail: pass ? `first round fired for ${fired.length} post(s)` : `no round fired within the trial window for '${a.target ?? "(any)"}'`,
        evidence: evidenceOut,
      };
    }

    if (a.kind === "report-landed") {
      const landed = (evidence.reports ?? []).filter((r) => memberIds.has(r.memberId) && inWindow(r.createdAt));
      evidenceOut.reportIds = landed.map((r) => r.reportId).filter(Boolean);
      evidenceOut.turnIds = landed.map((r) => r.turnId).filter(Boolean);
      const pass = landed.length > 0;
      return {
        id: a.id,
        kind: a.kind,
        pass,
        detail: pass ? `${landed.length} report(s) landed` : `no report landed within the trial window for '${a.target ?? "(any)"}'`,
        evidence: evidenceOut,
      };
    }

    if (a.kind === "escalate-bounded") {
      const bound = Number.isFinite(a.expect) ? a.expect : 0;
      const count = Number(evidence.escalations ?? 0);
      const pass = count <= bound;
      return {
        id: a.id,
        kind: a.kind,
        pass,
        detail: `${count} open escalation(s), bound ${bound}`,
        evidence: evidenceOut,
      };
    }

    // 未知 kind（normalize 已报错；这里兜底判不绿，绝不静默通过）。
    return { id: a.id, kind: a.kind, pass: false, detail: `unsupported assertion kind '${a.kind}'`, evidence: evidenceOut };
  });
}

// 一条断言可见的证据文本（design D3：只喂已收证据，不含蓝图自述）。
export function evidenceTextFor(assertion, evidence) {
  const members = membersFor(assertion, evidence.members ?? []);
  const ids = new Set(members.map((m) => m.memberId));
  const lines = [];
  // 集群身份（2026-10-29 生产首次真跑逮住）：判据常写「在试跑集群中均已落位」
  // 这类带载体的口径，而证据原先把「岗位已落位」当成自足事实——模型如实答
  // insufficient-evidence（证据没说这是哪个集群），于是一条本应判绿的断言永远
  // 判不绿。集群名与 id 是运行事实（源自装台结果，非蓝图自述），必须进证据。
  if (evidence.fleetName || evidence.fleetId) {
    lines.push(`试跑集群：${evidence.fleetName || "(未命名)"}（${evidence.fleetId ?? "-"}）`);
  }
  if (members.length) {
    lines.push(`岗位：${members.map((m) => `${m.title}(${m.targetId ? "已落位" : "空缺"})`).join("、")}`);
  }
  const turns = (evidence.turns ?? []).filter((t) => ids.size === 0 || ids.has(t.memberId));
  if (turns.length) lines.push(`回合：${turns.length} 个（${turns.slice(0, 5).map((t) => t.jobId ?? t.memberId).join(", ")}）`);
  const reports = (evidence.reports ?? []).filter((r) => ids.size === 0 || ids.has(r.memberId));
  for (const r of reports.slice(0, 5)) {
    lines.push(`报数 ${r.reportId ?? ""}（${new Date(r.createdAt ?? 0).toISOString()}）：${String(r.summary ?? r.metrics ?? "").slice(0, 600)}`);
  }
  if (Number.isFinite(evidence.escalations)) lines.push(`未决升级项：${evidence.escalations} 件`);
  return lines.join("\n");
}

// 判定阶段（design D8）：只判 llm-judged 条目；deps.judge 可注入（测试零真模型）。
async function judgeAll({ assertions, evidence, fleetId, deps, contentJudgeModel = null, ownerEmail = null }) {
  const targets = assertions.filter((a) => a.kind === "llm-judged");
  if (!targets.length) return [];
  const productionLanes = await (deps.productionLanes ? deps.productionLanes(fleetId) : Promise.resolve([]));
  const out = [];
  for (const a of targets) {
    const judged = await deps.judge({
      assertionId: a.id,
      rubric: a.rubric,
      evidenceText: evidenceTextFor(a, evidence),
      productionLanes,
      judgeModel: contentJudgeModel,
      // 判据日配额的计量主体（优化②）。
      ownerEmail,
    });
    out.push({
      id: a.id,
      kind: "llm-judged",
      pass: judged.verdict === "pass",
      verdict: judged.verdict,
      detail: `${judged.verdict} — ${judged.reason || ""}`.trim(),
      evidence: { turnIds: [], reportIds: [], sourceRefs: [] },
      audit: judged.audit,
    });
  }
  return out;
}

// 主流程：装台→点火→跑一轮→收证→判绿。任何装配失败如实进 errors，不抛。
// Adaptive trial window (add-trial-window-adaptive): the cell's execution
// main chain is a fleet-shared SERIAL queue — on a busy cell the queue delay
// (~16 min measured on the walkthrough cell) exceeds the fixed 10-min window,
// so a fired round that is still queued/running never got its CHANCE to run
// and timing out red is a misjudgment. While the fired round is in flight the
// deadline extends by one poll step, bounded by an absolute ceiling of 2× the
// base window (a stuck task must not hang the trial forever). Pure function —
// unit-pinned; the production collectAndWait inlines it.
export function nextTrialDeadline({ deadline, hardCap, inflight, pollMs }) {
  if (!inflight) return deadline;
  if (deadline + pollMs > hardCap) return deadline;
  return Math.min(deadline + pollMs, hardCap);
}

export async function runTrial({ blueprint, deps, timeoutMs = 10 * 60_000, pollMs = 15_000 } = {}) {
  const now = deps.now ?? Date.now;
  const report = {
    ranAt: now(),
    fleetId: null,
    deduped: false,
    assertions: [],
    green: false,
    errors: [],
  };
  const view = { ownerEmail: blueprint.ownerEmail, content: blueprint.content ?? {} };

  if (!blueprint.castPackId) {
    report.errors.push("blueprint has no cast pack — cast before running a trial");
    return report;
  }
  const normalized = normalizeAcceptance(view.content.acceptance);
  report.acceptanceErrors = normalized.errors;
  if (normalized.assertions.length === 0) {
    // 无断言清单 = 无可验收之实，不得判绿（结构性地拒绝「空报告即可售」）。
    report.errors.push("blueprint declares no acceptance assertions — a trial needs at least one");
    return report;
  }

  try {
    // 装一台：市场读面 → 装作链 → 装台器（dedup 同 pack+owner）。
    const manifest = await deps.fetchManifest({ packId: blueprint.castPackId, version: blueprint.castPackVersion, viewer: blueprint.ownerEmail });
    await deps.install({ packId: blueprint.castPackId, version: blueprint.castPackVersion, manifest, ownerEmail: blueprint.ownerEmail });
    const provisioned = await deps.provision({ packId: blueprint.castPackId, version: blueprint.castPackVersion, manifest, ownerEmail: blueprint.ownerEmail });
    if (!provisioned?.ok) {
      report.errors.push(provisioned?.error ?? "provision failed");
      return report;
    }
    report.fleetId = provisioned.fleetId;
    report.deduped = Boolean(provisioned.deduped);

    // 起点火：同一写面语义（state active + cadence 启用 + reconcile）。
    await deps.startFleet(provisioned.fleetId);

    // 跑一轮：既有 cron 作业逐个点火一次。
    const since = now();
    report.fired = await deps.fireRound(provisioned.fleetId);

    // 收证：窗口内轮询直到可判或超时（超时者按无证判不绿并如实标）。
    const evidence = await deps.collectAndWait({ fleetId: provisioned.fleetId, since, assertions: normalized.assertions, timeoutMs, pollMs, fired: report.fired });
    const machine = normalized.assertions.filter((a) => a.kind !== "llm-judged");
    const machineJudged = evaluateTrial({ assertions: machine, evidence, since });
    // 判定阶段（design D8）：机器判绿之后、落报告之前。
    const judged = deps.judge
      ? await judgeAll({ assertions: normalized.assertions, evidence, fleetId: provisioned.fleetId, deps, contentJudgeModel: view.content?.judgeModel ?? null, ownerEmail: blueprint.ownerEmail ?? null })
      : [];
    report.assertions = [...machineJudged, ...judged];
    report.judged = judged;
    if (judged.length) report.judgeModelUsed = judged[0]?.audit?.model ?? null;
    report.green = report.assertions.length > 0 && report.assertions.every((a) => a.pass);
    report.evidenceWindow = { since, until: now() };
  } catch (err) {
    report.errors.push(`trial aborted: ${err?.message || err}`);
  }
  return report;
}

// D8 约定：试跑舰命名 `${场景}·试跑`，与正式装作可区分。首铸建舰改名一次，
// dedup 复用既有舰不重复改名（后缀已在则不动）；舰不存在时静默跳过。
export function ensureTrialFleetName(db, fleetId) {
  const fleet = db.getFleet(fleetId);
  if (!fleet || String(fleet.name).endsWith("·试跑")) return;
  db.updateFleet(fleetId, { name: `${fleet.name}·试跑` }, { actor: "blueprint-trial", via: "POST /api/blueprints/:id/trial" });
}

// ── 生产装配（与 routes/fleets.js from-template 路由逐字同源） ──────────────


// ── Bounded fire (fix-trial-fire-timeout) ────────────────────────────────────
// The trial handler holds an in-process lock for the whole run; fireRound used
// to await cron.runJobNow unbounded — a round queued behind a busy shared DSH
// child can park 20+ minutes, starving every later trial with 409s and
// outliving the trial's own evidence window. Each fire now races a timeout
// window (default 90s, BLUEPRINT_FIRE_TIMEOUT_MS overrides); a timed-out fire
// lands in `fired` with its error (the existing `!f.error` turn filter reads
// it honestly), and the trial keeps collecting evidence.
export const FIRE_TIMEOUT_DEFAULT_MS = 90_000;

export function fireTimeoutMs(env = process.env) {
  const raw = Number(env.BLUEPRINT_FIRE_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : FIRE_TIMEOUT_DEFAULT_MS;
}

export async function fireJobBounded(cronApi, job, timeoutMs = fireTimeoutMs(), { now = Date.now } = {}) {
  try {
    await Promise.race([
      Promise.resolve(cronApi.runJobNow(job.id)),
      new Promise((_, reject) =>
        setTimeout(() => reject(Object.assign(new Error("fire timeout"), { code: "fire-timeout" })), timeoutMs),
      ),
    ]);
    return { jobId: job.id, memberId: job.sourceTag?.memberId ?? null, at: now() };
  } catch (err) {
    return { jobId: job.id, memberId: job.sourceTag?.memberId ?? null, at: now(), error: err?.message || String(err) };
  }
}

export function createLiveTrialDeps() {
  return {
    now: Date.now,
    fetchManifest: ({ packId, version, viewer }) => fetchMarketManifest({ packId, version, viewer }),
    install: async ({ packId, version, manifest, ownerEmail }) => {
      const installed = await installPack({ packId, version, manifest, user: { email: ownerEmail, groups: [] }, source: "market" });
      return installed;
    },
    provision: async ({ packId, version, manifest, ownerEmail }) => {
      const db = getFleetDatabase();
      const out = await provisionFleetFromTemplate({
        packId,
        version,
        manifest,
        ownerEmail,
        deps: {
          db,
          catalogAgentIds: () => new Set(catalog.getChatAgentEntries().map((e) => e.id)),
          resolveExisting: ({ kind, id }) => {
            // persona-only: 蓝图目标类型不含 auditor
            if (kind === "persona") return !!catalog.getChatAgentEntries().some((e) => e.id === id);
            if (kind === "a2a") {
              const entry = catalog.getAgentEntry(id);
              return !!entry && entry.mode === "a2a";
            }
            if (kind === "tool" || kind === "bot") return resolveFleetTarget({ targetKind: kind, targetId: id }).alive;
            const cluster = getClusterDatabase().get(id);
            return !!cluster && cluster.status !== "terminated";
          },
          reconcile: (fleetId) => reconcileFleet({ fleetId, db, cronApi: cron, resolveTarget: resolveFleetTarget, rosterPresetId }),
        },
      });
      if (!out.ok) return out;
      const fleetId = out.fleet?.id ?? out.fleetId;
      ensureTrialFleetName(db, fleetId);
      return { ok: true, fleetId, deduped: out.deduped };
    },
    // 起点火：与 POST /api/fleets/:id/start 的写面一致（state→active、cadence 启用、
    // 再 reconcile 一次让物化作业跟上）。
    startFleet: async (fleetId) => {
      const db = getFleetDatabase();
      const fleet = db.getFleet(fleetId);
      if (!fleet) throw new Error(`trial fleet '${fleetId}' disappeared`);
      if (fleet.state !== "active") db.updateFleet(fleetId, { state: "active" }, { actor: "blueprint-trial", via: "POST /api/blueprints/:id/trial" });
      for (const m of db.listMembers(fleetId)) {
        if (m.cadence && m.cadence.enabled === false) db.updateMember(m.id, { cadence: { ...m.cadence, enabled: true } });
      }
      await reconcileFleet({ fleetId, db, cronApi: cron, resolveTarget: resolveFleetTarget, rosterPresetId });
    },
    // 产出主体（D4 禁自证）：试跑舰各岗位的产出模型。
    // 2026-10-28 生产实证：laneForModel 依赖 providers doc，而 server 进程里
    // 该 doc 可能读不到（Models 页存储缺失）→ 返回 null → 判定整体拒。禁自证
    // 只需要「模型名」这一件事实，岗位行上就有（effectiveModel），不依赖 doc。
    // doc 能解析时补 providerId 以支持"同 provider 换模型"的更精确判断。
    productionLanes: async (fleetId) => {
      const db = getFleetDatabase();
      const fleet = db.getFleet(fleetId);
      const cellDefault = process.env.LLM_MODEL || getDefault()?.modelId || null;
      return db
        .listMembers(fleetId)
        // effectiveModel 是路由层的视图字段，DB 行里没有——按真实解析链算：
        // 岗位 model → 舰队 defaultModel → cell 默认（与 fleet-reports 同序）。
        // cell 默认取自 llm-providers 的 default 指针（生产没有 LLM_MODEL env）。
        .map((m) => m.model || fleet?.defaultModel || cellDefault || getDefault()?.modelId)
        .filter(Boolean)
        .map((modelId) => {
          const resolved = laneForModel(modelId);
          return resolved ?? { laneId: null, providerId: null, model: modelId };
        });
    },
    // 判定（D1-D6）：生产实现走既有 LLM 车道，不新造 provider 通道。
    judge: (args) => judgeAssertion(args),
    fireRound: async (fleetId) => {
      const jobs = cron.listJobs().filter((j) => j?.sourceTag?.fleetId === fleetId);
      const fired = [];
      for (const job of jobs) {
        // fix-trial-fire-timeout: bounded per job — a hung fire must not hold
        // the trial lock past the evidence window.
        fired.push(await fireJobBounded(cron, job));
      }
      return fired;
    },
    collectAndWait: async ({ fleetId, since, assertions, timeoutMs, pollMs, fired = [] }) => {
      const db = getFleetDatabase();
      const collect = () => {
        const members = db.listMembers(fleetId);
        const fleetRow = db.getFleet(fleetId);
        const reports = [];
        for (const m of members) {
          for (const r of db.listReports(m.id, { limit: 20 })) {
            if ((r.createdAt ?? 0) >= since) {
              reports.push({ memberId: m.id, reportId: r.id, createdAt: r.createdAt, turnId: r.sessionId ?? null, summary: r.summary ?? null });
            }
          }
        }
        // 回合证据 = fireRound 的点火记录（作业触发即算首轮已发；turnId 待 trace
        // tap 补齐）。2026-10-28 生产走查逮住：此前这里恒返回空 turns，
        // first-round-fired 断言永远判不绿——点火事实必须进收证。
        return {
          // 集群身份进证据（判据常带「在试跑集群中」这类载体口径）。
          fleetId,
          fleetName: fleetRow?.name ?? null,
          members: members.map((m) => ({ memberId: m.id, title: m.title, targetId: m.targetId })),
          turns: fired.filter((f) => !f.error).map((f) => ({ memberId: f.memberId, at: f.at, jobId: f.jobId, turnId: null })),
          reports,
          escalations: db.countOpenDecisions(fleetId) ?? 0,
        };
      };
      const startedAt = Date.now();
      let deadline = startedAt + timeoutMs;
      const hardCap = startedAt + timeoutMs * 2; // 绝对封顶（add-trial-window-adaptive）
      let extendedMs = 0;
      let evidence = collect();
      // 等待条件：所有 report-landed 目标都已有报告（其余断言不依赖等待）。
      const needsReports = (ev) => {
        const targets = assertions.filter((a) => a.kind === "report-landed");
        if (!targets.length) return true;
        return targets.every((a) => {
          const ids = new Set(membersFor(a, ev.members).map((m) => m.memberId));
          return (ev.reports ?? []).some((r) => ids.has(r.memberId));
        });
      };
      // 在途判定：被点火岗位的回合任务仍在 queued/running（串行链排队/执行中）。
      const roundInFlight = () =>
        cron.listJobs().some((j) => j?.sourceTag?.fleetId === fleetId && (j.state === "queued" || j.state === "running"));
      while (!needsReports(evidence) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, pollMs));
        evidence = collect();
        const nd = nextTrialDeadline({ deadline, hardCap, inflight: roundInFlight(), pollMs });
        if (nd > deadline) {
          extendedMs += nd - deadline;
          deadline = nd;
        }
      }
      if (extendedMs > 0) evidence.windowExtendedMs = extendedMs;
      return evidence;
    },
  };
}