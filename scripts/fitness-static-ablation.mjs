#!/usr/bin/env node
// ── 静态消融（establish-agent-role-and-fitness-plane 2.1）──────────────────────
//
// 不用跑就能判的那一半：一个岗值不值得存在，先看它在**声明**里有没有读者与贡献。
//
// 判据（全部来自模板声明，零运行期假设）：
//   R1 no-reader        没有任何边从它出发，也没有任何边指向它
//   R2 no-contribution  没有 KPI 槽（报数为空 ⇒ 它做的数没人收）
//   R3 no-objective     没有目标声明（establish-agent-role-and-fitness-plane 之后
//                       的字段；旧模板一律缺 ⇒ **如实标"未证明"而不是判红**）
//
// 裁决方向：
//   三条都中           → candidate-retire（静态依据）
//   中 R1 或 R2        → candidate-merge
//   都没有             → keep
//   有任何字段缺失     → 结论里带 evidence_level: "static"，并列出缺什么才能升级为
//                        运行期结论（agent-fitness-verdict spec：静态可判「待裁」，
//                        但必须标明证据等级）
//
// 为什么 R3 缺省不算红：本变更之前铸造的模板没有 `objective` 字段，把它算成红
// 会让 69 份存量包一夜之间全部"待裁"——那不是判据，是误伤。缺字段就是"这条判据
// 这次没证据"，与「判不出」同族（fleet-acceptance-readings：缺数不是通过，也不是红）。
//
// 用法：
//   node scripts/fitness-static-ablation.mjs --template <fleet-template.json>
//   node scripts/fitness-static-ablation.mjs --manifest <pack manifest.json>  # 取 manifest.fleet
//   node scripts/fitness-static-ablation.mjs --self-test
//
// 退出码：0 全部 keep / 1 至少一个 candidate-* / 2 判不出（模板解析不了）

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const EXIT = Object.freeze({ KEEP: 0, CANDIDATE: 1, UNDET: 2 });

/**
 * 纯判定：输入一份 `{ members, orchestration, agents? }`，输出逐岗结论。
 * 不读文件、不碰时钟——测试直接喂假模板。
 */
export function judgeStatic({ members, orchestration, agents = [] }) {
  const list = Array.isArray(members) ? members : [];
  if (!list.length) return { ok: false, reason: "no-members" };
  const edges = Array.isArray(orchestration?.edges) ? orchestration.edges : [];
  // 只有这些边携带"谁唤谁"的语义；trigger 边是 cron 的形状、report 边由树派生。
  const DIRECTED = new Set(["handoff", "fanout", "dispatch", "event"]);
  const agentById = new Map((Array.isArray(agents) ? agents : []).map((a) => [a?.id, a]));

  const posts = list.map((m) => {
    const ref = m?.ref ?? m?.id ?? null;
    const outbound = edges.filter((e) => DIRECTED.has(e?.kind) && e.from === ref);
    const inbound = edges.filter((e) => DIRECTED.has(e?.kind) && e.to === ref);
    const kpiSlots = Array.isArray(m?.kpiSlots) ? m.kpiSlots : [];
    // objective 只认显式声明（模板 members[] 或 persona 内联 agent）。两处都没有
    // ⇒ 这条判据这次没有证据，不是红。
    const agent = ref ? agentById.get(ref) : null;
    const objectiveDeclared = Boolean(m?.objective) || Boolean(agent?.objective);
    const objectiveProvenance = m?.objective ? "member" : agent?.objective ? "agent" : null;

    const findings = [];
    if (outbound.length === 0 && inbound.length === 0) findings.push({ code: "R1", detail: "no-reader" });
    if (kpiSlots.length === 0) findings.push({ code: "R2", detail: "no-contribution" });
    if (!objectiveDeclared) findings.push({ code: "R3", detail: "no-objective" });

    const codes = new Set(findings.map((f) => f.code));
    const hasObjectiveEvidence = objectiveDeclared;
    // 裁决：R3 缺席时不构成红，只降级证据等级。
    const decisive = findings.filter((f) => f.code !== "R3");
    let verdict;
    if (!hasObjectiveEvidence && decisive.length === 0) verdict = "keep-unproven";
    else if (codes.has("R1") && codes.has("R2")) verdict = "candidate-retire";
    else if (codes.has("R1") || codes.has("R2")) verdict = "candidate-merge";
    else verdict = "keep";

    return {
      ref,
      title: m?.title ?? null,
      outbound: outbound.map((e) => ({ kind: e.kind, to: e.to })),
      inbound: inbound.map((e) => ({ kind: e.kind, from: e.from })),
      kpiSlots: kpiSlots.map((s) => s?.key).filter(Boolean),
      objective: objectiveProvenance,
      findings,
      verdict,
      evidenceLevel: "static",
      // 升级到运行期结论还缺什么：这句话是给下一个读者（判定运行）的输入。
      missing: [
        ...(hasObjectiveEvidence ? [] : ["objective 声明（无它只能判「未证明」）"]),
        "运行期回合读数（静态只看声明，不看它实际做了什么）",
      ],
    };
  });

  const candidates = posts.filter((p) => p.verdict.startsWith("candidate-"));
  return {
    ok: true,
    evidenceLevel: "static",
    posts,
    summary: {
      total: posts.length,
      keep: posts.filter((p) => p.verdict === "keep").length,
      keepUnproven: posts.filter((p) => p.verdict === "keep-unproven").length,
      candidateMerge: posts.filter((p) => p.verdict === "candidate-merge").length,
      candidateRetire: posts.filter((p) => p.verdict === "candidate-retire").length,
    },
    candidates: candidates.map((p) => p.ref),
  };
}

/** 从文件读模板：`--template` 直接读 fleet 模板；`--manifest` 取 manifest.fleet。 */
export function loadTemplate(file) {
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!raw || typeof raw !== "object") throw new Error("template is not an object");
  // manifest 形状：fleet 段 + 顶层 agents。模板形状：members 直接在顶层。
  if (Array.isArray(raw.members) || raw.orchestration) {
    return { members: raw.members ?? [], orchestration: raw.orchestration, agents: raw.agents ?? [], source: "template" };
  }
  if (raw.fleet && typeof raw.fleet === "object") {
    return { members: raw.fleet.members ?? [], orchestration: raw.fleet.orchestration, agents: raw.agents ?? [], source: "manifest" };
  }
  throw new Error("no fleet members found (expected .members or .fleet.members)");
}

export function exitCodeFor(result) {
  if (!result.ok) return EXIT.UNDET;
  return result.candidates.length ? EXIT.CANDIDATE : EXIT.KEEP;
}

function renderHuman(judged, file) {
  const lines = [`静态消融（${file}）：${judged.summary.total} 岗`];
  for (const p of judged.posts) {
    const marks = p.findings.map((f) => f.code).join(",") || "-";
    lines.push(`  ${p.verdict.padEnd(17)} ${p.ref}  [${marks}]  入 ${p.inbound.length} / 出 ${p.outbound.length}  KPI ${p.kpiSlots.length}`);
  }
  const s = judged.summary;
  lines.push(`裁决: keep ${s.keep} · keep-unproven ${s.keepUnproven} · candidate-merge ${s.candidateMerge} · candidate-retire ${s.candidateRetire}`);
  if (judged.candidates.length) lines.push(`候选: ${judged.candidates.join(", ")}（证据等级 static）`);
  return lines.join("\n");
}

// ── 自证 ─────────────────────────────────────────────────────────────────────
export function selfTest() {
  const arms = [];
  const check = (name, got, want) => arms.push({ name, ok: JSON.stringify(got) === JSON.stringify(want), got, want });

  // 1) 全中：无进出边、无 KPI、无 objective ⇒ candidate-retire
  const orphan = judgeStatic({
    members: [{ ref: "a", kpiSlots: [] }, { ref: "b", kpiSlots: [{ key: "n" }] }],
    orchestration: { edges: [{ kind: "handoff", from: "b", to: "b" }] },
  });
  check("孤儿岗 ⇒ candidate-retire", orphan.posts.find((p) => p.ref === "a").verdict, "candidate-retire");

  // 2) 有进出边与 KPI、无 objective ⇒ keep-unproven（不是红）
  const healthy = judgeStatic({
    members: [{ ref: "x", kpiSlots: [{ key: "n" }] }, { ref: "y", kpiSlots: [{ key: "m" }] }],
    orchestration: { edges: [{ kind: "handoff", from: "x", to: "y" }] },
  });
  check("有边有 KPI、无 objective ⇒ keep-unproven", healthy.posts.find((p) => p.ref === "x").verdict, "keep-unproven");

  // 3) 有 objective ⇒ 升级为 keep
  const withObj = judgeStatic({
    members: [{ ref: "x", kpiSlots: [{ key: "n" }], objective: { metricKey: "n" } }, { ref: "y", kpiSlots: [{ key: "m" }] }],
    orchestration: { edges: [{ kind: "handoff", from: "x", to: "y" }] },
  });
  check("有 objective ⇒ keep", withObj.posts.find((p) => p.ref === "x").verdict, "keep");

  // 4) 只中 R1 ⇒ candidate-merge（有 KPI 说明有人收数，但没有读者）
  const mergable = judgeStatic({
    members: [{ ref: "solo", kpiSlots: [{ key: "n" }] }],
    orchestration: { edges: [] },
  });
  check("孤立但有 KPI ⇒ candidate-merge", mergable.posts[0].verdict, "candidate-merge");

  // 5) trigger 边不算读者（它是 cron 的形状，不是「谁用它的产出」）
  const triggerOnly = judgeStatic({
    members: [{ ref: "cronpost", kpiSlots: [] }],
    orchestration: { edges: [{ kind: "trigger", from: "cron(0 1 * * *)", to: "cronpost" }] },
  });
  check("只有 trigger 边 ⇒ 仍判无读者", triggerOnly.posts[0].findings.some((f) => f.code === "R1") ? "yes" : "no", "yes");

  // 6) 判不出：没有岗
  const empty = judgeStatic({ members: [], orchestration: { edges: [] } });
  check("零岗 ⇒ 判不出", exitCodeFor(empty), EXIT.UNDET);

  const bad = arms.filter((a) => !a.ok);
  for (const a of arms) console.log(`  ${a.ok ? "✓" : "✗"} ${a.name}${a.ok ? "" : `（实际 ${JSON.stringify(a.got)}，期望 ${JSON.stringify(a.want)}）`}`);
  console.log(bad.length ? `self-test ${bad.length} 项不符` : "self-test 全过");
  return bad.length ? 1 : 0;
}

function main(argv) {
  const arg = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : null;
  };
  const file = arg("--template") || arg("--manifest");
  if (!file) {
    console.error("usage: node scripts/fitness-static-ablation.mjs (--template <fleet-template.json> | --manifest <manifest.json>) [--json]");
    process.exit(EXIT.UNDET);
  }
  let tpl;
  try {
    tpl = loadTemplate(path.resolve(file));
  } catch (e) {
    console.error(`判不出：${e.message}`);
    process.exit(EXIT.UNDET);
  }
  const judged = judgeStatic(tpl);
  if (!judged.ok) {
    console.error(`判不出：${judged.reason}`);
    process.exit(EXIT.UNDET);
  }
  console.log(argv.includes("--json") ? JSON.stringify({ source: file, shape: tpl.source, ...judged }, null, 2) : renderHuman(judged, file));
  process.exit(exitCodeFor(judged));
}

function isMain() {
  if (!process.argv[1] || process.argv[1] === "-") return true;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (process.argv.includes("--self-test")) process.exit(selfTest());
if (isMain()) main(process.argv.slice(2));
