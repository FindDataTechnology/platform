#!/usr/bin/env node
// ── 官方 starter 内容改版发布脚本（modernize-official-starter-agents task 2.1）─
//
// 对 staging/modernize.json 里的 5 支 starter 团队逐支执行：
//   登录读面取全量 manifest → 合并（persona 按 agents[].id 精确替换 +
//   skills 追加重名跳过 + mcpServers 追加重复跳过）→ 结构零 diff 断言
//   （编队/cadence/kpiSlots/guide/包名必须与 v6 逐字一致）→ 槽位逐字保留
   // 断言（v6 persona 里的 report_status 槽位名单必须全部出现在 v7）→
//   validatePackManifest（发布门同函数）→ POST /api/packs（同 id v+1）。
//
// 用法：
//   PAAS_SESSION='<cookie>' BASE_URL='https://…' node publish-modernize.mjs            # dry-run（默认）
//   同上 + --fire                                                                       # 真发布

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validatePackManifest } from "../../../../lib/pack-manifest.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIRE = process.argv.includes("--fire");
const BASE = process.env.BASE_URL || "";
const COOKIE = process.env.PAAS_SESSION || "";
const AUTHOR = "aloadtree@gmail.com";

if (!BASE || !COOKIE) {
  console.error("需要 BASE_URL 与 PAAS_SESSION");
  process.exit(1);
}
const overlays = JSON.parse(fs.readFileSync(path.join(here, "modernize.json"), "utf8"));

const call = async (apiPath, init) => {
  const r = await fetch(`${BASE}${apiPath}`, {
    ...init,
    headers: { "content-type": "application/json", cookie: `paas_session=${COOKIE}`, ...(init?.headers ?? {}) },
  });
  const text = await r.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text.slice(0, 300); }
  return { status: r.status, body };
};

// v6 persona 里声明的 report_status 槽位名单——改版必须逐字保留。
const SLOTS = {
  "service-lead": ["open_tickets"],
  "service-agent": ["handled", "first_reply_min"],
  "service-qa": ["qa_pass_rate", "sampled"],
  "company-ceo": ["patrol_notes"],
  "company-oss": ["stars_week", "issues_open"],
  "company-invest": ["pnl_day", "watch_count"],
  "content-editor": ["brief_notes"],
  "content-planner": ["topics_pool", "picked"],
  "content-writer": ["drafts_done", "words_week"],
  "invest-chief": ["morning_notes"],
  "invest-macro": ["macro_view", "watch_count"],
  "invest-sector": ["sector_pick", "top_ticker"],
  "intel-chief": ["brief_digest", "sources_covered"],
  "intel-tech": ["tech_hits", "top_story"],
  "intel-market": ["market_moves", "watch_alerts"],
};

const me = await call("/api/auth/me", { method: "GET" });
const email = me.body?.user?.email ?? me.body?.email;
if (email !== AUTHOR) {
  console.error(`身份闸失败：会话是 ${email ?? me.status}，不是 ${AUTHOR}`);
  process.exit(1);
}
console.log(`身份闸 ✓ ${email}${FIRE ? "（FIRE 模式）" : "（dry-run）"}`);

let failures = 0;
for (const [pid, ov] of Object.entries(overlays)) {
  const tag = pid.slice(0, 8);
  const detail = await call(`/api/packs/${pid}`, { method: "GET" });
  if (detail.status !== 200) { console.error(`✗ ${tag} 读面失败 ${detail.status}`); failures++; continue; }
  if (detail.body.authorEmail !== AUTHOR) { console.error(`✗ ${tag} 作者漂移：${detail.body.authorEmail}`); failures++; continue; }
  const v6 = detail.body.manifest;
  const m = structuredClone(v6);

  // ── persona 按 id 精确替换 ──
  let personaHits = 0;
  for (const a of m.agents ?? []) {
    const np = ov.personas[a.id];
    if (!np) { console.error(`✗ ${tag} overlay 缺 persona：${a.id}`); failures++; continue; }
    // 槽位逐字保留断言
    for (const slot of SLOTS[a.id] ?? []) {
      if (!np.includes(slot)) { console.error(`✗ ${tag}/${a.id} 槽位丢失：${slot}`); failures++; }
    }
    // 纪律句逐字保留断言
    if (!["绝不编造", "不给结论", "不替其编造"].some((w) => np.includes(w))) { console.error(`✗ ${tag}/${a.id} 诚实纪律句丢失`); failures++; }
    a.persona = np;
    personaHits++;
  }
  if (personaHits !== (m.agents ?? []).length) { failures++; continue; }

  // ── skills upsert（同包升级=替换自家同名技能；重名跳过语义会让升级发不出去）──
  for (const s of ov.skills ?? []) {
    const i = (m.skills ?? []).findIndex((x) => x.name === s.name);
    if (i >= 0) m.skills[i] = s;
    else m.skills = [...(m.skills ?? []), s];
  }

  // ── mcpServers upsert（同包升级=按 registryName 替换）──
  for (const x of ov.mcpServers ?? []) {
    const i = (m.mcpServers ?? []).findIndex((y) => y.registryName === x.registryName);
    if (i >= 0) m.mcpServers[i] = x;
    else m.mcpServers = [...(m.mcpServers ?? []), x];
  }

  // ── 结构零 diff 断言：编队/节拍/身份/包名/报告必须与 v6 逐字一致 ──
  const structureKeys = ["fleet", "guide", "notes", "name", "description", "category", "tags"];
  for (const k of structureKeys) {
    if (JSON.stringify(m[k] ?? null) !== JSON.stringify(v6[k] ?? null)) {
      console.error(`✗ ${tag} 结构漂移：${k} 与 v6 不一致`);
      failures++;
    }
  }
  // mcp 改动必须只有追加（v6 的既有 server 一条不许动）
  for (const x of v6.mcpServers ?? []) {
    if (!JSON.stringify(m.mcpServers ?? []).includes(JSON.stringify(x))) {
      console.error(`✗ ${tag} 既有 mcpServer 被改动：${x.registryName}`);
      failures++;
    }
  }

  const errors = validatePackManifest(m);
  if (errors.length) {
    console.error(`✗ ${tag} 合并后未过发布门：`);
    for (const e of errors.slice(0, 5)) console.error("   ", e.entry ?? "-", e.error);
    failures++;
    continue;
  }
  if (JSON.stringify(m) === JSON.stringify(v6)) {
    console.log(`= [跳过] ${detail.body.name} 内容已与 overlay 一致（当前 v${detail.body.version}）`);
    continue;
  }
  if (!FIRE) {
    console.log(`✓ [dry-run] ${detail.body.name} v${detail.body.version} → v${detail.body.version + 1}（persona×${personaHits} skills→${(m.skills ?? []).length} mcp→${(m.mcpServers ?? []).length}，校验绿）`);
    continue;
  }
  const pub = await call("/api/packs", { method: "POST", body: JSON.stringify({ packId: pid, manifest: m }) });
  if (pub.status === 200 || pub.status === 201) {
    console.log(`✓ [发布] ${detail.body.name} → v${pub.body?.version ?? "?"}`);
  } else {
    console.error(`✗ [发布] ${detail.body.name} ${pub.status}:`, typeof pub.body === "string" ? pub.body : JSON.stringify(pub.body).slice(0, 300));
    failures++;
  }
}
console.log(failures ? `\n${failures} 支失败` : "\n全部完成");
process.exit(failures ? 1 : 0);
