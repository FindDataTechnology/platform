#!/usr/bin/env node
// 幕僚团实化（add-personal-staff-fleet 3.x）——**不经过市场**的落地路径。
//
// 为什么不用 from-template：模板的岗位 target 是 `pack-preset`，要求包已上架可部署。
// 而内部幕僚团按设计不入市场（publicFacing 是 pack 级，内外必须两个 pack）。
// 所以 cell 侧落地走：5 个自定义预设（user.*）+ 直接建队建岗 + 编排边。
//
//   node scripts/staff-fleet-apply.mjs --dry          # 只打印将要发生的调用
//   PLATFORM_URL=https://... PLATFORM_COOKIE=... node scripts/staff-fleet-apply.mjs
//
// 身份：必须用**主人本人**的 cookie。内部桥只开七条 POST，PUT /delegation-policy 不在内，
// 机器身份调它必 401 —— 所以这一步只能由人（或本人的 cookie）执行。
//
// 幂等：预设按 name 查重，舰队按 name 查重，岗位按 targetId 查重；已存在的跳过并如实报告。
//
// 前置（脚本会自己检查并拒绝继续）：
//   - 至少一个委托域已授予：审计官岗位没有可复核的判断域时，建岗会被 400 拒绝
//     （服务端原文：auditor requires a configured mandate — configure one domain first）

import { readFileSync } from "node:fs";
import path from "node:path";

const SEED = path.join(import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname), "..", "docs", "fleet-templates", "personal-staff-fleet.seed.json");
const FLEET_NAME = "个人幕僚团";

const dry = process.argv.includes("--dry");
const url = (process.env.PLATFORM_URL || "").replace(/\/+$/, "");
const cookie = process.env.PLATFORM_COOKIE || "";

function die(msg) {
  console.error(`[staff-fleet] FAILED: ${msg}`);
  process.exit(1);
}

async function api(method, p, body) {
  const res = await fetch(`${url}${p}`, {
    method,
    headers: { cookie, "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* 非 JSON 原样留 */ }
  if (!res.ok) {
    const detail = json?.error || text.slice(0, 200);
    const err = new Error(`${method} ${p} → ${res.status}: ${detail}`);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

function plan(seed) {
  return seed.agents.map((a) => ({
    key: a.id,
    name: a.name,
    persona: a.persona,
    isAuditor: a.id === "sta-auditor",
  }));
}

async function main() {
  const seed = JSON.parse(readFileSync(SEED, "utf8"));
  const wanted = plan(seed);
  const members = seed.fleet.members;

  if (dry && (!url || !cookie)) {
    console.log(`[staff-fleet] dry-run（无 PLATFORM_URL/COOKIE，只打印计划）`);
    console.log(`  预设 ${wanted.length} 个：${wanted.map((w) => w.key).join(", ")}`);
    console.log(`  舰队「${FLEET_NAME}」+ ${members.length} 个岗位：`);
    for (const m of members) {
      const parent = m.parentRef ? ` · parent=${m.parentRef}` : "";
      console.log(`    - ${m.title} target=${m.target.kind}:${m.target.presetId ?? m.target.id}${parent}`);
    }
    const edges = seed.fleet.orchestration?.edges ?? [];
    console.log(`  编排边 ${edges.length} 条：${edges.map((e) => `${e.kind}:${e.from}→${e.to}`).join(", ")}`);
    console.log(`\n（真跑：设 PLATFORM_URL 与 PLATFORM_COOKIE 后去掉 --dry）`);
    return;
  }
  if (!url || !cookie) die("缺 PLATFORM_URL 或 PLATFORM_COOKIE（必须是主人本人的 cookie）");

  // ── 1. 预设 ────────────────────────────────────────────────────────────
  const presetIdByKey = {};
  let existingPresets = [];
  try {
    const out = await api("GET", "/api/agent/presets");
    existingPresets = out?.presets ?? [];
  } catch (e) {
    die(`读预设失败：${e.message}`);
  }
  for (const w of wanted) {
    const hit = existingPresets.find((p) => p.name === w.name);
    if (hit) {
      presetIdByKey[w.key] = hit.id;
      console.log(`[staff-fleet] 预设已存在，跳过：${w.name} (${hit.id})`);
      continue;
    }
    const body = { name: w.name, persona: w.persona, skills: [], mcpServers: [], mcpTools: {} };
    if (dry) { console.log(`[staff-fleet] would POST /api/agent/presets name=${w.name}`); continue; }
    const out = await api("POST", "/api/agent/presets", body);
    const id = out?.preset?.id ?? out?.id;
    if (!id) die(`建预设没有返回 id：${w.name}`);
    presetIdByKey[w.key] = id;
    console.log(`[staff-fleet] 预设已建：${w.name} → ${id}`);
  }
  if (dry) return;

  // ── 2. 舰队 ────────────────────────────────────────────────────────────
  let fleet = null;
  const list = await api("GET", "/api/fleets");
  fleet = (list?.fleets ?? []).find((f) => f.name === FLEET_NAME) ?? null;
  if (fleet) {
    console.log(`[staff-fleet] 舰队已存在：${fleet.name} (${fleet.id})`);
  } else {
    const out = await api("POST", "/api/fleets", { name: FLEET_NAME });
    fleet = out?.fleet;
    if (!fleet?.id) die("建队没有返回 fleet.id");
    console.log(`[staff-fleet] 舰队已建：${fleet.name} (${fleet.id})`);
  }

  // ── 3. 岗位（按 ref 顺序，父岗先建）──────────────────────────────────────
  const detail = await api("GET", `/api/fleets/${fleet.id}`);
  const existingMembers = detail?.members ?? detail?.fleet?.members ?? [];
  // 读面是嵌套的 `target:{kind,id}`，写面是扁平的 `targetKind/targetId`。此前只读扁平那半，
  // 判重键恒为 "undefined:undefined" —— 幂等**看着**在工作（创建被 409 挡住），实际每个岗位
  // 都没拿到 id，于是编排边被静默丢掉（这一步是 3.x 的验收点，不能靠 409 兜）。
  const targetOf = (m) => ({
    kind: m.target?.kind ?? m.targetKind ?? null,
    id: m.target?.id ?? m.targetId ?? null,
  });
  const byTarget = new Map(
    existingMembers
      .map((m) => ({ m, t: targetOf(m) }))
      .filter(({ t }) => t.kind && t.id)
      .map(({ m, t }) => [`${t.kind}:${t.id}`, m]),
  );
  const memberIdByRef = {};

  for (const m of members) {
    const isAuditor = m.target.kind === "auditor";
    const targetKind = isAuditor ? "auditor" : "persona";
    // 审计官同样解析自聊天花名册（resolveTarget 的 persona 支路），所以 targetId 必须是
    // **真的进了花名册的那个 id**。种子里的 `sta-auditor` 是包内预设键——只有"包已安装"
    // 那条路才成立；不经市场时真实 id 是 user.preset-N，这里必须过同一套映射，否则建岗
    // 400：auditor persona 'sta-auditor' is not in the catalog chat roster。
    const targetId = isAuditor
      ? (presetIdByKey[m.target.id] ?? m.target.id)
      : (presetIdByKey[m.target.presetId] ?? m.target.presetId);
    const hit = byTarget.get(`${targetKind}:${targetId}`);
    if (hit) {
      memberIdByRef[m.ref] = hit.id;
      // 「幂等」不等于「跳过」：已存在的岗位也要收敛到种子声明的状态。
      // 首次落地时五岗 kpiSlots 是空的，而 `slotsAccepted = 提交键 ∩ 声明键`
      // ⇒ 报数全判 UNRECOGNIZED、不进 KPI 卡（生产那条"报数静默丢弃"即此机制）。
      // 只补 KPI 槽位这一类纯声明字段；其它维度（模型/承载/节奏）不在这里改，
      // 免得把主人后来手工调过的配置覆盖掉。
      const wantSlots = m.kpiSlots ?? [];
      const haveKeys = (hit.kpiSlots ?? []).map((s) => s.key).join(",");
      const wantKeys = wantSlots.map((s) => s.key).join(",");
      if (haveKeys !== wantKeys) {
        try {
          await api("PATCH", `/api/fleets/${fleet.id}/members/${hit.id}`, { kpiSlots: wantSlots });
          console.log(`[staff-fleet] 岗位已存在，KPI 槽位已对齐：${m.title} → [${wantKeys || "空"}]`);
        } catch (e) {
          console.warn(`[staff-fleet] 岗位已存在，但 KPI 槽位对齐失败：${m.title} — ${e.message}`);
        }
      } else {
        console.log(`[staff-fleet] 岗位已存在，跳过：${m.title} (${hit.id})`);
      }
      continue;
    }
    const body = {
      title: m.title,
      targetKind,
      targetId,
      parentId: m.parentRef ? memberIdByRef[m.parentRef] ?? null : null,
      kpiSlots: m.kpiSlots ?? [],
    };
    try {
      const out = await api("POST", `/api/fleets/${fleet.id}/members`, body);
      memberIdByRef[m.ref] = out?.member?.id;
      console.log(`[staff-fleet] 岗位已建：${m.title} (${memberIdByRef[m.ref]})`);
    } catch (e) {
      if (isAuditor && e.status === 400 && /mandate/i.test(String(e.body?.error))) {
        die("审计官建岗被拒：需要先授予至少一个委托域（改的是主人的授权边界，只能本人做）");
      }
      if (e.status === 409) {
        // 承载被占（同一 preset 已在岗）。不能只打一行日志就 continue——那样这个岗位
        // 在 memberIdByRef 里是空的，依赖它的编排边会被静默过滤掉。回读一次拿真 id。
        console.log(`[staff-fleet] 岗位的承载已被占用：${m.title} — ${e.body?.error ?? ""}`);
        const again = await api("GET", `/api/fleets/${fleet.id}`);
        const list = again?.members ?? again?.fleet?.members ?? [];
        const found = list.find((x) => {
          const t = targetOf(x);
          return t.kind === targetKind && t.id === targetId;
        });
        if (found) {
          memberIdByRef[m.ref] = found.id;
          console.log(`[staff-fleet]   已回读其岗位 id：${found.id}（编排边沿用它）`);
        } else {
          console.warn(`[staff-fleet]   回读不到该岗位——依赖它的编排边会被跳过`);
        }
        continue;
      }
      throw e;
    }
  }

  // ── 4. 编排边 ──────────────────────────────────────────────────────────
  const edges = (seed.fleet.orchestration?.edges ?? []).map((e) => ({
    kind: e.kind,
    from: memberIdByRef[e.from],
    to: memberIdByRef[e.to],
  })).filter((e) => e.from && e.to);
  if (edges.length) {
    // 审计官不进工作图（服务端 auditor_not_orchestratable）：种子保证没有它的边，
    // 这里再挡一次，免得有人手工改种子后踩到一条 400 却读不懂报错。
    const auditorId = memberIdByRef[members.find((m) => m.target.kind === "auditor")?.ref];
    if (auditorId && edges.some((e) => e.from === auditorId || e.to === auditorId)) {
      die("编排边里出现了审计官——它不进工作图（reviewer 的判断经拍板队列回到主人，不走编导边）");
    }
    try {
      // 信封形状是硬要求：服务端 `toCockpitDraft` 把 body 摊平进 draft，而
      // `applyFleetDraft` 只认 `draft.fleet.orchestration`。把 edges 放在顶层，
      // 服务端会**静默忽略并回 ok:true**（"section-less draft never clears"那条分支），
      // 结果是 200 绿着、库里 orchestration 仍是 null —— 实测踩过一次。
      //
      // mode 刻意不写：`supervisor` 是读时展开的**全员互派**权限，比这里声明的三条边宽。
      // mode=null ⇒ dispatchAllowed 只认声明的边（fleet-orchestration:363/373）。
      const out = await api("POST", `/api/fleets/${fleet.id}/orchestration/apply`, {
        fleet: { orchestration: { edges } },
      });
      const written = await api("GET", `/api/fleets/${fleet.id}/cockpit`);
      const landed = written?.orchestration?.edges?.length ?? 0;
      console.log(`[staff-fleet] 编排已应用：回执 ${out?.ok ? "ok" : "非 ok"} · 读回 ${landed} 条边`);
      if (landed === 0) {
        die("编排回执 ok 但读回 0 条边——不要相信回执，先查信封形状");
      }
    } catch (e) {
      console.error(`[staff-fleet] 编排应用失败（岗位已建，可稍后重试）：${e.message}`);
      process.exit(3);
    }
  }

  console.log(`\n[staff-fleet] 完成。下一步（都是人做/人看）：`);
  console.log(`  1) 驾驶舱核对五个岗位与编排图：${url}/fleets/${fleet.id}`);
  console.log(`  2) 授域（审计官准入 + 对外起草的前提）：PUT /api/fleets/delegation-policy`);
  console.log(`  3) 点火：启动团队（生而全队暂停是设计纪律）`);
}

await main();
