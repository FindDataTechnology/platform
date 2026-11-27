// check_cell_cron_liveness.mjs — cell 内 cron 行的活性闸（只读；EXIT=1 命中，EXIT=2 判不出）。
//
// 背景（2026-11-15）：幕僚长信息早报 tz="Shanghai" 静默 8 天不跑，一切读数"正常"——
// status=scheduled、无 error 行、同 cell 兄弟任务照跑。集群侧的 check_cronjob_health.py
// 只扫 k8s CronJob；cell 内 jobs.json 的 1900+ 行此前零判据。本闸判据是「lastRun 是否
// 跟上最近一轮应触发时刻」，不是 status（scheduled 是愿望，不是事实）。
//
// 三档分得清，别混：
//   STALE       该触发而没触发（含 arm 成功却永不触发）
//   UNPARSEABLE cron/tz 解析不出（正是 tz="Shanghai" 的形态）
//   未到点      createdAt 起第一个触发点还在未来 —— 不是缺陷，不计命中
//
// STALE 判据不能依赖「闸恰好跑在周期的哪一刻」（2026-11-15 实测撞到）：一轮 fire
// 从 due 到真正起步有排队延迟（cell 串行槽被占），`15 * * * *` 那条实测 12:15 的轮
// 12:33 才起步 ⇒ 若判据是「lastRun 落后最近一轮触发 30 分钟」，它在 [due, 起步) 这段
// 每小时都红，而日频闸（05:25 CST＝21:25Z）正好落在该任务 :15 触发后 10 分钟。
// 所以拆成两条，各自与采样时刻无关：
//   ① missed-cycle       lastRun 早于「上上轮」触发点（扣抖动余量）⇒ 至少一整个周期没跑
//   ② fire-never-started  上一轮跑过，但本轮 due 已过 CELL_CRON_START_LATENCY_MIN
//                        （缺省 45 分钟，实测排队延迟到过 18 分钟）仍未起步
// 只判 ② 会漏掉「每天只 fire 一次、今天这轮没起」以外的一切；只判 ① 则漏一轮要等两轮才报。
//
// 自证（--self-test，离线夹具）：停滞 / 健康 / 坏tz / 暂停 / maxRuns满 / 未到点 /
// 从未跑且已错过 / interval 停滞 / interval 健康 —— 红绿各路都要有，省掉红路
// 「所有声明都被判红」与「判据写反」长得一样。
//
// 用法：
//   node scripts/check_cell_cron_liveness.mjs [--root /data/cells] [--jobs-file f.json]...
//   node scripts/check_cell_cron_liveness.mjs --self-test
// 调参：CELL_CRON_START_LATENCY_MIN（缺省 45）＝一轮 fire 允许排队多久才算「没起来」。

import fs from "node:fs";
import path from "node:path";

// cron-parser 在仓内走裸名；在 pod 里脚本常被 cp 到 /tmp 跑，退 /app 的绝对路径。
let cronParser;
try {
  cronParser = (await import("cron-parser")).default ?? (await import("cron-parser"));
} catch {
  cronParser = (await import("/app/node_modules/cron-parser/lib/parser.js")).default;
}

const GRACE_MS = 30 * 60 * 1000; // 抖动余量：lastRun 与触发点比较的容差（触发时刻本身有秒级抖动）
// 一轮 fire 允许排队多久才算「没起来」。实测排队延迟到过 18 分钟（cell 串行槽被占），
// 定 45 分钟：既容得下真实延迟，又能当天报出「这一轮确实没起」。
const START_LATENCY_MS = Number(process.env.CELL_CRON_START_LATENCY_MIN || 45) * 60 * 1000;
const UNIT_MS = { minute: 60_000, hour: 3_600_000, day: 86_400_000, week: 604_800_000 };

function scanJobs(jobs, nowMs, out) {
  for (const j of jobs) {
    out.scanned++;
    if (!j || j.paused) { out.skippedPaused++; continue; }
    if (j.maxRuns != null && (j.runs ?? 0) >= j.maxRuns) { out.skippedCapped++; continue; }
    if (j.status === "completed" || j.status === "expired") { out.skippedRetired++; continue; }
    const lastRunMs = j.lastRun ? Date.parse(j.lastRun) : null;
    if (j.type === "recurring" && j.cron) {
      out.recurring++;
      let it;
      try {
        it = cronParser.parseExpression(j.cron, { tz: j.tz || undefined, currentDate: new Date(nowMs) });
      } catch (err) {
        out.unparseable.push({ id: j.id ?? "?", cron: j.cron, tz: j.tz ?? null, where: "parse", msg: String(err.message).slice(0, 80) });
        continue;
      }
      let prevMs, prev2Ms;
      try {
        prevMs = it.prev().getTime();
        prev2Ms = it.prev().getTime();
      } catch (err) {
        // parse 过、算触发点抛 —— tz 只在这里显形（CronDate 查表失败）
        out.unparseable.push({ id: j.id ?? "?", cron: j.cron, tz: j.tz ?? null, where: "next", msg: String(err.message).slice(0, 80) });
        continue;
      }
      if (lastRunMs != null) {
        const missedCycle = lastRunMs < prev2Ms - GRACE_MS;            // ① 至少一整个周期没跑
        const pendingMs = nowMs - prevMs;
        // ② 上一轮跑过、本轮已 due 过久仍未起步（不把「正在排队/正在跑」判成坏）
        const neverStarted = !missedCycle && lastRunMs < prevMs && pendingMs > START_LATENCY_MS;
        if (missedCycle || neverStarted) {
          out.stale.push({
            id: j.id ?? "?", cron: j.cron, tz: j.tz ?? null,
            lastRun: j.lastRun, lastDue: new Date(prevMs).toISOString(),
            prevDue: new Date(prev2Ms).toISOString(),
            gapH: +((prevMs - lastRunMs) / 3600000).toFixed(1),
            why: missedCycle ? "missed-cycle" : "fire-never-started",
            pendingH: neverStarted ? +(pendingMs / 3600000).toFixed(2) : null,
            name: j.name ?? null, error: j.error ?? null,
          });
        }
      } else {
        // 从未跑过：以 createdAt 起的第一个触发点为准 —— 还在未来就是未到点，不是缺陷
        const createdMs = j.createdAt ? Date.parse(j.createdAt) : null;
        if (!Number.isFinite(createdMs)) {
          out.stale.push({ id: j.id ?? "?", cron: j.cron, tz: j.tz ?? null, lastRun: null, note: "never-ran-no-anchor", why: "never-ran-no-anchor", name: j.name ?? null });
          continue;
        }
        let firstMs;
        try {
          firstMs = cronParser.parseExpression(j.cron, { tz: j.tz || undefined, currentDate: new Date(createdMs) }).next().getTime();
        } catch (err) {
          out.unparseable.push({ id: j.id ?? "?", cron: j.cron, tz: j.tz ?? null, where: "first", msg: String(err.message).slice(0, 80) });
          continue;
        }
        if (nowMs - firstMs > START_LATENCY_MS) {
          out.stale.push({
            id: j.id ?? "?", cron: j.cron, tz: j.tz ?? null, lastRun: null,
            firstDue: new Date(firstMs).toISOString(),
            overdueH: +((nowMs - firstMs) / 3600000).toFixed(1),
            why: "never-ran", note: "never-ran", name: j.name ?? null, error: j.error ?? null,
          });
        } else {
          out.notDue++;
        }
      }
    } else if (j.type === "recurring" && j.interval) {
      out.recurring++;
      const n = Number(j.interval?.number), unit = j.interval?.unit;
      const stepMs = n * (UNIT_MS[unit] || 0);
      const anchorMs = Date.parse(j.anchor || j.createdAt || "");
      const baseMs = lastRunMs ?? anchorMs;
      if (!(stepMs > 0) || !Number.isFinite(baseMs)) continue;
      if (nowMs - baseMs > stepMs * 1.5 + GRACE_MS) {
        out.stale.push({
          id: j.id ?? "?", cron: `every ${n} ${unit}`, tz: j.tz ?? null,
          lastRun: j.lastRun ?? null, gapH: +((nowMs - baseMs) / 3600000).toFixed(1),
          name: j.name ?? null, error: j.error ?? null,
        });
      }
    }
  }
  return out;
}

function scanRoot(root, nowMs) {
  const out = { scanned: 0, recurring: 0, stale: [], unparseable: [], notDue: 0, skippedPaused: 0, skippedCapped: 0, skippedRetired: 0 };
  const files = [];
  (function walk(dir, depth) {
    if (depth > 5) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (p.endsWith("cron-store/jobs.json")) files.push(p);
    }
  })(root, 0);
  for (const f of files) {
    let d;
    try {
      d = JSON.parse(fs.readFileSync(f, "utf8"));
    } catch (err) {
      out.unparseable.push({ id: f, cron: null, tz: null, where: "file", msg: err.message.slice(0, 80) });
      continue;
    }
    const jobs = Array.isArray(d) ? d : (d.jobs || []);
    if (!Array.isArray(jobs)) { out.unparseable.push({ id: f, cron: null, tz: null, where: "file", msg: "jobs.json is not an array" }); continue; }
    scanJobs(jobs, nowMs, out);
  }
  return out;
}

function print(out) {
  console.log(`scanned=${out.scanned} recurring=${out.recurring} stale=${out.stale.length} unparseable=${out.unparseable.length} notDue(skipped)=${out.notDue}`);
  for (const u of out.unparseable) console.log(`  UNPARSEABLE [${u.where}] ${u.id} ${JSON.stringify(u.cron)} tz=${u.tz} | ${u.msg}`);
  for (const s of out.stale.sort((a, b) => (b.gapH ?? b.overdueH ?? 0) - (a.gapH ?? a.overdueH ?? 0))) {
    const gap = s.gapH != null ? `gap=${s.gapH}h` : (s.overdueH != null ? `overdue=${s.overdueH}h` : "");
    const due = s.lastDue ? `lastDue=${s.lastDue}` : (s.firstDue ? `firstDue=${s.firstDue}` : "");
    // 判词要点名当事的事实值：哪一档（why）、漏的那一轮在哪、本轮已等多久
    const why = s.why === "missed-cycle"
      ? `why=missed-cycle(上上轮 ${s.prevDue} 也没跑)`
      : (s.why === "fire-never-started" ? `why=fire-never-started(已等 ${s.pendingH}h)` : "");
    console.log(`  STALE ${s.id} ${JSON.stringify(s.cron)} tz=${s.tz} lastRun=${s.lastRun} ${due} ${gap} ${why} ${s.note === "never-ran" ? "never-ran(从未跑过)" : ""} ${s.error ? `| error: ${s.error}` : ""}`);
  }
  if (out.stale.length === 0 && out.unparseable.length === 0) console.log("✓ 所有在册 recurring 行都在自己的窗口内");
}

function selfTest() {
  const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "cron-liveness-"));
  const nowMs = Date.now();
  const D = 86_400_000;
  const mk = (id, extra) => ({ id, type: "recurring", paused: false, prompt: "x", history: [], ...extra });
  // 与采样时刻无关的三条（成对，靠 cronParser 自己求 prev1/prev2，不依赖墙上时钟）：
  // 同一份夹具只换「上一轮跑没跑」与「本轮 due 过了多久」，红绿必须分得开。
  const occ = (expr, tz) => {
    const it = cronParser.parseExpression(expr, { tz, currentDate: new Date(nowMs) });
    const p1 = it.prev().getTime();
    const p2 = it.prev().getTime();
    return { p1, p2 };
  };
  const hourly = occ("15 * * * *", "UTC");   // 每小时 :15
  const daily = occ("0 9 * * *", "UTC");     // 每天 09:00Z
  const cases = [
    ["stale-daily", { jobs: [mk("stale1", { cron: "0 9 * * *", tz: "Asia/Shanghai", lastRun: new Date(nowMs - 10 * D).toISOString(), status: "scheduled" })], wantStale: 1, wantUnparseable: 0 }],
    ["healthy-daily", { jobs: [mk("ok1", { cron: "0 9 * * *", tz: "Asia/Shanghai", lastRun: new Date(nowMs - 3600_000).toISOString(), status: "scheduled" })], wantStale: 0, wantUnparseable: 0 }],
    ["bad-tz", { jobs: [mk("tz1", { cron: "00 09 * * *", tz: "Shanghai", status: "scheduled" })], wantStale: 0, wantUnparseable: 1 }],
    ["paused", { jobs: [mk("p1", { cron: "0 9 * * *", lastRun: new Date(nowMs - 10 * D).toISOString(), paused: true })], wantStale: 0, wantUnparseable: 0 }],
    ["capped", { jobs: [mk("c1", { cron: "0 9 * * *", lastRun: new Date(nowMs - 10 * D).toISOString(), maxRuns: 3, runs: 3 })], wantStale: 0, wantUnparseable: 0 }],
    ["not-due-monthly", { jobs: [mk("m1", { cron: "0 9 1 * *", createdAt: new Date(nowMs - 5 * D).toISOString(), status: "scheduled" })], wantStale: 0, wantUnparseable: 0 }],
    ["never-ran-missed", { jobs: [mk("n1", { cron: "0 9 * * *", createdAt: new Date(nowMs - 5 * D).toISOString(), status: "scheduled" })], wantStale: 1, wantUnparseable: 0, wantWhy: "never-ran" }],
    ["interval-stale", { jobs: [mk("i1", { interval: { number: 6, unit: "hour" }, anchor: new Date(nowMs - 10 * D).toISOString(), createdAt: new Date(nowMs - 10 * D).toISOString(), status: "scheduled" })], wantStale: 1, wantUnparseable: 0 }],
    ["interval-healthy", { jobs: [mk("i2", { interval: { number: 6, unit: "hour" }, anchor: new Date(nowMs - 3600_000).toISOString(), createdAt: new Date(nowMs - 3600_000).toISOString(), status: "scheduled" })], wantStale: 0, wantUnparseable: 0 }],
    ["utc-is-legal", { jobs: [mk("u1", { cron: "00 09 * * *", tz: "UTC", lastRun: new Date(nowMs - 3600_000).toISOString(), status: "scheduled" })], wantStale: 0, wantUnparseable: 0 }],
    // ↓ 本轮修的形态：闸在「本轮 fire 已 due、还在排队」那一刻采样
    // 每小时任务，上一轮正常跑过（起步晚 8 秒），本轮 due 后 10 分钟仍在排队 ⇒ 不是缺陷
    // 旧判据（lastRun < prev1 - 30min）在这里必红：11:15:08 < 12:15-30min
    ["inflight-hourly", {
      jobs: [mk("h1", { cron: "15 * * * *", tz: "UTC", lastRun: new Date(hourly.p2 + 8_000).toISOString(), status: "scheduled" })],
      wantStale: 0, wantUnparseable: 0, nowMs: hourly.p1 + 10 * 60_000,
    }],
    // 同一份夹具，只把「上一轮」换成 24h 前 ⇒ 漏了整轮，必须红
    ["hourly-missed-cycle", {
      jobs: [mk("h2", { cron: "15 * * * *", tz: "UTC", lastRun: new Date(hourly.p2 - 24 * 3_600_000).toISOString(), status: "scheduled" })],
      wantStale: 1, wantUnparseable: 0, wantWhy: "missed-cycle", nowMs: hourly.p1 + 10 * 60_000,
    }],
    // 日频：上一轮跑过、本轮 due 已过 60 分钟仍没起步 ⇒ 红（why 必须点到这一档）
    ["daily-fire-never-started", {
      jobs: [mk("d1", { cron: "0 9 * * *", tz: "UTC", lastRun: new Date(daily.p2).toISOString(), status: "scheduled" })],
      wantStale: 1, wantUnparseable: 0, wantWhy: "fire-never-started", nowMs: daily.p1 + 60 * 60_000,
    }],
    // 同一份夹具，本轮 due 只过了 20 分钟（在 45 分钟排队预算内）⇒ 绿
    ["daily-within-latency-budget", {
      jobs: [mk("d2", { cron: "0 9 * * *", tz: "UTC", lastRun: new Date(daily.p2).toISOString(), status: "scheduled" })],
      wantStale: 0, wantUnparseable: 0, nowMs: daily.p1 + 20 * 60_000,
    }],
  ];
  let failed = 0;
  for (const [name, c] of cases) {
    const dir = path.join(tmp, name.replace(/[^a-z0-9-]/g, "_"), "data", "cron-store");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "jobs.json"), JSON.stringify(c.jobs));
    const out = { scanned: 0, recurring: 0, stale: [], unparseable: [], notDue: 0, skippedPaused: 0, skippedCapped: 0, skippedRetired: 0 };
    scanJobs(c.jobs, c.nowMs ?? nowMs, out);
    const okStale = out.stale.length === c.wantStale;
    const okUnparseable = out.unparseable.length === c.wantUnparseable;
    // why 必须点对档：只判 0/1 的话，把两条判据合并成一条（就是这次的 bug）也一路绿
    const okWhy = !c.wantWhy || (out.stale[0] && out.stale[0].why === c.wantWhy);
    if (okStale && okUnparseable && okWhy) {
      console.log(`  ✓ ${name}`);
    } else {
      failed++;
      const got = out.stale[0]?.why ?? "(none)";
      console.log(`  ✗ ${name}: stale=${out.stale.length}(want ${c.wantStale}) unparseable=${out.unparseable.length}(want ${c.wantUnparseable}) why=${got}(want ${c.wantWhy ?? "*"})`);
    }
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  if (failed) { console.log(`self-test: ${failed} failed`); process.exit(1); }
  console.log("self-test: all green");
}

const args = process.argv.slice(2);
const nowMs = Date.now();
if (args.includes("--self-test")) { selfTest(); process.exit(0); }

let out;
const jobsFiles = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--jobs-file") jobsFiles.push(args[++i]);
}
if (jobsFiles.length) {
  out = { scanned: 0, recurring: 0, stale: [], unparseable: [], notDue: 0, skippedPaused: 0, skippedCapped: 0, skippedRetired: 0 };
  for (const f of jobsFiles) {
    const d = JSON.parse(fs.readFileSync(f, "utf8"));
    scanJobs(Array.isArray(d) ? d : (d.jobs || []), nowMs, out);
  }
} else {
  const root = args.includes("--root") ? args[args.indexOf("--root") + 1] : "/data/cells";
  if (!fs.existsSync(root)) {
    console.error(`判不出：${root} 不存在（容器里跑才默认这个路径；本机用 --jobs-file）`);
    process.exit(2);
  }
  out = scanRoot(root, nowMs);
}
print(out);
process.exit(out.stale.length || out.unparseable.length ? 1 : 0);
