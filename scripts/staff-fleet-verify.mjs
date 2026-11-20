#!/usr/bin/env node
// 幕僚团体检（add-personal-staff-fleet 验收）——回答一个问题：**现在这套东西能用吗**。
//
//   PLATFORM_URL=https://… PLATFORM_COOKIE=… node scripts/staff-fleet-verify.mjs
//
// 三层，逐层给判据，不合并成一句"看起来还行"：
//   L1 结构   : 舰队存在 / 五岗在岗 / 审计官就位 / 编排边齐 / 没有审计官进边
//   L2 授权   : 委托状里有几个域、各是什么档位（审计官准入与对外起草都挂在这上面）
//   L3 记忆   : 能看到几张进度页、最新一张的 as_of 距今多久
//
// 退出码：0 = 三层都过（L3 允许"尚无页"但会明说）；1 = 有失败项。
//
// 诚实的边界：L3 用**主人个人身份**读，看到的是个人根下的页。它能证明"页存在且新鲜"，
// **不能**证明"舰队岗位读得到"——后者要跑一个真实回合看 memory_query（脚本会打印这条命令）。

const FLEET_NAME = "个人幕僚团";
const REQUIRED = ["幕僚长", "评审官", "侦查官", "书记", "审计官"];

const url = (process.env.PLATFORM_URL || "").replace(/\/+$/, "");
const cookie = process.env.PLATFORM_COOKIE || "";
// 主人邮箱决定成员令牌的归属（memberTokenFor 的 ownerEmail）。优先用会话自己的身份，
// 只有读不到 /api/auth/me 时才退回 env —— 猜一个邮箱会让令牌铸到别人的根下。
let OWNER_EMAIL = process.env.OWNER_EMAIL || "";

const rows = [];
function report(level, ok, label, detail = "") {
  rows.push({ level, ok, label, detail });
  const mark = ok === true ? "✓" : ok === false ? "✗" : "!";
  console.log(`${mark} [${level}] ${label}${detail ? ` — ${detail}` : ""}`);
}

async function api(p) {
  const res = await fetch(`${url}${p}`, { headers: { cookie } });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* 非 JSON */ }
  if (!res.ok) {
    const err = new Error(`${p} → ${res.status}: ${json?.error ?? text.slice(0, 120)}`);
    err.status = res.status;
    throw err;
  }
  return json;
}

async function main() {
  if (!url || !cookie) {
    console.error("[verify] 缺 PLATFORM_URL 或 PLATFORM_COOKIE（必须是主人本人的 cookie）");
    process.exit(2);
  }

  // ── L1 结构 ────────────────────────────────────────────────────────────
  if (!OWNER_EMAIL) {
    try {
      const me = await api("/api/auth/me");
      OWNER_EMAIL = String(me?.email ?? "");
    } catch { /* L3 会如实报「未验」 */ }
  }
  let fleet = null;
  try {
    const list = await api("/api/fleets");
    fleet = (list?.fleets ?? []).find((f) => f.name === FLEET_NAME) ?? null;
  } catch (e) {
    report("L1", false, "读舰队列表", e.message);
    process.exit(1);
  }
  report("L1", Boolean(fleet), `舰队「${FLEET_NAME}」存在`, fleet ? fleet.id : "先跑 staff-fleet-apply.mjs");
  if (!fleet) finish();

  let members = [];
  // 读面是嵌套的 `target:{kind,id}`，写面是扁平的 `targetKind/targetId`。只读扁平那半，
  // 审计官永远查不到 —— 岗位明明建好了却报「需先授域」，是假红，而且会把人引去改授权边界。
  const targetOf = (m) => ({
    kind: m.target?.kind ?? m.targetKind ?? null,
    id: m.target?.id ?? m.targetId ?? null,
  });
  let detail = null;
  try {
    // cockpit 才是编排的真读面：`GET /api/fleets/:id` 的响应里根本没有 orchestration 这个键
    // （keys = fleet,members,statusCounts,openDecisions,decisionPolicy,blueprintId）。
    // 拿详情去判边，会得到「0 条边」的假红——而库里其实有边。
    detail = await api(`/api/fleets/${fleet.id}/cockpit`);
    members = detail?.members ?? detail?.fleet?.members ?? [];
  } catch (e) {
    report("L1", false, "读舰队详情（cockpit）", e.message);
    finish();
  }

  const titles = new Set(members.map((m) => m.title));
  const missing = REQUIRED.filter((t) => !titles.has(t));
  report("L1", missing.length === 0, "五个岗位齐", missing.length ? `缺：${missing.join("、")}` : `${members.length} 个岗位`);

  const auditor = members.find((m) => targetOf(m).kind === "auditor");
  report("L1", Boolean(auditor), "审计官就位",
    auditor ? `${auditor.id} → ${targetOf(auditor).id}` : "没有 auditor 岗位：建岗会被 400，先授予至少一个 draft 档的委托域");

  const cadenced = members.filter((m) => m.cadence && m.cadence.cron);
  report("L1", cadenced.length === 0, "无定时回合（会话型为主）",
    cadenced.length ? `有节奏的岗：${cadenced.map((m) => m.title).join("、")}（书记的节奏应等进料接通后再开）` : "全部会话型");

  const carrierNote = members.filter((m) => m.carrier && m.carrier !== "auto").map((m) => `${m.title}=${m.carrier}`);
  report("L1", null, "承载（信息项）", carrierNote.length ? carrierNote.join(" · ") : "全部 auto（跑在 cell 主链）");

  // 编排边：从详情里读（字段名兼容两种形状）
  const edges = detail?.orchestration?.edges ?? [];
  const auditorInEdges = auditor ? edges.some((e) => e.from === auditor.id || e.to === auditor.id) : false;
  report("L1", !auditorInEdges, "审计官不在编导边里",
    auditorInEdges ? "服务端本该拒绝（auditor_not_orchestratable）— 这条要查" : `${edges.length} 条边`);

  // ── L2 授权 ────────────────────────────────────────────────────────────
  try {
    const pol = await api(`/api/fleets/delegation-policy?fleetId=${encodeURIComponent(fleet.id)}`);
    const domains = pol?.mandate?.domains ?? {};
    const names = Object.keys(domains);
    const detailText = names.length
      ? names.map((d) => `${d}=${domains[d]?.mode ?? "?"}`).join(" · ")
      : "没有任何域被授予（审计官准入与对外起草都要它）";
    report("L2", names.length > 0, "委托状有域", detailText);
    const hasComms = names.includes("external-comms");
    report("L2", hasComms, "external-comms 已授（对外起草的前提）",
      hasComms ? `档位 ${domains["external-comms"]?.mode}` : "未授：微信里只能给建议，不能出稿");
  } catch (e) {
    report("L2", false, "读委托状", e.message);
  }

  // ── L3 记忆 ────────────────────────────────────────────────────────────
  // 三个读者要分开看，因为它们的根不同（2026-11-12 实测，不是推断）：
  //   ① 主人面（person 令牌）读 u/ 与遗留 f/，看不到 d/<fleetId>/；
  //   ② 成员令牌读得到 d/<fleetId>/shared —— 但这只证明**令牌能读**；
  //   ③ 交互会话（网页/微信）跑在主 dsh 子进程上、用共享 patch = 主人 person 令牌
  //      （成员私有 patch 只挂 worker slot，见 server/worker-slots.js spawnWorker）。
  //      所以"岗位在会话里能读到自己的分区"**不成立**——进度页必须写主人根，
  //      否则书记会如实答「进度未知：进料未接通」（实测踩过）。
  try {
    const m = await api("/api/memory/entries?limit=100");
    const items = m?.items ?? m?.entries ?? [];
    // 条目字段是 path/title/project/type/ts —— 没有 metadata（按 metadata.kind 过滤只会恒空）
    const progress = items.filter((it) => /^项目进度/.test(String(it?.title ?? "")));
    const newest = progress[0];
    report("L3", progress.length > 0, "进度页（主人面 / 会话读者真正能看到的根）",
      progress.length
        ? `${progress.length} 张，最新 ${newest?.project}/${String(newest?.path ?? "").split("/").pop()} · ${newest?.ts ?? "无时间"}`
        : "0 张——网页/微信里问进度会得到「进度未知」；先跑 ~/.fd/progress-feed-run.sh");
  } catch (e) {
    report("L3", false, "读记忆（主人面）", `${e.message}（503 = 记忆服务未配或不通）`);
  }

  try {
    const clerk = members.find((m) => m.title === "书记");
    const clerkId = clerk?.id;
    if (!process.env.CELL_MEMORY_URL) {
      report("L3", null, "成员令牌可读 d/<fleetId>/shared", "未验：缺 CELL_MEMORY_URL（这条要在 pod 内跑）");
    } else if (!clerkId) {
      report("L3", false, "成员令牌可读 d/<fleetId>/shared", "没有「书记」岗位");
    } else {
      const { cellMemoryConfig, memberTokenFor } = await import("@finddatatechnology/yongyi-client");
      const cfg = cellMemoryConfig(process.env);
      const token = await memberTokenFor(cfg, { packId: fleet.id, memberId: clerkId, ownerEmail: OWNER_EMAIL });
      const u = new URL(`${cfg.url}/digest`);
      u.searchParams.set("project", "shared");
      u.searchParams.set("q", "项目进度");
      u.searchParams.set("k", "5");
      u.searchParams.set("budget", "800");
      const r = await fetch(u, { headers: { authorization: `Bearer ${token}` } });
      const j = await r.json().catch(() => null);
      const hit = /项目进度/.test(String(j?.digest ?? ""));
      // 标成 null 而不是 true：这条验的是"令牌面通了"，与"岗位的会话回合读得到"是两件事。
      report("L3", null, "成员令牌可读 d/<fleetId>/shared（信息项，≠ 会话身份）",
        hit
          ? `通了${/keyword-only/.test(String(j?.model_note ?? "")) ? "（向量车道降级，关键词召回）" : ""}；注意会话走共享 patch，读到的是主人根`
          : `读不到（${r.status}）；共享分区没内容或写时用的不是成员令牌`);
    }
  } catch (e) {
    report("L3", null, "成员令牌可读 d/<fleetId>/shared", `未验：${e.message}`);
  }
  report("L3", null, "舰队可达性（真实回合，已实测 2026-11-12）",
    `用户-preset-7 起会话问「最近做到哪了」→ 回答带 as_of 与「距今约 N 分钟」；复跑判据见 docs/personal-staff-runbook.md`);

  finish();
}

function finish() {
  const failed = rows.filter((r) => r.ok === false).length;
  const warned = rows.filter((r) => r.ok === null).length;
  console.log(`\n[verify] ${failed ? `失败 ${failed} 项` : "无失败项"}${warned ? ` · ${warned} 项需人看` : ""}`);
  process.exit(failed ? 1 : 0);
}

await main();
