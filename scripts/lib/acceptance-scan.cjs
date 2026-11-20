#!/usr/bin/env node
// Read-only acceptance scan for the investment fleet (Monday tick).
//
// Why this file exists: the 11-15 reports documented a `monday-acceptance.sh`
// with ①–⑧ checks and recorded it as "实跑", but nothing of it existed on any
// ref — every reading came from hand-run probes that left no artifact. A gate
// that lives only in a transcript cannot be re-run on the morning it decides
// something, which is exactly the morning it is needed. This is the file
// version; scripts/monday-acceptance.sh wraps it (first screen + pod plumbing).
//
// Contract:
//   node acceptance-scan.js --scan [--root /data] [--now ISO8601]
//   node acceptance-scan.js --self-test
// Exit codes: 0 = every judged reading is good, 1 = at least one ✗,
//             2 = 判不出 (cannot read the platform's own persistence).
//
// Read paths (verified 2026-11-15, see the report's §7 references):
//   jobs         <cell>/data/cron-store/jobs.json   (task-engine, NOT sqlite)
//   fleets+dbs   <cell>/data/data/fleets.db         (fleet_members, member_turn_events, member_reports)
// There is no `settlements` table in this repo: settlement is fd-quant's own
// ledger, and its first due date is 11-20 — before then "0 settlements" is the
// correct reading, so this scan prints it as a fact and does not judge it.
'use strict';

const fs = require('fs');
const path = require('path');

const GRACE_MIN = 60; // measured: a tick can start +39min late behind the cell's serial slot
const STUCK_MS = 45 * 60e3; // 3x the largest turn budget (900s): past this an open history row is stuck, not running
const MAX_LATE_MS = 180 * 60e3; // outside this, a run belongs to another tick, not this one
const LOOKBACK_MS = 120e3; // a run recording itself slightly before its tick still belongs to it
const TZ_DEFAULT = 'Asia/Shanghai'; // cron is rendered in CST for this fleet

// Sections whose fix is not shipped yet. Same discipline as check_line_endpoints'
// KNOWN_GAPS: only "verified missing + reason written down in the repo", it still
// prints every line, it just does not set the exit code. Delete the entry the day
// the fix lands — that is what turns the section red again.
const KNOWN_OPEN = {
  kpi_slots: 'W1-1b 未上产（重启清单 B1 未执行）；目标 ≥3 个数字',
  provenance: 'W1-1 未上产（报告 resources 仍为空）',
};

// ── cron (enough for `m h * * dow` shapes, evaluated in the fleet's tz) ──────
function parseField(spec, lo, hi) {
  const out = new Set();
  for (const part of String(spec).split(',')) {
    const [range, stepRaw] = part.split('/');
    const step = stepRaw ? Number(stepRaw) : 1;
    if (!step || step < 1) return null;
    let start;
    let end;
    if (range === '*') { start = lo; end = hi; } else if (range.includes('-')) {
      const [a, b] = range.split('-').map(Number);
      start = a; end = b;
    } else { start = Number(range); end = Number(range); }
    if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
    if (start < lo || end > hi || start > end) return null;
    for (let v = start; v <= end; v += step) out.add(v);
  }
  return out.size ? out : null;
}

function parseCron(cron) {
  const parts = String(cron || '').trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const mins = parseField(parts[0], 0, 59);
  const hours = parseField(parts[1], 0, 23);
  const doms = parseField(parts[2], 1, 31);
  const months = parseField(parts[3], 1, 12);
  const dows = parseField(parts[4], 0, 6);
  if (!mins || !hours || !doms || !months || !dows) return null;
  return { mins, hours, doms, months, dows };
}

// Local wall-clock parts for a UTC instant in `tz`.
function localParts(ms, tz) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'short',
  });
  const p = {};
  for (const { type, value } of f.formatToParts(new Date(ms))) p[type] = value;
  const dowMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    minute: Number(p.minute), hour: Number(p.hour) % 24,
    dom: Number(p.day), month: Number(p.month), dow: dowMap[p.weekday],
  };
}

function cronMatches(c, ms, tz) {
  if (!c) return false;
  const p = localParts(ms, tz);
  const domOk = c.doms.has(p.dom);
  // Standard cron semantics: when BOTH dom and dow are restricted, either may match.
  const dowOk = c.dows.has(p.dow);
  const domRestricted = !(c.doms.size === 31);
  const dowRestricted = !(c.dows.size === 7);
  const dayOk = domRestricted && dowRestricted ? (domOk || dowOk) : (domOk && dowOk);
  return c.mins.has(p.minute) && c.hours.has(p.hour) && c.months.has(p.month) && dayOk;
}

// The most recent scheduled instant at or before `nowMs` (null if none in 8d).
function lastTickMs(cron, nowMs, tz = TZ_DEFAULT) {
  const c = parseCron(cron);
  if (!c) return null;
  const start = Math.floor(nowMs / 60e3) * 60e3;
  for (let i = 0; i <= 8 * 24 * 60; i += 1) {
    const ms = start - i * 60e3;
    if (cronMatches(c, ms, tz)) return ms;
  }
  return null;
}

function nextTickMs(cron, nowMs, tz = TZ_DEFAULT) {
  const c = parseCron(cron);
  if (!c) return null;
  const start = Math.ceil(nowMs / 60e3) * 60e3;
  for (let i = 0; i <= 8 * 24 * 60; i += 1) {
    const ms = start + i * 60e3;
    if (cronMatches(c, ms, tz)) return ms;
  }
  return null;
}

const iso = (v) => (v == null ? '—' : typeof v === 'number' ? new Date(v).toISOString() : String(v));
const short = (v) => (v == null ? '—' : iso(v).replace('T', ' ').replace(/:\d\d\.\d+Z$/, 'Z').replace(/Z$/, 'Z'));

// ── judging: pure functions over already-read rows (so the self-test needs no db) ──

// One scheduled role: did THAT tick run, did a turn row appear, did a report land?
// The distinction that matters (§7.29): a manual/catch-up run also writes
// lastRun, so "lastRun is recent" never proves the scheduled tick ran. Only a
// history entry at/after the tick does.
function judgeRole({ role, memberId, jobId }, ctx) {
  const { nowMs, jobs, turns, reports, tickMs, podStartMs = null, budgetMs = null } = ctx;
  const stuckMs = Math.max(2 * (budgetMs || 900e3), 20 * 60e3);
  const out = [];
  let hit = 0; let warn = 0; let undet = 0;
  const job = jobs.find((j) => j.id === jobId);
  const memberTurns = turns.filter((t) => t.member_id === memberId);
  const memberReports = reports.filter((r) => r.member_id === memberId);

  if (!job) {
    out.push(`  ✗ ${role}: 作业 ${jobId} 不在 jobs.json 里（派发面没有它）`);
    return { lines: out, hit: 1, warn: 0, undet: 0 };
  }
  // Attribution window for one tick: [tick - 2min, tick + MAX_LATE_MS].
  // Measured on 11-13 (real data): 行业's 01:10 tick started at 01:49 (+39min)
  // and 宏观's 01:00 tick at 01:25 — a tick legitimately starts late while it
  // waits behind the cell's serial slot, so "started 39min late" must still be
  // attributed to its own tick. The upper bound is what keeps a catch-up run on
  // a later day OUT: 首席's Friday 01:30 tick has no record, and its
  // 11-15T00:52 run (a cell_restart, not a scheduled fire) would otherwise be
  // read as "Friday ran" — the exact misread §4.2 warns about.
  const windowEnd = tickMs + MAX_LATE_MS;
  const hist = (job.history || []).filter((h) => {
    const t = Date.parse(h.time);
    return t >= tickMs - LOOKBACK_MS && t <= windowEnd;
  });
  const last = hist.length ? hist[hist.length - 1] : null;
  const tooEarly = nowMs < tickMs + GRACE_MIN * 60e3;
  let tickOk = false;

  const terminal = last && (last.state === 'done' || last.state === 'failed' || last.state === 'skipped');
  if (last && !terminal) {
    const running = nowMs - Date.parse(last.time);
    const startedAt = Date.parse(last.time);
    if (podStartMs && podStartMs > startedAt) {
      out.push(`  ✗ ${role}: ${short(tickMs)} 那轮被 pod 滚动打断（那一轮起于 ${short(startedAt)}，当前 pod 起于 ${short(podStartMs)}，无终态）`);
      out.push(`    · 处置：这一轮的工作没发生，按 §7.40 手工补跑（\`queuedBy=human\` 的轮次不会老化），别等下一轮自动补`);
      hit += 1;
    } else if (running < stuckMs) {
      tickOk = true; // its outcome is not in yet; do not invent a failure
      out.push(`  · ${role}: ${short(tickMs)} 那轮仍在跑（已 ${Math.round(running / 60e3)} 分钟，无终态）——不判，稍后重跑本闸`);
    } else {
      out.push(`  ✗ ${role}: ${short(tickMs)} 那轮起了 ${Math.round(running / 60e3)} 分钟仍无终态（该岗预算 ${Math.round((budgetMs || 900e3) / 1000)}s，超过两倍＝卡死；soft stop 没生效或它在排队）`);
      hit += 1;
    }
  } else if (last) {
    const okRun = last.success === true || last.state === 'done';
    if (okRun) {
      tickOk = true;
      out.push(`  ✓ ${role}: ${short(tickMs)} 那轮跑了（${last.state}，${Math.round((last.duration || 0) / 1000)}s）`);
    } else {
      // skipped-by-staleness is a lost round, not a soft signal: the tick's work
      // never happened and nothing will catch it up.
      out.push(`  ✗ ${role}: ${short(tickMs)} 那轮 ${last.state} —— ${String(last.error || '无原文').slice(0, 150)}`);
      hit += 1;
    }
  } else if (tooEarly) {
    out.push(`  · ${role}: ${short(tickMs)} 那轮到点还没过宽限（+${GRACE_MIN}min），不判`);
  } else {
    out.push(`  ✗ ${role}: ${short(tickMs)} 那个排期 tick 在其后 ${Math.round(MAX_LATE_MS / 60e3)} 分钟内没有任何 history 记录（作业 paused=${job.paused}, state=${job.state}, lastRun=${short(job.lastRun)}）`);
    hit += 1;
    // "no record" has two readings with opposite fixes: never dispatched (look at
    // the dispatcher) vs queued out (look at the lane). The job's own recent
    // non-successes is the evidence that tells them apart — 首席's history shows
    // three consecutive weekdays skipped for queue staleness, which is why the
    // missing tick is a symptom rather than its own fault.
    const misses = (job.history || []).filter((h) => !(h.success === true || h.state === 'done')).slice(-3);
    if (misses.length) {
      out.push(`    · 该作业最近 ${misses.length} 条非成功：${misses.map((h) => `${short(h.time)} ${h.state || '无状态'}${h.error ? `(${String(h.error).slice(0, 46)}…)` : ''}`).join(' | ')}`);
    }
  }

  // Turn / report only count as evidence of THIS tick when they fall in the
  // same window, and they must not be counted as separate hits after the tick
  // itself already failed — one problem is one hit (a gate that reports the
  // same fault three times gets triaged as three faults, then ignored).
  const inWindow = (ms) => ms >= tickMs - LOOKBACK_MS && ms <= windowEnd;
  const turnsIn = memberTurns.filter((t) => inWindow(Number(t.started_at)));
  const reportsIn = memberReports.filter((r) => inWindow(Number(r.created_at)));

  const stillRunning = !!(last && !terminal);
  if (stillRunning) {
    out.push(`    · 回合 ${turnsIn.length} 行、报告 ${reportsIn.length} 份（该轮未收尾，不判）`);
  } else if (tickOk) {
    let turnOk = false;
    if (turnsIn.length) {
      const t = turnsIn[turnsIn.length - 1];
      const label = `回合 ${t.status}${t.error_kind ? `/${t.error_kind}` : ''}`;
      if (t.status === 'ok') { turnOk = true; out.push(`  ✓ ${role}: ${label}（${short(Number(t.ended_at))}）`); }
      else { out.push(`  ✗ ${role}: ${label} —— ${String(t.error || t.detail || '无原文').slice(0, 150)}`); hit += 1; }
    } else {
      out.push(`  ✗ ${role}: 作业说跑了，回合表这一窗口内一行都没有（派发面与回合面不一致）`);
      hit += 1;
    }
    if (reportsIn.length) {
      const r = reportsIn[reportsIn.length - 1];
      const res = safeArray(r.resources);
      out.push(`  ✓ ${role}: 报告落地（${short(Number(r.created_at))}，resources ${res.length} 条，metrics ${Object.keys(safeObj(r.metrics)).length} 键）`);
    } else if (turnOk) {
      // Only a GOOD turn makes a missing report its own fault; after a failed or
      // absent turn the missing report is the same fault seen twice.
      out.push(`  ✗ ${role}: 回合 ok 但这一窗口内没有报告落地`);
      hit += 1;
    } else {
      out.push(`  · ${role}: 这一窗口内没有报告（回合本身已计入上面那条，不重复计）`);
    }
  } else if (!tooEarly) {
    // Facts only — the tick itself is already the hit. Printing these as ✗
    // would turn one lost tick into three independent alarms.
    out.push(`  · ${role}: 同窗口内回合 ${turnsIn.length} 行、报告 ${reportsIn.length} 份（tick 本身已计入上面那条，不重复计）`);
  }
  void warn; void undet;
  return { lines: out, hit, warn, undet };
}

// Hourly role (常务 `50 * * * *`): one lost fire is a flake; a lane that loses
// a quarter of a day's fires is a lane problem. Judging "2 of the last 4" alone
// would flip red/green every hour, and a flapping gate is read as noise.
function judgeHourly({ role, jobId, recentN = 4, dayH = 24 }, ctx) {
  const out = [];
  let hit = 0; let warn = 0;
  const job = (ctx.jobs || []).find((j) => j.id === jobId);
  if (!job) {
    out.push(`  ✗ ${role}: 作业 ${jobId} 不在 jobs.json 里`);
    return { lines: out, hit: 1, warn: 0, undet: 0 };
  }
  const nowMs = ctx.nowMs ?? Date.now();
  const hist = job.history || [];
  const dayAgo = nowMs - dayH * 3600e3;
  const day = hist.filter((h) => Date.parse(h.time) >= dayAgo);
  const dayLost = day.filter((h) => !(h.success === true || h.state === 'done'));
  const recent = hist.slice(-recentN);
  const burst = recent.filter((h) => !(h.success === true || h.state === 'done'));
  if (!day.length) {
    out.push(`  · ${role}: 近 ${dayH}h 没有 history 可判（判不出，不装绿）`);
    return { lines: out, hit: 0, warn: 0, undet: 1 };
  }
  const ratio = dayLost.length / day.length;
  if (dayLost.length >= 2 && ratio > 0.25) {
    out.push(`  ✗ ${role}: 近 ${dayH}h ${day.length} 轮丢 ${dayLost.length} 轮（${Math.round(ratio * 100)}% > 25%）`);
    for (const h of dayLost.slice(-4)) out.push(`      · ${short(h.time)} ${h.state} — ${String(h.error || '无原文').slice(0, 120)}`);
    hit += 1;
  } else if (burst.length >= 2) {
    out.push(`  ⚠ ${role}: 最近 ${recent.length} 轮丢 ${burst.length} 轮（突发，未达全天 25% 门槛）`);
    for (const h of burst) out.push(`      · ${short(h.time)} ${h.state} — ${String(h.error || '无原文').slice(0, 120)}`);
    warn += 1;
  } else {
    out.push(`  ✓ ${role}: 近 ${dayH}h ${day.length} 轮丢 ${dayLost.length} 轮（最近 ${recent.length} 轮丢 ${burst.length}）`);
  }
  out.push(`  · ${role}: missed=${job.missed ?? 0} state=${job.state} nextRun=${short(job.nextRun)}`);
  return { lines: out, hit, warn, undet: 0 };
}


// Slot coverage: the card shows a number only when the slot is declared.
function judgeSlots(members, ctx) {
  const out = [];
  let hit = 0;
  const deputy = members.find((m) => /常务/.test(m.title || ''));
  if (!deputy) {
    out.push('  ✗ 常务岗不在成员表里');
    return { lines: out, hit: 1, warn: 0, undet: 0 };
  }
  const slots = safeArray(deputy.kpi_slots);
  const names = slots.map((s) => (typeof s === 'string' ? s : s && s.key) || '?');
  const known = KNOWN_OPEN.kpi_slots;
  if (slots.length >= 3) {
    out.push(`  ✓ 常务卡槽 ${slots.length} 个：${names.join(' / ')}`);
  } else {
    out.push(`  ${known ? '⚠' : '✗'} 常务卡槽 ${slots.length} 个：${names.join(' / ') || '（无）'}${known ? ` —— 已知未交付：${known}` : ''}`);
    if (!known) hit += 1;
  }
  void ctx;
  return { lines: out, hit, warn: known ? 1 : 0, undet: 0 };
}

// Provenance: a report without `resources` cannot be checked by anyone later.
//
// Lane capacity — THE DENOMINATOR IS THE LANE WIDTH, NOT ONE SLOT.
// `server/worker-slots.js` runs up to `TASK_WORKER_MAX` turns in parallel
// (persona-pinned, each worker ≈ one `server.js` child + one dsh child); at
// `0`/unset the pool never activates and the cell really is serial. Measured in
// the live cell on 2026-11-16: `TASK_WORKER_MAX=4`, `TURN_DISPATCH=concurrent`,
// `DSH_MATRIX_CLOSE_INTERLEAVE=1`, and 232/232 real turns went through the pool
// while the pre-emptive lane served none.
//
// The first version of this criterion divided by 3600s flat and reported
// "355% of one serial slot" for a cell that was at 95% of a 4-wide pool. That is
// a false verdict in the worst direction: it tells the owner to 拆 cell / 降频
// (business changes) when the honest reading is "peak hour full, 6h average 71%".
// A demand ratio above 100% here means the lane genuinely cannot serve it; below
// 100% the drops are a *scheduling* symptom (persona affinity, per-fleet cap,
// wasted slot time), not an arithmetic impossibility.
//
// Second correction in the same pass: a job with no `preset` cannot enter the
// pool at all (`scheduleNext`: `if (!persona) return false`), so the two lanes
// must be judged separately — otherwise wide-pool capacity would mask a serial
// lane that is truly oversubscribed.
function laneWidth(env = process.env) {
  const raw = Number(env.TASK_WORKER_MAX);
  if (!Number.isFinite(raw) || raw <= 0) return 1; // pool off ⇒ the cell's own lane is serial
  return Math.floor(raw);
}

function judgeLaneCapacity(jobs, { hours = 6, nowMs = Date.now(), width = null } = {}) {
  const out = [];
  const poolWidth = Number.isFinite(width) && width > 0 ? Math.floor(width) : laneWidth();
  const lanes = new Map(); // laneName → {width, buckets:Map}
  const laneOf = (j) => (j.preset ? 'worker 池' : 'cell 串行');
  const laneWidthOf = (name, w) => (name === 'worker 池' ? w : 1);
  const currentHour = new Date(nowMs).toISOString().slice(0, 13);
  const windowStart = nowMs - hours * 3600e3;
  // Partial hours at EITHER edge under-report: the current hour has not finished,
  // and the oldest hour starts before the window. Counting them silently lowers
  // the demand ratio, which is the direction that hides the problem.
  const edgeHour = new Date(windowStart).toISOString().slice(0, 13);
  for (const j of jobs) {
    const name = laneOf(j);
    let lane = lanes.get(name);
    if (!lane) { lane = { width: laneWidthOf(name, poolWidth), buckets: new Map() }; lanes.set(name, lane); }
    for (const h of (j.history || [])) {
      const t = Date.parse(h.time);
      if (!t || t < nowMs - hours * 3600e3 || t >= nowMs) continue;
      const hr = new Date(t).toISOString().slice(0, 13);
      if (hr === currentHour || hr === edgeHour) continue; // partial hour
      let b = lane.buckets.get(hr);
      if (!b) { b = { secs: 0, failSecs: 0, runs: 0, skipped: 0, failed: 0, per: new Map(), perFail: new Map() }; lane.buckets.set(hr, b); }
      const secs = Math.round((h.duration || 0) / 1000);
      b.runs += 1;
      b.secs += secs;
      const key = String(j.id).slice(-6);
      b.per.set(key, (b.per.get(key) || 0) + secs);
      const bad = h.state && h.state !== 'done' && h.state !== 'skipped';
      if (bad) {
        let pf = b.perFail.get(key);
        if (!pf) { pf = { failed: 0, failSecs: 0, softStop: 0 }; b.perFail.set(key, pf); }
        pf.failed += 1;
        pf.failSecs += secs;
        if (/soft stop/i.test(String(h.error || ''))) pf.softStop += 1;
      }
      if (h.state === 'skipped') b.skipped += 1;
      else if (bad) { b.failed += 1; b.failSecs += secs; }
    }
  }
  const summaries = [];
  for (const [name, lane] of lanes) {
    const rows = [...lane.buckets.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
    if (!rows.length) continue;
    const cap = 3600 * lane.width;
    const worst = rows.reduce((a, r) => (r[1].secs > a[1].secs ? r : a), rows[0]);
    summaries.push({
      name,
      width: lane.width,
      rows,
      worst,
      pct: Math.round((worst[1].secs / cap) * 100),          // % of this lane's capacity
      rawPct: Math.round((worst[1].secs / 3600) * 100),        // % of wall clock (the old, wrong denominator)
      avg: Math.round(rows.reduce((a, r) => a + r[1].secs, 0) / rows.length / (cap / 100)),
      failShare: worst[1].secs ? Math.round((worst[1].failSecs / worst[1].secs) * 100) : 0,
      burners: worst[1].perFail,
    });
  }
  const complete = summaries.length ? Math.max(...summaries.map((s) => s.rows.length)) : 0;
  if (complete < 2) {
    out.push('  · 回合道容量：完整小时不足 2 个，判不出');
    return { lines: out, hit: 0, warn: 0, undet: 1 };
  }
  const detail = summaries.map((s) => `${s.name}（宽 ${s.width}）${s.rows.map(([hr, b]) => `${hr.slice(11)}Z ${Math.round((b.secs / (3600 * s.width)) * 100)}%`).join('/')}`).join('；');
  const hitLanes = summaries.filter((s) => s.pct > 100);
  const warnLanes = summaries.filter((s) => s.pct <= 100 && s.avg > 80);
  let hit = 0; let warn = 0;
  if (hitLanes.length) {
    const s = hitLanes[0];
    out.push(`  ✗ 回合道超订：${s.name} 最忙一小时要 ${s.rawPct}% 的墙上时间，而这条道只有 ${s.width} 条并发 ⇒ ${s.pct}% 容量（${detail}）`);
    out.push(`    ⇒ 这条道装不下：排队超过 10 分钟的轮次必然被丢、长回合必然被 soft stop。上面每一条「被丢」都是这一个事实，不是各自的故障。`);
    hit += 1;
  } else if (warnLanes.length) {
    const s = warnLanes[0];
    out.push(`  ⚠ 回合道接近饱和：${s.name}（宽 ${s.width}）平均 ${s.avg}%、最忙 ${s.pct}%（${detail}）`);
    warn += 1;
  } else {
    const s = summaries.reduce((a, b) => (b.avg > a.avg ? b : a), summaries[0]);
    out.push(`  ✓ 回合道有余量：最紧的是 ${s.name}（宽 ${s.width}）平均 ${s.avg}%、最忙 ${s.pct}%（${detail}）`);
  }
  const pool = summaries.find((s) => s.name === 'worker 池');
  const serial = summaries.find((s) => s.name === 'cell 串行');
  if (serial && serial.width === 1 && serial.pct > 0) {
    out.push(`    · cell 串行道（无 preset 的作业进不了 worker 池——\`scheduleNext\`: \`if (!persona) return false\`）最忙 ${serial.pct}%`);
  }
  const busy = pool || summaries[0];
  const top = [...busy.worst[1].per.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4)
    .map(([id, secs]) => `${id}(${secs}s)`).join(' ');
  out.push(`    · 最忙那小时的占用前四：${top}`);
  // Wasted slot time is recoverable capacity: a turn that runs out its whole
  // budget and fails still occupies a worker for 8-10 minutes. Reported with the
  // NAMES, because "55% is wasted" is not actionable and "these 3 members are
  // the 55%" is (measured 2026-11-16: 9 patrol jobs, each 3-4 soft-stops in 6h,
  // prompting the same derived 382-char template).
  if (busy.failShare >= 10) {
    out.push(`    · 那小时 ${busy.failShare}% 的槽时间花在 failed 回合上（多为 budget soft stop）——这部分是可以立刻收回的容量，先收它再加池。`);
    const burners = [...busy.burners.entries()]
      .sort((a, b) => b[1].failSecs - a[1].failSecs)
      .filter(([, b]) => b.failSecs > 0)
      .slice(0, 3)
      .map(([id, b]) => `${id}(${b.failed} 次失败/${Math.round(b.failSecs)}s${b.softStop ? `，soft stop ${b.softStop}` : ''})`);
    if (burners.length) {
      out.push(`    · 烧槽的前三：${burners.join(' · ')} —— 处置是改**成员**（prompt/工作范围），改作业行会被 reconcile 覆盖`);
    }
  }
  out.push(`    · 处置顺序：① 收回 failed 回合的槽时间 ② 加池（\`TASK_WORKER_MAX\`，一个 worker 约 400MB）③ 降频。抬排队阈值不在选项里——它只会让更旧的轮次读到过期数据。`);
  return { lines: out, hit, warn, undet: 0 };
}

// Dropped cadence fires — the loss the capacity numbers above CANNOT show.
//
// A `queue staleness` skip means the fire never ran at all. That is a different
// loss from a failed turn: a failed turn spent its budget and usually still
// landed (or salvaged) a report, while a dropped fire produces nothing and is
// never retried (`the next cadence fire supersedes it`). It is also invisible to
// every duration-based ratio: a drop carries `duration ≈ 0`, so `Σ duration /
// 3600×width` does not contain it. Measured 2026-11-16 on cell 1da519d4c1c0bf89:
// occupancy 85–100% on the same 6h window while eight hourly duties were dropped
// inside one minute (12:22Z, 11min waits) and two had waited 48/53min at 12:12Z.
//
// The engine's own wording is misleading, and repeating it silently is how the
// wrong repair gets chosen: `task-engine.js` says "behind the cell's serial
// slot", but a job WITH a `preset` cannot use the serial lane at all
// (`scheduleNext`: `if (!persona) return false`) — it queues behind the worker
// pool. Reading that sentence literally is what made an earlier pass of this
// report recommend 拆 cell, which is structurally impossible (`userIdFor(email)`
// ⇒ one owner, one cell) and the wrong lever regardless.
//
// Severity: a drop on its own is BY DESIGN (the bound is a patience limit, not a
// capacity). What is not by design is losing a third of a job's fires, or one
// fire waiting 3× the bound — at that point the duty is not happening at its
// cadence, which is the thing the fleet exists to do.
const DROP_BOUND_MIN = 10; // QUEUE_MAX_AGE_MS default, used only when a row omits `(>Nmin)`

function judgeDroppedFires(jobs, { hours = 6, nowMs = Date.now(), width = null, laneHit = false } = {}) {
  const out = [];
  const poolWidth = Number.isFinite(width) && width > 0 ? Math.floor(width) : laneWidth();
  const from = nowMs - hours * 3600e3;
  const all = new Map();   // id → fires in window
  const drops = new Map(); // id → { dropped, maxWait, boundMin, preset }
  const perMin = new Map(); // 'HH:MM' (UTC, full stamp) → { presets:Set, crons:Set, fires, dropped }
  let scanned = 0;
  for (const j of jobs) {
    const key = String(j.id).slice(-6);
    const persona = j.preset || '(none)';
    for (const h of (j.history || [])) {
      const t = Date.parse(h.time);
      if (!t || t < from || t >= nowMs) continue;
      scanned += 1;
      all.set(key, (all.get(key) || 0) + 1);
      const stamp = new Date(Math.floor(t / 60000) * 60000).toISOString().slice(0, 16);
      let m0 = perMin.get(stamp);
      if (!m0) { m0 = { presets: new Set(), crons: new Set(), fires: 0, dropped: 0 }; perMin.set(stamp, m0); }
      m0.presets.add(persona);
      m0.crons.add(String(j.cron || '?'));
      m0.fires += 1;
      const m = /queue staleness: a scheduled fire waited (\d+)min/.exec(String(h.error || ''));
      if (!m) continue;
      m0.dropped += 1;
      let d = drops.get(key);
      if (!d) { d = { dropped: 0, maxWait: 0, boundMin: DROP_BOUND_MIN, preset: Boolean(j.preset), catchUp: 0, fresh: 0, unattributed: 0 }; drops.set(key, d); }
      d.dropped += 1;
      // Kind, so the two losses are not added together: a dropped CATCH-UP round is a
      // make-up that never ran (the beat was already missed once), while a dropped
      // FRESH round means the duty did not happen at its scheduled time. Measured
      // 2026-11-17 (48h): 205 dropped — 113 carry `catchUp: true`, 92 carry nothing.
      // `finishExecution` only writes the key when it is TRUE, so "absent" is
      // ambiguous between "fresh" and "row written by an older build" ⇒ absence is
      // counted as unattributed and named as such, never silently read as fresh.
      // (That inference-by-absence is exactly the shape that inverts a verdict once a
      // writer starts writing explicit falses.)
      if (h.catchUp === true) d.catchUp += 1;
      else if (h.catchUp === false) d.fresh += 1;
      else d.unattributed += 1;
      d.maxWait = Math.max(d.maxWait, Number(m[1]) || 0);
      const b = /\(>(\d+)min\)/.exec(String(h.error || ''));
      if (b) d.boundMin = Number(b[1]) || DROP_BOUND_MIN;
    }
  }
  const dropped = [...drops.values()].reduce((s, d) => s + d.dropped, 0);
  if (!dropped) {
    out.push(`  ✓ 排期轮次没有在队列里过期作废（窗口 ${hours}h 内 ${scanned} 轮排期，0 轮被丢）`);
    return { lines: out, hit: 0, warn: 0, undet: 0 };
  }
  const ranked = [...drops.entries()]
    .sort((a, b) => (b[1].dropped - a[1].dropped) || (b[1].maxWait - a[1].maxWait));
  const kindSum = ranked.reduce((s, [, d]) => ({
    catchUp: s.catchUp + d.catchUp, fresh: s.fresh + d.fresh, unattributed: s.unattributed + d.unattributed,
  }), { catchUp: 0, fresh: 0, unattributed: 0 });
  const kindNote = '    · 按种类分：新鲜轮次 ' + kindSum.fresh + ' 轮、补跑 ' + kindSum.catchUp + ' 轮'
    + (kindSum.unattributed ? ('、未归因 ' + kindSum.unattributed + ' 轮（该行没有 kind 字段——旧版写的行与新鲜轮次在数据上分不出来）') : '')
    + '；丢一轮补跑的代价小于丢一轮新鲜轮次（前者那一次本来已经错过了）。';
  const severe = ranked.some(([id, d]) => {
    const fires = all.get(id) || d.dropped;
    return d.maxWait >= 3 * d.boundMin || d.dropped / fires >= 1 / 3;
  });
  const names = ranked.slice(0, 3)
    .map(([id, d]) => `${id}(丢 ${d.dropped}/${all.get(id) || d.dropped} 轮，最长等 ${d.maxWait}min)`).join(' · ');
  // Say which lane actually held them. Without this line the reader keeps the
  // engine's wording ("the cell's serial slot") and reaches for the wrong lever.
  const pooled = ranked.filter(([, d]) => d.preset).length;
  const serialOnly = ranked.length - pooled;
  out.push('    · 引擎文案写的是「排在 cell 的串行槽后面」，但带 preset 的作业排在 worker 池（宽 '
    + poolWidth + '）后面（' + pooled + ' 个是池里的'
    + (serialOnly ? ('、' + serialOnly + ' 个确实没 preset 才走串行槽') : '')
    + '）——照那句字面去拆 cell 是错的方向（结构上也不可行：一个 owner 一个 cell）。');
  // Demand side, which the occupancy ratio cannot see: the pool is 4 wide, but a
  // minute can ask for twelve DIFFERENT personas. Measured 2026-11-16 (24h):
  // minutes with ≥5 distinct personas dropped 57% of their fires (37/65), minutes
  // with ≤4 dropped 14% (118/870) — while the HOUR averaged 44% occupancy. The
  // average is the wrong lens for a burst, and the burst is what loses duties.
  //
  // And the burst has a signature: 11 hourly jobs whose crons are 0/5/10/15/20/
  // 25/30/40/45/50/55 all fired inside 12:11Z — minutes that are supposed to be
  // spread carried every one of them. That is overdue cadence fires released
  // together after a stall (catch-up), not steady-state concurrency, and the two
  // have different first moves (find the stall / coalesce the catch-up vs widen
  // the pool), so they are named separately instead of averaged.
  const mins = [...perMin.entries()];
  const peakMin = mins.reduce((a, b) => (b[1].presets.size > a[1].presets.size ? b : a), mins[0]);
  const overWidth = mins.filter(([k, m]) => m.presets.size > poolWidth);
  const underWidth = mins.filter(([k, m]) => m.presets.size <= poolWidth);
  const sumOf = (xs, f) => xs.reduce((s, [, m]) => s + f(m), 0);
  const demandNotes = [];
  if (peakMin && peakMin[1].presets.size > poolWidth) {
    const p = peakMin[1];
    demandNotes.push('    · 起火最挤的一分钟是 ' + peakMin[0].slice(11) + 'Z：' + p.presets.size
      + ' 款不同人格（来自 ' + p.crons.size + ' 个不同 cron）同时排队，而池宽只有 ' + poolWidth);
    const oTot = sumOf(overWidth, (m) => m.fires); const oDrop = sumOf(overWidth, (m) => m.dropped);
    const uTot = sumOf(underWidth, (m) => m.fires); const uDrop = sumOf(underWidth, (m) => m.dropped);
    demandNotes.push('    · 同分钟超过池宽的轮次丢 ' + oDrop + '/' + oTot + '（'
      + Math.round(100 * oDrop / (oTot || 1)) + '%），池宽以内丢 ' + uDrop + '/' + uTot + '（'
      + Math.round(100 * uDrop / (uTot || 1)) + '%）——平均占用率看不到这个差别。');
    if (p.crons.size >= 3) {
      demandNotes.push('    · 那 ' + p.crons.size + ' 个 cron 本该落在不同的分钟，却挤在同一分钟 ⇒ 这是**补跑堆积**'
        + '（停摆后把逾期轮次一次放出），不是稳态并发；处置先查那段停摆（`pod logs` 里的 watchdog / OOM / 重启），再谈加池。');
    }
  }
  // One problem, one hit: an oversubscribed lane already explains these drops,
  // so the lane verdict above carries the hit and this stays a ⚠. Counting both
  // would double the same fact, and a doubled count is what a reader stops trusting.
  if (severe && laneHit) {
    out.push(`  ⚠ 排期轮次被丢弃：窗口 ${hours}h 内 ${dropped} 轮从未跑过（${names}）——与上面的超订是同一条事实，不重复计命中`);
    out.push(kindNote);
    out.push(...demandNotes);
    return { lines: out, hit: 0, warn: 1, undet: 0 };
  }
  if (severe) {
    out.push(`  ✗ 排期轮次被丢弃：窗口 ${hours}h 内 ${dropped} 轮排期从未跑过（${names}）`);
    out.push('    ⇒ 这不是「跑得慢」，是「这一岗那一轮没做」：失败回合至少烧了预算、常有补写，被丢的轮次零产出且不重试。');
    out.push('    · 处置顺序：① 收回 failed 回合的槽时间（见上）② 加池 ③ 降频；**别抬 `QUEUE_MAX_AGE_MS`**'
      + '——它是「耐心上限」不是容量，抬了只会让更旧的轮次读到过期数据。');
    out.push(kindNote);
    out.push(...demandNotes);
    return { lines: out, hit: 1, warn: 0, undet: 0 };
  }
  out.push(`  ⚠ 排期轮次有丢弃但未失控：窗口 ${hours}h 内 ${dropped} 轮被丢（${names}）`
    + '——判红线是「某一岗丢了 1/3 以上的轮次」或「有一只等了 3 倍上限」，这里都没到。');
  out.push(kindNote);
  out.push(...demandNotes);
  return { lines: out, hit: 0, warn: 1, undet: 0 };
}

function judgeProvenance(reports) {
  const out = [];
  const cutoff = Date.now() - 7 * 24 * 3600e3;
  void cutoff;
  if (!reports.length) {
    out.push('  · 溯源覆盖：7 天内没有报告，判不出');
    return { lines: out, hit: 0, warn: 0, undet: 1 };
  }
  const withRes = reports.filter((r) => safeArray(r.resources).length > 0).length;
  const pct = Math.round((withRes / reports.length) * 100);
  const known = KNOWN_OPEN.provenance;
  if (pct >= 80) out.push(`  ✓ 溯源覆盖 ${pct}%（${withRes}/${reports.length}）`);
  else {
    out.push(`  ${known ? '⚠' : '✗'} 溯源覆盖 ${pct}%（${withRes}/${reports.length}）${known ? ` —— 已知未交付：${known}` : ''}`);
    return { lines: out, hit: known ? 0 : 1, warn: known ? 1 : 0, undet: 0 };
  }
  return { lines: out, hit: 0, warn: 0, undet: 0 };
}

function safeArray(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') { try { const x = JSON.parse(v); return Array.isArray(x) ? x : []; } catch { return []; } }
  return [];
}
function safeObj(v) {
  if (v && typeof v === 'object') return v;
  if (typeof v === 'string') { try { const x = JSON.parse(v); return x && typeof x === 'object' ? x : {}; } catch { return {}; } }
  return {};
}

// ── reading (pod only) ──────────────────────────────────────────────────────
function readWorld(root, fleetRe) {
  const Database = require('/app/node_modules/better-sqlite3');
  const cellsDir = path.join(root, 'cells');
  const found = { fleet: null, cellDir: null, members: [], turns: [], reports: [], jobs: [], scanned: 0 };
  let entries = [];
  try { entries = fs.readdirSync(cellsDir); } catch { return null; }
  for (const dir of entries) {
    const dbFile = path.join(cellsDir, dir, 'data', 'data', 'fleets.db');
    if (!fs.existsSync(dbFile)) continue;
    let db;
    try { db = new Database(dbFile, { readonly: true }); } catch { continue; }
    try {
      const fleets = db.prepare('SELECT id, name, state FROM fleets').all();
      found.scanned += 1;
      const hit = fleets.find((f) => fleetRe.test(f.name || ''));
      if (!hit) continue;
      found.fleet = hit;
      found.cellDir = path.join(cellsDir, dir);
      found.members = db.prepare('SELECT id, title, target_kind, target_id, kpi_slots, cadence FROM fleet_members WHERE fleet_id = ? ORDER BY sort_key').all(hit.id);
      // 7 days is enough for every section (tick rows + provenance share).
      const since = Date.now() - 8 * 24 * 3600e3;
      found.turns = db.prepare('SELECT member_id, status, error_kind, error, detail, started_at, ended_at FROM member_turn_events WHERE fleet_id = ? AND started_at >= ? ORDER BY started_at').all(hit.id, since);
      found.reports = db.prepare('SELECT member_id, metrics, resources, summary, source, created_at FROM member_reports WHERE fleet_id = ? AND created_at >= ? ORDER BY created_at').all(hit.id, since);
    } finally { try { db.close(); } catch {} }
    if (found.fleet) break;
  }
  if (!found.fleet) return null;
  const jobsFile = path.join(found.cellDir, 'data', 'cron-store', 'jobs.json');
  try { found.jobs = JSON.parse(fs.readFileSync(jobsFile, 'utf8')); } catch { found.jobs = []; }
  return found;
}


// A member's target_id is a catalog id (`persona:user.deputy-4iuzp0`) while the
// job stores a preset name (`user-deputy-4iuzp0`): the same thing spelled with a
// dot vs a dash. Trying only the raw form silently skipped 常务 entirely — no
// line, no error — which is the failure mode this whole script exists to avoid.
function presetCandidates(targetId) {
  const raw = String(targetId || '').split(':').pop();
  if (!raw) return [];
  return [...new Set([raw, raw.replace(/\./g, '-'), raw.replace(/-/g, '.')])];
}
function findJobForMember(member, jobs) {
  const cands = presetCandidates(member.target_id);
  const matches = jobs.filter((j) => cands.includes(String(j.preset || '')));
  return matches.find((j) => !j.paused) || matches[0] || null;
}

function cadenceBudgetMs(member) {
  try {
    const c = JSON.parse(member.cadence || 'null');
    const v = Number(c?.turnTimeoutMs);
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch { return null; }
}

function roleBindings(members, jobs) {
  // A role is (member, job) where the job's preset is the member's persona.
  // Matching by preset rather than by title keeps this working after renames.
  const roles = [
    { role: '首席分析师', re: /chief/i },
    { role: '宏观研究员', re: /macro/i },
    { role: '行业研究员', re: /sector/i },
  ];
  const out = [];
  for (const r of roles) {
    const m = members.find((x) => r.re.test(String(x.target_id || '')));
    if (!m) continue;
    const job = findJobForMember(m, jobs);
    // No job for a member that HAS a cadence is a real gap (the schedule exists
    // in the roster but nothing dispatches it); no cadence at all is not armed
    // yet and is reported as a fact elsewhere.
    const budgetMs = cadenceBudgetMs(m);
    if (job) out.push({ role: r.role, memberId: m.id, jobId: job.id, cron: job.cron, budgetMs });
    else out.push({ role: r.role, memberId: m.id, jobId: null, cron: null, budgetMs });
  }
  return out;
}

function scan({ root = '/data', nowMs = Date.now(), fleetRe = /投研/, podStartMs = null } = {}) {
  const world = readWorld(root, fleetRe);
  if (!world) {
    return { lines: ['  ✗ 判不出：在 ' + root + '/cells 下找不到名称匹配 ' + String(fleetRe) + ' 的舰队'], hit: 0, warn: 0, undet: 1, world: null };
  }
  const lines = [];
  let hit = 0; let warn = 0; let undet = 0;
  lines.push(`  舰队：${world.fleet.name}（${world.fleet.id}，${String(world.fleet.state)}）· 成员 ${world.members.length} · 作业 ${world.jobs.length} · 扫描 cell ${world.scanned} 个`);

  const roles = roleBindings(world.members, world.jobs);
  // A role that silently disappears (renamed persona id, dropped member) would
  // shrink the population the gate looks at and read as "fewer problems".
  const EXPECTED_ROLES = ['首席分析师', '宏观研究员', '行业研究员'];
  const found = new Set(roles.map((r) => r.role));
  for (const name of EXPECTED_ROLES) {
    if (!found.has(name)) {
      lines.push(`  ✗ ${name}: 成员表里找不到这一岗（preset 名不匹配）——它从人口里消失了，不是没问题`);
      hit += 1;
    }
  }
  if (!roles.length) undet += 1;
  for (const r of roles) {
    if (!r.jobId) {
      lines.push(`  ✗ ${r.role}: 成员在册但没有任何作业在派发它（名册与派发面不一致）`);
      hit += 1;
      continue;
    }
    // The job carries its own tz; the fleet happens to be CST today, but hard-coding
    // it means a job moved to another zone is judged against the wrong wall clock
    // and reports a missing tick that never existed.
    const jobRec = world.jobs.find((j) => j.id === r.jobId);
    const tickMs = lastTickMs(r.cron, nowMs, jobRec?.tz || TZ_DEFAULT);
    if (!tickMs) { lines.push(`  · ${r.role}: cron "${r.cron}" 解析不出，跳过`); undet += 1; continue; }
    const res = judgeRole(r, { nowMs, jobs: world.jobs, turns: world.turns, reports: world.reports, tickMs, podStartMs, budgetMs: r.budgetMs });
    lines.push(...res.lines);
    hit += res.hit; warn += res.warn; undet += res.undet;
  }

  const deputyMember = world.members.find((m) => /常务/.test(String(m.title || '')));
  if (deputyMember) {
    const job = findJobForMember(deputyMember, world.jobs);
    if (job) {
      const res = judgeHourly({ role: '常务岗', jobId: job.id }, { jobs: world.jobs, nowMs });
      lines.push(...res.lines);
      hit += res.hit; warn += res.warn; undet += res.undet;
    } else {
      lines.push('  ✗ 常务岗: 成员在册但没有任何作业在派发它（名册与派发面不一致）');
      hit += 1;
    }
  }

  // Members with no cadence are not "failing" — they are not armed. Say so
  // instead of letting them vanish from the report (风控官 waits on D1).
  const unarmed = world.members.filter((m) => {
    let c = null; try { c = m.cadence ? JSON.parse(m.cadence) : null; } catch {}
    return !c || !c.cron;
  });
  for (const m of unarmed) {
    lines.push(`  · 未武装：${m.title}（无 cadence，不派发；${/风控/.test(String(m.title)) ? '等 D1 裁决' : '待配置'}）`);
  }

  const laneRes = judgeLaneCapacity(world.jobs, { hours: 6, nowMs });
  lines.push(...laneRes.lines);
  hit += laneRes.hit; warn += laneRes.warn; undet += laneRes.undet;

  // Deliberately separate from — and after — the lane verdict: a dropped fire has
  // no duration, so it is the one loss the occupancy ratios above cannot express.
  const dropRes = judgeDroppedFires(world.jobs, { hours: 6, nowMs, laneHit: laneRes.hit > 0 });
  lines.push(...dropRes.lines);
  hit += dropRes.hit; warn += dropRes.warn; undet += dropRes.undet;

  const slotRes = judgeSlots(world.members, { nowMs });
  lines.push(...slotRes.lines);
  hit += slotRes.hit; warn += slotRes.warn; undet += slotRes.undet;

  const provRes = judgeProvenance(world.reports);
  lines.push(...provRes.lines);
  hit += provRes.hit; warn += provRes.warn; undet += provRes.undet;

  lines.push('  · 结算：首个出厂日 11-20 之前，settlements=0 是正确读数，不判');
  return { lines, hit, warn, undet, world };
}

// ── self-test (offline; no db, no cluster) ──────────────────────────────────
function selfTest() {
  const fails = [];
  let total = 0; // counted, never written down: a hardcoded count drifts the first time one is added
  const arm = (name, cond, detail) => {
    total += 1;
    if (!cond) fails.push(`${name}${detail ? ` — ${detail}` : ''}`);
  };
  // Past the grace window (tick+60min). Arms that must show "the tick did not
  // run" have to sit OUTSIDE grace or they measure the grace branch instead.
  const NOW = Date.parse('2026-11-16T03:00:00Z'); // 11:00 CST, well after all three ticks
  const TICK = lastTickMs('30 9 * * 1-5', NOW);
  arm('cron 解析：周一 09:30 CST = 01:30Z', TICK === Date.parse('2026-11-16T01:30:00Z'), String(TICK && new Date(TICK).toISOString()));
  arm('cron 解析：下一个 tick 是周二', nextTickMs('30 9 * * 1-5', NOW) === Date.parse('2026-11-17T01:30:00Z'), String(new Date(nextTickMs('30 9 * * 1-5', NOW)).toISOString()));
  arm('cron 解析：周六不排期', lastTickMs('30 9 * * 1-5', Date.parse('2026-11-14T01:45:00Z')) === Date.parse('2026-11-13T01:30:00Z'));
  arm('cron 解析：小时级 50 * * * *', lastTickMs('50 * * * *', NOW) === Date.parse('2026-11-16T02:50:00Z'), String(new Date(lastTickMs('50 * * * *', NOW)).toISOString()));

  const member = { id: 'm1', title: '首席分析师', target_kind: 'persona', target_id: 'persona:invest-chief', kpi_slots: '[]' };
  const job = (over = {}) => ({ id: 'j1', preset: 'invest-chief', paused: false, state: 'done', history: [], ...over });
  const base = { nowMs: NOW, turns: [], reports: [], tickMs: TICK };
  const okTurn = (at = '2026-11-16T01:31:00Z') => ({ member_id: 'm1', status: 'ok', started_at: Date.parse(at), ended_at: Date.parse(at) + 9 * 60e3 });
  const okReport = (at = '2026-11-16T01:40:00Z') => ({ member_id: 'm1', created_at: Date.parse(at), resources: '[]', metrics: '{}' });
  const okHist = (at = '2026-11-16T01:31:00Z') => ({ time: at, state: 'done', success: true, duration: 540e3 });

  // 1. the tick ran, turn ok, report landed ⇒ green
  let r = judgeRole({ role: 'R', memberId: 'm1', jobId: 'j1' }, {
    ...base, jobs: [job({ history: [okHist()] })], turns: [okTurn()], reports: [okReport()],
  });
  arm('1 全绿不命中', r.hit === 0, JSON.stringify(r.lines));

  // 2. no history at all past the tick ⇒ 缺轮
  r = judgeRole({ role: 'R', memberId: 'm1', jobId: 'j1' }, { ...base, jobs: [job({ lastRun: '2026-11-15T00:52:00Z' })] });
  arm('2 无 history ⇒ 命中', r.hit === 1, JSON.stringify(r.lines));

  // 3. same, but the tick is still inside grace ⇒ not judged
  r = judgeRole({ role: 'R', memberId: 'm1', jobId: 'j1' }, { ...base, nowMs: TICK + 5 * 60e3, jobs: [job()] });
  arm('3 宽限内不判', r.hit === 0 && r.lines.some((l) => /不判/.test(l)), JSON.stringify(r.lines));

  // 4. a manual/catch-up run before the tick must not be read as "the tick ran"
  r = judgeRole({ role: 'R', memberId: 'm1', jobId: 'j1' }, {
    ...base, jobs: [job({ lastRun: '2026-11-16T00:52:00Z', history: [okHist('2026-11-16T00:52:00Z')] })],
  });
  arm('4 排期前的手工轮不算这一轮', r.hit === 1, JSON.stringify(r.lines));

  // 5. REAL SHAPE (首席 11-13): the catch-up two days later must not be read as
  //    "the Friday tick ran". MAX_LATE is what keeps it out.
  r = judgeRole({ role: 'R', memberId: 'm1', jobId: 'j1' }, {
    ...base,
    tickMs: Date.parse('2026-11-13T01:30:00Z'),
    nowMs: Date.parse('2026-11-16T03:00:00Z'),
    jobs: [job({ history: [okHist('2026-11-15T00:52:00Z')] })],
    turns: [{ member_id: 'm1', status: 'interrupted', error_kind: 'cell_restart', started_at: Date.parse('2026-11-15T00:52:00Z'), ended_at: Date.parse('2026-11-15T00:53:00Z') }],
  });
  arm('5 隔两天的补跑不算周五那一轮', r.hit === 1 && /没有任何 history 记录/.test(r.lines[0]), JSON.stringify(r.lines));

  // 6. REAL SHAPE (行业 11-13): a +39min late start IS this tick.
  r = judgeRole({ role: 'R', memberId: 'm1', jobId: 'j1' }, {
    ...base,
    tickMs: Date.parse('2026-11-16T01:10:00Z'),
    jobs: [job({ history: [okHist('2026-11-16T01:49:00Z')] })],
    turns: [okTurn('2026-11-16T01:49:00Z')],
    reports: [okReport('2026-11-16T01:47:00Z')],
  });
  arm('6 晚 39 分钟起步仍属本轮', r.hit === 0, JSON.stringify(r.lines));

  // 7. skipped for queue staleness is a lost round, not a soft signal
  r = judgeRole({ role: 'R', memberId: 'm1', jobId: 'j1' }, {
    ...base, jobs: [job({ history: [{ time: '2026-11-16T01:30:30Z', state: 'skipped', success: false, error: 'queue staleness' }] })],
  });
  arm('7 skipped ⇒ 命中', r.hit === 1 && r.lines.some((l) => /skipped/.test(l)), JSON.stringify(r.lines));

  // 8. job ran but the turn table has no row ⇒ the two faces disagree
  r = judgeRole({ role: 'R', memberId: 'm1', jobId: 'j1' }, { ...base, jobs: [job({ history: [okHist()] })] });
  arm('8 作业跑了但无回合行 ⇒ 命中', r.hit === 1 && /回合表/.test(r.lines.join('\n')), JSON.stringify(r.lines));

  // 9. turn ok without a report ⇒ 命中 ("turn ok" ≠ "report landed")
  r = judgeRole({ role: 'R', memberId: 'm1', jobId: 'j1' }, { ...base, jobs: [job({ history: [okHist()] })], turns: [okTurn()] });
  arm('9 回合 ok 但无报告 ⇒ 命中', r.hit === 1 && /没有报告落地/.test(r.lines.join('\n')), JSON.stringify(r.lines));

  // 10. timeout is an error_kind, not a status (status set is ok|failed|interrupted|skipped)
  r = judgeRole({ role: 'R', memberId: 'm1', jobId: 'j1' }, {
    ...base,
    jobs: [job({ history: [okHist()] })],
    turns: [{ member_id: 'm1', status: 'failed', error_kind: 'timeout', error: 'budget soft stop (576s of 720s)', started_at: Date.parse('2026-11-16T01:31:00Z'), ended_at: Date.parse('2026-11-16T01:41:00Z') }],
  });
  arm('10 failed/timeout 带原文 ⇒ 命中', r.hit === 1 && /576s of 720s/.test(r.lines.join('\n')), JSON.stringify(r.lines));

  // 11. one problem is one hit: a lost tick with empty turn/report tables must
  //     not read as three independent alarms.
  r = judgeRole({ role: 'R', memberId: 'm1', jobId: 'j1' }, { ...base, jobs: [job()] });
  arm('11 一次缺轮只算一次命中', r.hit === 1, JSON.stringify(r.lines));

  // 12. hourly lane losing 2 of 6 fires (33% > 25%) ⇒ 命中
  const hourly = (hist) => judgeHourly({ role: 'H', jobId: 'j2' }, { jobs: [job({ id: 'j2', history: hist })], nowMs: NOW });
  const fire = (at, ok = true, extra = {}) => ({ time: at, state: ok ? 'done' : 'skipped', success: ok, ...extra });
  r = hourly([
    fire('2026-11-16T00:50:00Z'), fire('2026-11-16T01:31:00Z', false, { error: 'queue staleness: waited 10min' }),
    fire('2026-11-16T01:50:00Z', false, { state: 'failed', error: 'budget soft stop (576s of 720s)' }),
    fire('2026-11-16T02:10:00Z'), fire('2026-11-16T02:30:00Z'), fire('2026-11-16T02:50:00Z'),
  ]);
  arm('12 小时级丢 2/6（33%）⇒ 命中', r.hit === 1, JSON.stringify(r.lines));

  // 13. a single burst inside an otherwise healthy day ⇒ ⚠ only, so the gate
  //     does not flap red/green every hour.
  r = hourly([
    fire('2026-11-15T04:50:00Z'), fire('2026-11-15T08:50:00Z'), fire('2026-11-15T12:50:00Z'),
    fire('2026-11-15T16:50:00Z'), fire('2026-11-15T20:50:00Z'), fire('2026-11-15T21:50:00Z'),
    fire('2026-11-15T22:50:00Z'), fire('2026-11-15T23:50:00Z'),
    fire('2026-11-16T00:50:00Z'), fire('2026-11-16T01:31:00Z', false, { error: 'queue staleness' }),
    fire('2026-11-16T01:50:00Z', false, { state: 'failed', error: 'budget soft stop' }),
    fire('2026-11-16T02:50:00Z'),
  ]);
  arm('13 全天 2/12（17%）但最近 4 轮丢 2 ⇒ 只 ⚠', r.hit === 0 && r.warn === 1, JSON.stringify(r.lines));

  // 14. slots: 0 declared ⇒ ⚠ under KNOWN_OPEN, ✗ once the entry is removed
  const deputy = { ...member, title: '常务岗', kpi_slots: '[]' };
  r = judgeSlots([deputy], {});
  arm('14 卡槽 0 个 ⇒ 已知未交付报 ⚠', r.hit === 0 && r.lines[0].startsWith('  ⚠'), JSON.stringify(r.lines));
  const saved = KNOWN_OPEN.kpi_slots;
  delete KNOWN_OPEN.kpi_slots;
  r = judgeSlots([deputy], {});
  arm('15 摘掉已知条目即转 ✗', r.hit === 1, JSON.stringify(r.lines));
  KNOWN_OPEN.kpi_slots = saved;

  // 16. provenance: empty resources ⇒ ⚠ now (known-open), green at 80%
  r = judgeProvenance([{ member_id: 'm1', created_at: NOW, resources: '[]' }, { member_id: 'm2', created_at: NOW, resources: '[{"u":1}]' }]);
  arm('16 溯源 50% ⇒ 已知未交付报 ⚠', r.hit === 0 && r.warn === 1, JSON.stringify(r.lines));
  r = judgeProvenance([
    { member_id: 'm1', created_at: NOW, resources: '[{"u":1}]' }, { member_id: 'm2', created_at: NOW, resources: '[]' },
    { member_id: 'm3', created_at: NOW, resources: '[{"u":2}]' }, { member_id: 'm4', created_at: NOW, resources: '[{"u":3}]' },
    { member_id: 'm5', created_at: NOW, resources: '[{"u":4}]' },
  ]);
  arm('17 溯源 80% ⇒ 绿', r.hit === 0 && r.warn === 0, JSON.stringify(r.lines));

  // 18. role binding: a paused duplicate must not shadow the live job
  const roles = roleBindings([member], [
    job({ id: 'job_a', preset: 'invest-chief', paused: true }),
    job({ id: 'job_b', preset: 'invest-chief', paused: false }),
  ]);
  arm('18 绑活作业而非暂停的重复件', roles.length === 1 && roles[0].jobId === 'job_b', JSON.stringify(roles));

  // 18b. "no record this tick" must also print the job's own recent misses:
  //      that is what separates "never dispatched" from "queued out".
  r = judgeRole({ role: 'R', memberId: 'm1', jobId: 'j1' }, {
    ...base,
    nowMs: Date.parse('2026-11-16T05:00:00Z'),
    jobs: [job({ history: [{ time: '2026-11-13T01:40:00Z', state: 'skipped', success: false, error: 'queue staleness: waited 11min' }] })],
  });
  arm('18b 缺轮时念出该作业最近的丢轮', r.hit === 1 && /queue staleness/.test(r.lines.join('\n')), JSON.stringify(r.lines));

  // 18b2. an OPEN history row is a run in progress, not a failure (the row is
  //       written at start, state filled on completion) — otherwise every gate run
  //       during the acceptance window reads red.
  r = judgeRole({ role: 'R', memberId: 'm1', jobId: 'j1' }, {
    ...base, nowMs: TICK + 10 * 60e3,
    jobs: [job({ history: [{ time: '2026-11-16T01:30:05Z' }] })],
  });
  arm('18b2 无终态＝仍在跑，不判失败', r.hit === 0 && /仍在跑/.test(r.lines.join('\n')), JSON.stringify(r.lines));

  // 18b2b. an open row whose pod has since restarted was KILLED by the roll —
  //        a lost tick, attributed, not "still running" and not "stuck".
  r = judgeRole({ role: 'R', memberId: 'm1', jobId: 'j1' }, {
    ...base, nowMs: TICK + 20 * 60e3, podStartMs: TICK + 6 * 60e3,
    jobs: [job({ history: [{ time: '2026-11-16T01:30:05Z' }] })],
  });
  arm('18b2b 滚动打断 ⇒ 命中并点名 pod 起点', r.hit === 1 && /滚动打断/.test(r.lines.join('\n')), JSON.stringify(r.lines));

  // 18b2c. the stuck threshold is the role's OWN budget (900s ⇒ 30min), not a
  //        global constant: a 900s budget open for 32min (its 2× bound) is stuck,
  //        whereas a global 45min would call it "still running".
  r = judgeRole({ role: 'R', memberId: 'm1', jobId: 'j1' }, {
    ...base, nowMs: TICK + 32 * 60e3, budgetMs: 900e3,
    jobs: [job({ history: [{ time: '2026-11-16T01:31:00Z' }] })],
  });
  arm('18b2c 超预算两倍即卡死（按该岗预算）', r.hit === 1 && /卡死/.test(r.lines.join('\n')), JSON.stringify(r.lines));

  // 18b3. …but an open row past the stuck threshold IS a hit.
  r = judgeRole({ role: 'R', memberId: 'm1', jobId: 'j1' }, {
    ...base, nowMs: TICK + 60 * 60e3,
    jobs: [job({ history: [{ time: '2026-11-16T01:30:05Z' }] })],
  });
  arm('18b3 超过卡死阈值 ⇒ 命中', r.hit === 1 && /卡死/.test(r.lines.join('\n')), JSON.stringify(r.lines));

  // 18c. tick math follows the job's own tz: the same cron in UTC lands 8h off.
  //      Same cron, same instant, two zones ⇒ 8h apart. Hard-coding CST would
  //      judge a UTC job against the wrong wall clock and invent a missing tick.
  const AT10 = Date.parse('2026-11-16T10:00:00Z');
  arm('18c 同一 cron 在两个时区相差 8 小时',
    lastTickMs('30 9 * * 1-5', AT10, 'UTC') === Date.parse('2026-11-16T09:30:00Z')
    && lastTickMs('30 9 * * 1-5', AT10, 'Asia/Shanghai') === Date.parse('2026-11-16T01:30:00Z'),
    `${new Date(lastTickMs('30 9 * * 1-5', AT10, 'UTC')).toISOString()} vs ${new Date(lastTickMs('30 9 * * 1-5', AT10, 'Asia/Shanghai')).toISOString()}`);

  // 18d. a missing research role must be named, not silently dropped
  const rolesMissing = roleBindings([member], [job({ id: 'job_b', preset: 'invest-chief' })]);
  const foundRoles = new Set(rolesMissing.map((x) => x.role));
  arm('18d 缺岗要进人口检查', foundRoles.size === 1 && !foundRoles.has('宏观研究员'), JSON.stringify(rolesMissing));

  // 19. lane capacity: an oversubscribed hour is one hit naming the % — the six
  //     dropped fires in it are that one fact, not six faults.
  const fires = (spec) => spec.map(([at, secs, state = 'done', error = null]) => ({
    time: at, state, success: state === 'done', duration: secs * 1000, ...(error ? { error } : {}),
  }));
  r = judgeLaneCapacity([{ id: 'job_aaaaaa', history: [
    ...fires([['2026-11-15T20:05:00Z', 1500], ['2026-11-15T20:15:00Z', 2000], ['2026-11-15T20:35:00Z', 1500]]),
    ...fires([['2026-11-15T21:05:00Z', 600], ['2026-11-15T21:15:00Z', 500]]),
  ] }], { hours: 6, nowMs: Date.parse('2026-11-15T22:30:00Z') });
  arm('19 串行槽超订 ⇒ 命中并点名百分比', r.hit === 1 && /5000|139%|超订/.test(r.lines.join('\n')), JSON.stringify(r.lines));

  // 20. comfortable lane ⇒ green
  r = judgeLaneCapacity([{ id: 'job_aaaaaa', history: fires([['2026-11-15T20:05:00Z', 600], ['2026-11-15T21:05:00Z', 700]]) }],
    { hours: 6, nowMs: Date.parse('2026-11-15T22:30:00Z') });
  arm('20 串行槽有余量 ⇒ 绿', r.hit === 0 && r.warn === 0, JSON.stringify(r.lines));

  // 21. near saturation but under 100% ⇒ ⚠ only (a warn must exist between green and red)
  r = judgeLaneCapacity([{ id: 'job_aaaaaa', history: fires([
    ['2026-11-15T20:05:00Z', 3200], ['2026-11-15T21:05:00Z', 3100],
  ]) }], { hours: 6, nowMs: Date.parse('2026-11-15T22:30:00Z') });
  arm('21 接近饱和（85%）⇒ ⚠ 不命中', r.hit === 0 && r.warn === 1, JSON.stringify(r.lines));

  // 21a. THE BUG THIS PASS FIXED, pinned as a red-proof: the same 5000s/hour
  //      that arm 19 calls an oversubscribed serial lane is only 35% of a
  //      4-wide worker pool. The old criterion reported "139% of one slot" for
  //      this shape — a false verdict that sends the owner to 拆 cell / 降频.
  r = judgeLaneCapacity([{ id: 'job_aaaaaa', preset: 'invest-chief', history: [
    ...fires([['2026-11-15T20:05:00Z', 1500], ['2026-11-15T20:15:00Z', 2000], ['2026-11-15T20:35:00Z', 1500]]),
    ...fires([['2026-11-15T21:05:00Z', 600], ['2026-11-15T21:15:00Z', 500]]),
  ] }], { hours: 6, nowMs: Date.parse('2026-11-15T22:30:00Z'), width: 4 });
  arm('21a 宽 4 的池上 5000s/h 只是 35% ⇒ 不许判超订',
    r.hit === 0 && /宽 4/.test(r.lines.join('\n')) && !/139%/.test(r.lines.join('\n')),
    JSON.stringify(r.lines));

  // 21b. …and the lane split must bear weight: a job WITHOUT a preset cannot
  //      enter the pool (`scheduleNext`: `if (!persona) return false`), so the
  //      same hour is still an oversubscription on the serial lane even though
  //      the pool is wide. The assertion names the VERDICT line, not the detail
  //      list — the detail names every lane, so `/cell 串行/` alone would pass
  //      even when the verdict blames the pool (caught in the red proof).
  r = judgeLaneCapacity([
    { id: 'job_pooled', preset: 'invest-chief', history: fires([['2026-11-15T20:05:00Z', 4300], ['2026-11-15T21:05:00Z', 100]]) },
    { id: 'job_serial', history: fires([['2026-11-15T20:10:00Z', 4300], ['2026-11-15T21:10:00Z', 100]]) },
  ], { hours: 6, nowMs: Date.parse('2026-11-15T22:30:00Z'), width: 4 });
  arm('21b 无 preset 的作业仍在串行道判超订（宽池遮不住它）',
    r.hit === 1 && /✗ 回合道超订：cell 串行/.test(r.lines.join('\n')), JSON.stringify(r.lines));

  // 21c. laneWidth: only a positive number activates the pool; 0/absent/garbage
  //      is the serial cell (worker-slots.js falls back to 0 = "serial mode").
  arm('21c 道宽度解析：4⇒4 / 0⇒1 / 未设⇒1 / 负数⇒1 / 非数⇒1',
    laneWidth({ TASK_WORKER_MAX: '4' }) === 4 && laneWidth({}) === 1
    && laneWidth({ TASK_WORKER_MAX: '0' }) === 1 && laneWidth({ TASK_WORKER_MAX: '-2' }) === 1
    && laneWidth({ TASK_WORKER_MAX: 'abc' }) === 1, '');

  // 21d. wasted slot time is named (two-sided: it must not be claimed when it
  //      is absent, or the line becomes background noise) — AND it names WHO:
  //      "55% is wasted" is not actionable, "these members are the 55%" is.
  const wasteful = judgeLaneCapacity([{ id: 'job_a', preset: 'p', history: [
    ...fires([['2026-11-15T20:05:00Z', 1200]]),
    ...fires([['2026-11-15T20:20:00Z', 600, 'failed', 'turn stopped early — budget soft stop (480s of 600s)']]),
    ...fires([['2026-11-15T21:05:00Z', 1200]]),
  ] }], { hours: 6, nowMs: Date.parse('2026-11-15T22:30:00Z'), width: 4 });
  const clean = judgeLaneCapacity([{ id: 'job_a', preset: 'p', history: fires([
    ['2026-11-15T20:05:00Z', 1200], ['2026-11-15T21:05:00Z', 1200],
  ]) }], { hours: 6, nowMs: Date.parse('2026-11-15T22:30:00Z'), width: 4 });
  arm('21d failed 占槽 33% 要点名并点名到作业；全 done 时两行都不许出现',
    /33% 的槽时间花在 failed/.test(wasteful.lines.join('\n'))
    && /烧槽的前三：job_a\(1 次失败\/600s，soft stop 1\)/.test(wasteful.lines.join('\n'))
    && !/花在 failed|烧槽的前三/.test(clean.lines.join('\n')),
    JSON.stringify([wasteful.lines, clean.lines]));

  // 21e–21i. dropped cadence fires: the loss occupancy cannot express. Two-sided
  //     throughout — the green arm must not just "lack a ✗", it must not claim a
  //     loss at all (a gate that says nothing and a gate that says "fine" look
  //     identical in a log; only one of them is a measurement).
  const dropMsg = (min, bound = 10) => 'queue staleness: a scheduled fire waited ' + min
    + "min behind the cell's serial slot (>" + bound + 'min) — dropped without running; the next cadence fire supersedes it';
  const DROP_NOW = Date.parse('2026-11-15T22:30:00Z');
  const cleanDrops = judgeDroppedFires([{ id: 'job_a', preset: 'p', history: fires([
    ['2026-11-15T20:05:00Z', 300, 'skipped'], ['2026-11-15T21:05:00Z', 300],
  ]) }], { hours: 6, nowMs: DROP_NOW, width: 4 });
  arm('21e 一轮没丢 ⇒ 绿，且不许出现「丢弃」字样',
    cleanDrops.hit === 0 && cleanDrops.warn === 0
    && /0 轮被丢/.test(cleanDrops.lines.join('\n')) && !/丢弃/.test(cleanDrops.lines.join('\n')),
    JSON.stringify(cleanDrops.lines));

  // The queue-staleness rows carry their numbers in the message; without them the
  // arm cannot reach the wait/ratio branches at all.
  const hard = judgeDroppedFires([{ id: 'job_thnsta', preset: 'user-deputy-x', history: fires([
    ['2026-11-15T20:05:00Z', 60, 'skipped', dropMsg(53)],
    ['2026-11-15T21:05:00Z', 60, 'skipped', dropMsg(48)],
    ['2026-11-15T22:05:00Z', 300],
  ]) }], { hours: 6, nowMs: DROP_NOW, width: 4 });
  arm('21f 丢了 2/3 轮 ⇒ 命中，点名「丢 2/3 轮，最长等 53min」并把道名纠正到 worker 池',
    hard.hit === 1
    && /丢 2\/3 轮，最长等 53min/.test(hard.lines.join('\n'))
    && /worker 池（宽 4）后面/.test(hard.lines.join('\n'))
    && /别抬 `QUEUE_MAX_AGE_MS`/.test(hard.lines.join('\n')),
    JSON.stringify(hard.lines));

  const mild = judgeDroppedFires([{ id: 'job_b', preset: 'p', history: fires([
    ['2026-11-15T20:05:00Z', 60, 'skipped', dropMsg(11)],
    ['2026-11-15T20:35:00Z', 300], ['2026-11-15T21:35:00Z', 300], ['2026-11-15T22:05:00Z', 300],
  ]) }], { hours: 6, nowMs: DROP_NOW, width: 4 });
  arm('21g 4 轮丢 1 轮、只等 11min ⇒ ⚠ 不命中（上限是耐心线，不是容量线）',
    mild.hit === 0 && mild.warn === 1 && /未失控/.test(mild.lines.join('\n')),
    JSON.stringify(mild.lines));

  const dedup = judgeDroppedFires([{ id: 'job_thnsta', preset: 'user-deputy-x', history: fires([
    ['2026-11-15T20:05:00Z', 60, 'skipped', dropMsg(53)],
    ['2026-11-15T21:05:00Z', 60, 'skipped', dropMsg(48)],
    ['2026-11-15T22:05:00Z', 300],
  ]) }], { hours: 6, nowMs: DROP_NOW, width: 4, laneHit: true });
  arm('21h 道已判超订时，同一批丢弃只降 ⚠（一处问题只算一次命中）',
    dedup.hit === 0 && dedup.warn === 1 && /同一条事实，不重复计命中/.test(dedup.lines.join('\n')),
    JSON.stringify(dedup.lines));

  const serialDrop = judgeDroppedFires([{ id: 'job_serial', history: fires([
    ['2026-11-15T20:05:00Z', 60, 'skipped', dropMsg(53)],
    ['2026-11-15T21:05:00Z', 60, 'skipped', dropMsg(48)],
    ['2026-11-15T22:05:00Z', 300],
  ]) }], { hours: 6, nowMs: DROP_NOW, width: 4 });
  arm('21i 没 preset 的作业才点名「确实走串行槽」（两者不许混成一句）',
    serialDrop.hit === 1 && /1 个确实没 preset 才走串行槽/.test(serialDrop.lines.join('\n'))
    && !/0 个是池里的（宽/.test(serialDrop.lines.join('\n')),
    JSON.stringify(serialDrop.lines));

  // 21j–21k. the demand side: five DIFFERENT personas asking in ONE minute against
  //     a 4-wide pool is a different fault from one persona being slow, and the
  //     catch-up signature (crons that are supposed to be spread, all in the same
  //     minute) points at a stall rather than at capacity.
  const caughtUp = judgeDroppedFires([
    { id: 'job_a1', preset: 'p1', cron: '0 * * * *', history: fires([['2026-11-15T20:11:00Z', 0, 'skipped', dropMsg(11)]]) },
    { id: 'job_a2', preset: 'p2', cron: '5 * * * *', history: fires([['2026-11-15T20:11:00Z', 0, 'skipped', dropMsg(11)]]) },
    { id: 'job_a3', preset: 'p3', cron: '10 * * * *', history: fires([['2026-11-15T20:11:00Z', 0, 'skipped', dropMsg(11)]]) },
    { id: 'job_a4', preset: 'p4', cron: '15 * * * *', history: fires([['2026-11-15T20:11:00Z', 0, 'skipped', dropMsg(11)]]) },
    { id: 'job_a5', preset: 'p5', cron: '20 * * * *', history: fires([['2026-11-15T20:11:00Z', 0, 'skipped', dropMsg(11)]]) },
  ], { hours: 6, nowMs: DROP_NOW, width: 4 });
  arm('21j 五款人格挤在同一分钟且 cron 各不相同 ⇒ 点名并发需求并判「补跑堆积」',
    caughtUp.hit === 1
    && /起火最挤的一分钟是 20:11Z：5 款不同人格（来自 5 个不同 cron）/.test(caughtUp.lines.join('\n'))
    && /补跑堆积/.test(caughtUp.lines.join('\n')),
    JSON.stringify(caughtUp.lines));

  const spread = judgeDroppedFires([{ id: 'job_s1', preset: 'p1', cron: '0 * * * *', history: fires([
    ['2026-11-15T20:05:00Z', 0, 'skipped', dropMsg(11)], ['2026-11-15T21:05:00Z', 0, 'skipped', dropMsg(11)],
  ]) }], { hours: 6, nowMs: DROP_NOW, width: 4 });
  arm('21k 只有一款人格、每分钟一款 ⇒ 不许念并发需求或补跑堆积（否则每轮都挂一句无关诊断）',
    spread.hit === 1 && !/起火最挤|补跑堆积/.test(spread.lines.join('\n')),
    JSON.stringify(spread.lines));

  // 21l–21m. the KIND split. The writer only emits `catchUp: true`, so "absent" is
  //     ambiguous between "fresh round" and "row written by an older build": the gate
  //     must name absence as 未归因 rather than silently counting it as fresh — reading
  //     absence as a value is the shape that inverts a verdict once a writer starts
  //     writing explicit falses.
  const dropped = (at, extra) => ({ time: at, state: 'skipped', success: false, duration: 0, error: dropMsg(11), ...extra });
  const kinds = judgeDroppedFires([{ id: 'job_k1', preset: 'p1', cron: '0 * * * *', history: [
    dropped('2026-11-15T20:05:00Z', { catchUp: true }),
    dropped('2026-11-15T20:35:00Z', { catchUp: false }),
    dropped('2026-11-15T21:05:00Z', {}),
  ] }, { id: 'job_k2', preset: 'p2', cron: '0 * * * *', history: [
    dropped('2026-11-15T20:15:00Z', { catchUp: true }),
  ] }], { hours: 6, nowMs: DROP_NOW, width: 4 });
  arm('21l 三种行各一条 ⇒ 按种类分别计数（补跑 2／新鲜 1／未归因 1），且未归因单独点名',
    kinds.hit === 1
    && /新鲜轮次 1 轮、补跑 2 轮、未归因 1 轮/.test(kinds.lines.join('\n')),
    JSON.stringify(kinds.lines));

  const onlyCatchUp = judgeDroppedFires([{ id: 'job_c1', preset: 'p1', cron: '0 * * * *', history: [
    dropped('2026-11-15T20:05:00Z', { catchUp: true }),
  ] }], { hours: 6, nowMs: DROP_NOW, width: 4 });
  arm('21m 全部是补跑 ⇒ 新鲜计 0，且不许出现「未归因」字样（缺席不当作新鲜，也不虚报未归因）',
    onlyCatchUp.hit === 1
    && /新鲜轮次 0 轮、补跑 1 轮/.test(onlyCatchUp.lines.join('\n'))
    && !/未归因/.test(onlyCatchUp.lines.join('\n')),
    JSON.stringify(onlyCatchUp.lines));

  // 22. the PARTIAL current hour must not count, or every run of the gate in the
  //     first minutes of an hour reads as oversubscribed.
  r = judgeLaneCapacity([{ id: 'job_aaaaaa', history: fires([
    ['2026-11-15T20:05:00Z', 600], ['2026-11-15T21:05:00Z', 600], ['2026-11-15T22:05:00Z', 9000],
  ]) }], { hours: 6, nowMs: Date.parse('2026-11-15T22:10:00Z') });
  arm('22 当前不完整小时不计入', r.hit === 0, JSON.stringify(r.lines));

  // 22b. the OLDEST partial hour must not count either: a 45% reading from a
  //      half-covered hour would understate the very hour that matters.
  //      window 3h from 19:30 ⇒ edge hour 16Z; entries at 16:40 (excluded),
  //      17:05 and 18:05 (both complete), 19:05 (current hour, excluded).
  r = judgeLaneCapacity([{ id: 'job_aaaaaa', history: fires([
    ['2026-11-15T16:40:00Z', 9999], ['2026-11-15T17:05:00Z', 1500],
    ['2026-11-15T18:05:00Z', 4000], ['2026-11-15T19:05:00Z', 9999],
  ]) }], { hours: 3, nowMs: Date.parse('2026-11-15T19:30:00Z') });
  arm('22b 两端不完整小时都不计入', r.hit === 1 && /111%/.test(r.lines.join('\n')), JSON.stringify(r.lines));

  // 23. fewer than two complete hours ⇒ 判不出, never a green
  r = judgeLaneCapacity([{ id: 'job_aaaaaa', history: fires([['2026-11-15T22:05:00Z', 100]]) }],
    { hours: 6, nowMs: Date.parse('2026-11-15T22:10:00Z') });
  arm('23 完整小时不足 ⇒ 判不出', r.undet === 1 && r.hit === 0, JSON.stringify(r.lines));

  // 19. a job that is not in jobs.json at all is a hit, not a silent skip
  r = judgeRole({ role: 'R', memberId: 'm1', jobId: 'nope' }, { ...base, jobs: [] });
  arm('19 作业不存在 ⇒ 命中', r.hit === 1, JSON.stringify(r.lines));

  console.log(`自证：${total - fails.length}/${total} 通过`);
  for (const f of fails) console.log('  ✗ ' + f);
  return fails.length ? 1 : 0;
}

// ── entry ───────────────────────────────────────────────────────────────────
function main(argv) {
  const mode = argv[0] || '--scan';
  if (mode === '--self-test') return selfTest();
  if (mode !== '--scan') { console.error(`未知模式 ${mode}（--scan | --self-test）`); return 2; }
  const args = argv.slice(1);
  const pick = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const root = pick('--root') || process.env.FD_ACC_ROOT || '/data';
  const nowRaw = pick('--now') || process.env.FD_ACC_NOW;
  const nowMs = nowRaw ? Date.parse(nowRaw) : Date.now();
  if (Number.isNaN(nowMs)) { console.error('--now 解析不出'); return 2; }
  const fleetRe = new RegExp(pick('--fleet') || process.env.FD_ACC_FLEET || '投研');
  const podStartRaw = process.env.FD_ACC_POD_START || '';
  const podStartMs = podStartRaw ? Date.parse(podStartRaw) : null;
  const res = scan({ root, nowMs, fleetRe, podStartMs: Number.isNaN(podStartMs) ? null : podStartMs });
  console.log(res.lines.join('\n'));
  console.log(`VERDICT hit=${res.hit} warn=${res.warn} undet=${res.undet}`);
  if (res.undet) return 2;
  if (res.hit) return 1;
  return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { lastTickMs, nextTickMs, parseCron, judgeRole, judgeHourly, judgeSlots, judgeProvenance, judgeLaneCapacity, judgeDroppedFires, laneWidth, roleBindings, scan };
