#!/usr/bin/env node
// ── 判定运行装配（establish-agent-role-and-fitness-plane 2.2 / 3.2）────────────
//
// 把三样东西合成**一行 fitness_run**：输入（窗口/预算/判据/臂）、读数（每臂的
// 四类确定性读数）、裁决（闭集）。输入落库后不可改写——「同一输入重算得同一裁决」
// 这条判据只有在输入不可变时才有意义。
//
// 为什么证据等级要跟裁决一起落：
//   静态消融 + 读数是**便宜的那一半**，它能给出 `inconclusive`（缺对照臂与消融臂）
//   或 `merge/retire` 的线索，但不构成三臂裁决。把「这是静态+观测，不是三臂」写进
//   同一行，是为了让下一个读者不必猜——「判不出」的价值全在 missing 里。
//
// 用法（集群内由判定运行调用；本机可用 --db 指向一份 fleets.db 副本）：
//   node scripts/fitness-run.mjs --db <fleets.db> --fleet <id> --hours 168 \
//        [--template <fleet-template.json>] [--budget '{"turnsPerDay":3,"tokensPerTurn":60000}'] \
//        [--persist] [--json]
//
// 不给 --template 时只做「观测臂」：臂列表 = team(观测) + 缺 control/ablation，
// 裁决必然 inconclusive，missing 指明缺什么。这不是半成品，这是诚实的最小判定。
//
// 退出码：0 已判出 retain/merge/redesign / 1 已判出 retire / 2 判不出 or 无法落库

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const EXIT = Object.freeze({ OK: 0, RETIRE: 1, UNDET: 2 });

const uid = () => `fit_${Date.now().toString(36)}_${crypto.randomBytes(4).toString("base64url")}`;

/**
 * 纯装配：读数 + 模板 + 预算 → 一行 fitness_run 的载荷。不写库、不碰时钟。
 * `judge` 与 `staticAblation` 由调用方注入（测试喂假函数，生产用真模块）。
 */
export function composeFitnessRun({ fleetId, packId = null, windowStart, windowEnd, budget = null, arms = [], readingsByArm = {}, staticAblation = null, verdict }) {
  const shapeArms = arms.map((a) => ({ kind: a.kind, ref: a.ref, budget: a.budget ?? budget ?? null, readings: readingsByArm[a.ref] ?? null }));
  return {
    id: uid(),
    fleetId,
    packId,
    mode: arms.length >= 3 ? "three-arm" : arms.length >= 2 ? "two-arm" : "observed",
    windowStart,
    windowEnd,
    budget,
    criteria: [
      { id: "failure-rate", kind: "deterministic", limit: 0.25 },
      { id: "report-gap-rate", kind: "deterministic", limit: 0.25 },
      { id: "unit-cost", kind: "deterministic" },
      { id: "queue-wait", kind: "deterministic" },
    ],
    arms: shapeArms,
    readings: readingsByArm,
    evidence: {
      // 静态消融是可复算的：它的输入是模板，输出是逐岗结论。
      staticAblation: staticAblation ?? null,
      // 证据等级：下游据此知道这条裁决能支撑到哪一步。
      level: arms.length >= 3 ? "three-arm" : arms.length >= 2 ? "two-arm" : "observed",
      yardstick: "同一窗口、同一判据、同预算；gold 取自 member_turn_events / member_reports / member_turn_daily",
    },
    missing: verdict.missing ?? [],
    verdict: verdict.verdict,
  };
}

/** 把一行 fitness_run 落库（幂等：id 主键，重复写同 id 即为重放）。 */
export async function persistFitnessRun(run, { dbPath }) {
  const { createFleetDatabase } = await import("../server/routes/fleets-db.js");
  const db = createFleetDatabase({ file: dbPath });
  try {
    db.appendFitnessRun({ ...run, judgedBy: "fitness-run.mjs" });
    const back = db.getFitnessRun(run.id);
    return { ok: Boolean(back), back };
  } finally {
    db.close();
  }
}

// ── CLI ──────────────────────────────────────────────────────────────────────
async function main(argv) {
  const arg = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : null;
  };
  const dbPath = arg("--db");
  const fleetId = arg("--fleet");
  const hours = Number(arg("--hours") ?? 168);
  if (!dbPath || !fleetId || !Number.isFinite(hours) || hours <= 0) {
    console.error("usage: node scripts/fitness-run.mjs --db <fleets.db> --fleet <id> [--hours 168] [--template <json>] [--budget <json>] [--persist] [--json]");
    process.exit(EXIT.UNDET);
  }
  const windowEnd = Date.now();
  const windowStart = windowEnd - hours * 3_600_000;

  const { readFleet } = await import("./fitness-read.mjs");
  const { evaluateVerdict } = await import("../lib/fitness-verdict.js");
  const read = readFleet({ dbPath: path.resolve(dbPath), fleetId, windowStart, windowEnd });
  if (!read.ok) {
    console.error(`判不出：${read.reason}`);
    process.exit(EXIT.UNDET);
  }

  // 观测臂：把整个舰队的读数当成「团队」那一臂的观测值。没有对照臂与消融臂，
  // 所以裁决必然是 inconclusive——missing 会说清缺什么。
  const r = read.readings;
  const totals = r.totals.turns;
  const failed = r.members.reduce((n, m) => n + m.failed, 0);
  const owing = r.members.reduce((n, m) => n + m.reportsExpected, 0);
  const gap = r.members.reduce((n, m) => n + m.reportGap, 0);
  const readings = {
    turns: totals,
    failureRate: totals ? Math.round((failed / totals) * 1000) / 1000 : null,
    reportGapRate: owing ? Math.round((gap / owing) * 1000) / 1000 : null,
    costUsd: r.cost.usd,
    queueWaitMsP50: r.members.map((m) => m.queueWaitMsP50).filter((v) => v !== null).sort((a, b) => a - b)[0] ?? null,
  };

  let staticAblation = null;
  const templateFile = arg("--template");
  if (templateFile) {
    const { judgeStatic, loadTemplate } = await import("./fitness-static-ablation.mjs");
    try {
      staticAblation = judgeStatic(loadTemplate(path.resolve(templateFile)));
    } catch (e) {
      staticAblation = { ok: false, reason: e.message };
    }
  }

  let budget = null;
  const budgetArg = arg("--budget");
  if (budgetArg) {
    try {
      budget = JSON.parse(budgetArg);
    } catch {
      console.error("--budget 不是合法 JSON");
      process.exit(EXIT.UNDET);
    }
  }

  const arms = [{ kind: "team", ref: "team", budget }];
  const verdict = evaluateVerdict({ arms: arms.map((a) => ({ ...a, readings })) });
  const run = composeFitnessRun({
    fleetId,
    windowStart,
    windowEnd,
    budget,
    arms,
    readingsByArm: { team: readings },
    staticAblation,
    verdict,
  });

  let persisted = null;
  if (argv.includes("--persist")) {
    persisted = await persistFitnessRun(run, { dbPath: path.resolve(dbPath) });
    if (!persisted.ok) {
      console.error("落库失败：写入后读不回该行");
      process.exit(EXIT.UNDET);
    }
  }

  const out = { run, persisted: persisted ? { ok: true, id: persisted.back.id } : null, readings, staticAblation: staticAblation ? staticAblation.summary : null };
  console.log(argv.includes("--json") ? JSON.stringify(out, null, 2) : renderHuman(out));
  process.exit(verdict.verdict === "retire" ? EXIT.RETIRE : verdict.verdict === "inconclusive" ? EXIT.UNDET : EXIT.OK);
}

function renderHuman({ run, readings, staticAblation }) {
  const lines = [
    `判定运行 ${run.id}（${run.mode}）${new Date(run.windowStart).toISOString()} → ${new Date(run.windowEnd).toISOString()}`,
    `裁决: ${run.verdict}`,
    `读数: 回合 ${readings.turns} · 失败率 ${readings.failureRate ?? "-"} · 缺报率 ${readings.reportGapRate ?? "-"} · 成本 $${readings.costUsd}`,
  ];
  if (staticAblation) lines.push(`静态消融: keep ${staticAblation.keep} · unproven ${staticAblation.keepUnproven} · merge ${staticAblation.candidateMerge} · retire ${staticAblation.candidateRetire}`);
  for (const m of run.missing) lines.push(`  缺: ${m}`);
  return lines.join("\n");
}

function isMain() {
  if (!process.argv[1] || process.argv[1] === "-") return true;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(e?.stack || String(e));
    process.exit(EXIT.UNDET);
  });
}
