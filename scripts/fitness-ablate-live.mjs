#!/usr/bin/env node
// ── 活舰队静态消融扫描（fitness-ablate-live）──────────────────────────────────
//
// 把 `fitness-static-ablation.mjs` 的纯判定接到**活舰队**上：cells 里每支 active
// 舰队的 fleet_members + orchestration 就是真实模板，不需要市场里的 pack 模板
// （那是发布态；这里要的是运行态——2026-11-23 实测 `source_template` 只存
// `{packId, version}`，模板本体不在舰队行里）。
//
// 为什么单独一个驱动而不是改 scanCells：两者的输入不同（一个读回合表，一个读
// 编制表），判出来的东西也不同（「跑得好不好」vs「该不该存在」）。混在一个命令
// 里会让两种结论互相冒充。共用的只有 `judgeStatic` 这个纯函数。
//
// 判词（与静态消融一致）：
//   0 所有舰队所有岗 keep / keep-unproven
//   1 至少一个岗 candidate-merge / candidate-retire
//   2 判不出（cells 根读不到、一片 cell 都没有）
//
// 用法：
//   node scripts/fitness-ablate-live.mjs --cells-root /data/cells [--json]
//   node scripts/fitness-ablate-live.mjs --self-test

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EXIT = Object.freeze({ KEEP: 0, CANDIDATE: 1, UNDET: 2 });

/** 把一行 fleet（含 uuid 成员 id）转成静态消融认识的模板形状。纯函数。 */
export function fleetToTemplate({ fleetId, fleetName, members = [], orchestration = null }) {
  const list = Array.isArray(members) ? members : [];
  if (!list.length) return null;
  const posts = list.map((m) => ({
    ref: m.id,
    title: m.title,
    parentRef: m.parent_id ?? null,
    kpiSlots: Array.isArray(m.kpi_slots) ? m.kpi_slots : JSON.parse(m.kpi_slots || "[]"),
    cadence: typeof m.cadence === "string" ? JSON.parse(m.cadence) : (m.cadence ?? null),
  }));
  const orch = typeof orchestration === "string" ? JSON.parse(orchestration || "null") : orchestration;
  return {
    fleetId,
    name: fleetName,
    template: { members: posts, orchestration: orch ?? { edges: [] } },
  };
}

/** 纯扫描：对每一支舰队跑静态消融，汇总逐岗结论。不碰 fs（调用方给原始行）。 */
export function ablateAll({ fleets = [], membersByFleet = new Map(), judge }) {
  const out = [];
  for (const f of fleets) {
    const tpl = fleetToTemplate({
      fleetId: f.id,
      fleetName: f.name,
      members: membersByFleet.get(f.id) ?? [],
      orchestration: f.orchestration ?? null,
    });
    if (!tpl) {
      out.push({ fleetId: f.id, name: f.name, skipped: "no-members" });
      continue;
    }
    const judged = judge(tpl.template);
    if (!judged.ok) {
      out.push({ fleetId: f.id, name: f.name, skipped: judged.reason });
      continue;
    }
    const candidates = judged.posts.filter((p) => p.verdict.startsWith("candidate-"));
    out.push({
      fleetId: f.id,
      name: f.name,
      members: judged.posts.length,
      summary: judged.summary,
      candidates: candidates.map((p) => ({ ref: p.ref, title: p.title, verdict: p.verdict, codes: p.findings.map((x) => x.code) })),
    });
  }
  const totalCandidates = out.reduce((n, f) => n + (f.candidates?.length ?? 0), 0);
  const judgedFleets = out.filter((f) => !f.skipped).length;
  return {
    ok: true,
    fleetsJudged: judgedFleets,
    fleetsSkipped: out.filter((f) => f.skipped).length,
    totalCandidates,
    verdict: totalCandidates > 0 ? "candidate" : judgedFleets > 0 ? "keep" : "undet",
    fleets: out,
  };
}

// ── CLI ──────────────────────────────────────────────────────────────────────
async function main(argv) {
  const arg = (n) => {
    const i = argv.indexOf(n);
    return i >= 0 ? argv[i + 1] : null;
  };
  const cellsRoot = arg("--cells-root") || "/data/cells";
  if (!fs.existsSync(cellsRoot)) {
    console.error(`判不出：${cellsRoot} 不存在`);
    process.exit(EXIT.UNDET);
  }
  const Database = (await import("better-sqlite3")).default;
  const { judgeStatic } = await import("./fitness-static-ablation.mjs");

  const cells = fs
    .readdirSync(cellsRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => path.join(cellsRoot, d.name));
  if (!cells.length) {
    console.error("判不出：一片 cell 都没有");
    process.exit(EXIT.UNDET);
  }

  const fleets = [];
  const membersByFleet = new Map();
  let cellsRead = 0;
  for (const cellDir of cells) {
    const dbPath = path.join(cellDir, "data", "data", "fleets.db");
    if (!fs.existsSync(dbPath)) continue;
    let db;
    try {
      db = new Database(dbPath, { readonly: true, fileMustExist: true });
    } catch {
      continue;
    }
    try {
      const rows = db.prepare("SELECT id, name, orchestration FROM fleets WHERE state = 'active'").all();
      for (const r of rows) {
        fleets.push(r);
        if (!membersByFleet.has(r.id)) {
          membersByFleet.set(
            r.id,
            db.prepare("SELECT id, title, parent_id, kpi_slots, cadence FROM fleet_members WHERE fleet_id = ?").all(r.id),
          );
        }
      }
      // 同一支舰队可能出现在多个 cell（模板 dedup 是 pack+owner，不是 fleet id），
      // 先到先得：members 取自它实际所在的第一个 cell。
      cellsRead += 1;
    } catch {
      /* 这一片的库读不动，跳过（下面按「判不出」处理整个根都没有舰队的情形） */
    } finally {
      db.close();
    }
  }

  if (!fleets.length) {
    console.error(`判不出：${cellsRead} 片 cell 有库，但没有一支 active 舰队`);
    process.exit(EXIT.UNDET);
  }

  const result = ablateAll({ fleets, membersByFleet, judge: judgeStatic });
  if (argv.includes("--json")) {
    console.log(JSON.stringify({ cellsRoot, cellsRead, ...result }, null, 2));
  } else {
    console.log(`活舰队静态消融（${cellsRoot}，${cellsRead} 片 cell）`);
    console.log(`判了 ${result.fleetsJudged} 支舰队，跳过 ${result.fleetsSkipped} 支，候选岗 ${result.totalCandidates} 个`);
    for (const f of result.fleets) {
      if (f.skipped) continue;
      const s = f.summary;
      console.log(
        `  ${f.fleetId.slice(0, 22)} ${f.name.slice(0, 22)}  岗 ${f.members}  keep ${s.keep} unproven ${s.keepUnproven} merge ${s.candidateMerge} retire ${s.candidateRetire}`,
      );
      for (const c of f.candidates) console.log(`      → ${c.verdict.padEnd(17)} ${c.title ?? c.ref} [${c.codes.join(",")}]`);
    }
    console.log(`判定: ${result.verdict}`);
  }
  process.exit(result.verdict === "candidate" ? EXIT.CANDIDATE : result.verdict === "keep" ? EXIT.KEEP : EXIT.UNDET);
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
if (isMain()) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(e?.stack || String(e));
    process.exit(EXIT.UNDET);
  });
}

// ── 自证 ─────────────────────────────────────────────────────────────────────
export function selfTest() {
  const arms = [];
  const check = (n, got, want) => arms.push({ n, ok: JSON.stringify(got) === JSON.stringify(want), got, want });
  const judge = ({ members, orchestration }) => {
    // 极简判定：无进出边 + 无 KPI ⇒ candidate-retire；只有其一 ⇒ candidate-merge；否则 keep-unproven
    const edges = orchestration?.edges ?? [];
    const posts = members.map((m) => {
      const out = edges.filter((e) => e.from === m.ref).length;
      const inn = edges.filter((e) => e.to === m.ref).length;
      const kpi = m.kpiSlots.length;
      const codes = [];
      if (!out && !inn) codes.push("R1");
      if (!kpi) codes.push("R2");
      return { ref: m.ref, title: m.title, verdict: codes.length === 2 ? "candidate-retire" : codes.length === 1 ? "candidate-merge" : "keep-unproven", findings: codes.map((c) => ({ code: c })) };
    });
    return { ok: true, posts, summary: { total: posts.length } };
  };

  check(
    "孤儿岗 ⇒ candidate-retire",
    ablateAll({
      fleets: [{ id: "f1", name: "x", orchestration: JSON.stringify({ edges: [] }) }],
      membersByFleet: new Map([["f1", [{ id: "a", title: "A", kpi_slots: "[]", cadence: null }]]]),
      judge,
    }).totalCandidates,
    1,
  );
  check(
    "无成员舰队被跳过（不是判绿）",
    ablateAll({
      fleets: [{ id: "f2", name: "y", orchestration: null }],
      membersByFleet: new Map([["f2", []]]),
      judge,
    }).fleetsSkipped,
    1,
  );
  check(
    "零舰队 ⇒ undet",
    ablateAll({ fleets: [], membersByFleet: new Map(), judge }).verdict,
    "undet",
  );

  const bad = arms.filter((a) => !a.ok);
  for (const a of arms) console.log(`  ${a.ok ? "✓" : "✗"} ${a.n}${a.ok ? "" : `（实际 ${JSON.stringify(a.got)}，期望 ${JSON.stringify(a.want)}）`}`);
  console.log(bad.length ? `self-test ${bad.length} 项不符` : "self-test 全过");
  return bad.length ? 1 : 0;
}
