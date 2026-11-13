#!/usr/bin/env node
// 队列饥饿判据：挂着 queued 却不在链上（change3 task 5.4）。
//
// 5.4 的验收是"一个交易日窗口后检查 queue.queued 与 fairness.pending 合计是否出现
// 挂着 queued 却不在链上"。**观察需要真实交易日**，但判据本身现在就能写成脚本：
// 到时候只要 `--url` 指到一台在跑的 platform，一条命令出结论。
//
// 读面（server/routes/misc.js 的 /api/monitor）：
//   queue.queued / queue.running / queue.queuedExempt
//   queue.fairness.fleets[].queued        各舰队待执行数（"fairness.pending 合计"就是它求和）
//   queue.fairness.enabled                公平调度是否开着（关着时该字段无意义）
//
// 判据（**必须扣掉两样**，否则会把正常状态报成饥饿）：
//   · running：正在执行的那个在 queue.queued 里可能还算着，它不在"等"的集合里；
//   · queuedExempt：按设计等待（丢弃会丢整期）的轮次。**豁免的活不能当 stalled 的证据** ——
//     这是 11-09 的教训，同一条在这里直接适用。
//
// 用法：
//   node scripts/check-trading-queue-starved.mjs --selftest      # 用合成快照自检（默认跑这个）
//   node scripts/check-trading-queue-starved.mjs --url http://host:3100
//   node scripts/check-trading-queue-starved.mjs --file snap.json
// 退出码：0 = 无饥饿；1 = 出现饥饿（点名差额）；2 = 判不了（读不到/公平调度未开）

import fs from "node:fs";

/**
 * @returns {{verdict: "ok"|"starved"|"cannot_judge", detail: string, numbers?: object}}
 */
export function judge(snapshot) {
  const q = snapshot?.queue;
  if (!q || typeof q.queued !== "number") {
    return { verdict: "cannot_judge", detail: "快照里没有 queue.queued（读面变了？）" };
  }
  const fairness = q.fairness ?? {};
  if (fairness.enabled !== true) {
    // 公平调度关着时 per-fleet 计数不是权威口径，据此判饥饿会误报。
    return { verdict: "cannot_judge", detail: "公平调度未启用（fairness.enabled != true），该判据不适用" };
  }
  const fleets = Array.isArray(fairness.fleets) ? fairness.fleets : null;
  if (!fleets) {
    return { verdict: "cannot_judge", detail: "fairness.fleets 缺失或不是数组" };
  }
  // "fairness.pending 合计"= 各舰队 queued 之和
  const pendingSum = fleets.reduce((a, f) => a + (Number(f.queued) || 0), 0);
  const queued = q.queued;
  const running = Number(q.running) || 0;
  const exempt = Number(q.queuedExempt) || 0;
  const unaccounted = queued - pendingSum - running - exempt;
  const numbers = { queued, pendingSum, running, exempt, unaccounted };

  if (unaccounted > 0) {
    return {
      verdict: "starved",
      detail: `queue.queued=${queued}，公平队列只认领 ${pendingSum} 条；扣掉 running=${running}、` +
              `豁免 ${exempt} 后仍有 ${unaccounted} 条"挂着 queued 却不在链上"`,
      numbers,
    };
  }
  return {
    verdict: "ok",
    detail: `queue.queued=${queued} 与 fairness 合计 ${pendingSum} 对得上（running=${running}, 豁免=${exempt}）`,
    numbers,
  };
}

// ---- 自检：三种必须分得开的形态 ----------------------------------------------
function selftest() {
  let failed = 0;
  const check = (name, snap, want) => {
    const got = judge(snap).verdict;
    const ok = got === want;
    if (!ok) failed += 1;
    console.log(`  ${ok ? "✓" : "✗"} ${name} → ${got}${ok ? "" : `（期望 ${want}）`}`);
  };
  const base = (over = {}) => ({
    queue: {
      queued: 0, running: 0, queuedExempt: 0,
      fairness: { enabled: true, fleets: [] },
      ...over,
    },
  });

  check("健康：3 条排队，公平队列全认领", base({
    queued: 3, fairness: { enabled: true, fleets: [{ fleetId: "f1", queued: 3 }] },
  }), "ok");

  check("饥饿：5 条排队但公平队列只认领 2 条", base({
    queued: 5, fairness: { enabled: true, fleets: [{ fleetId: "f1", queued: 2 }] },
  }), "starved");

  check("豁免：4 条全是按设计等待，不算饥饿", base({
    queued: 4, queuedExempt: 4, fairness: { enabled: true, fleets: [] },
  }), "ok");

  check("正在跑：1 条在跑、0 条在等", base({
    queued: 1, running: 1, fairness: { enabled: true, fleets: [] },
  }), "ok");

  check("判不了：公平调度未启用", base({
    queued: 9, fairness: { enabled: false, fleets: [] },
  }), "cannot_judge");

  check("判不了：读面缺 queued", { queue: { fairness: { enabled: true, fleets: [] } } },
    "cannot_judge");

  // 这条是"不改判据、只改数据"的反向证明：把同一个快照的差额补平，结论必须翻面
  const starved = base({ queued: 5, fairness: { enabled: true, fleets: [{ queued: 2 }] } });
  const fixed = base({ queued: 2, fairness: { enabled: true, fleets: [{ queued: 2 }] } });
  const flips = judge(starved).verdict === "starved" && judge(fixed).verdict === "ok";
  console.log(`  ${flips ? "✓" : "✗"} 反向：同一判据下数据补平后结论翻面`);
  if (!flips) failed += 1;

  if (failed) {
    console.error(`\n✗ selftest 不成立：${failed} 条`);
    return 1;
  }
  console.log("\n✓ selftest 通过：健康/饥饿/豁免/在跑/判不了 五种形态分得开");
  return 0;
}

async function main(argv) {
  const selftestIdx = argv.indexOf("--selftest");
  const urlIdx = argv.indexOf("--url");
  const fileIdx = argv.indexOf("--file");
  if (selftestIdx !== -1 || (urlIdx === -1 && fileIdx === -1)) return selftest();

  let snapshot;
  try {
    if (fileIdx !== -1) {
      snapshot = JSON.parse(fs.readFileSync(argv[fileIdx + 1], "utf8"));
    } else {
      const res = await fetch(`${argv[urlIdx + 1].replace(/\/$/, "")}/api/monitor`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      snapshot = await res.json();
    }
  } catch (e) {
    console.error(`✗ 读不到快照：${e?.message || e}（跑不完整 ≠ 没有饥饿）`);
    return 2;
  }

  const out = judge(snapshot);
  console.log(`${out.verdict === "ok" ? "✓" : out.verdict === "starved" ? "✗" : "?"} ${out.detail}`);
  if (out.numbers) console.log(`  ${JSON.stringify(out.numbers)}`);
  return out.verdict === "ok" ? 0 : out.verdict === "starved" ? 1 : 2;
}

if (process.argv[1] && process.argv[1].endsWith("check-trading-queue-starved.mjs")) {
  process.exitCode = await main(process.argv);
}
