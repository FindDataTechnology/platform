#!/usr/bin/env node
// ── 官方业务团队内容改版发布脚本（modernize-official-business-teams task 2）─
//
// 对 staging/teams/*.json 的 10 支业务团队逐支执行：
//   登录读面取全量 manifest → 合并（persona 按 agents[].id 精确替换 +
//   skills 按 name upsert + mcpServers 按 registryName upsert）→ 结构零 diff
//   断言（除 agents/skills/mcpServers 外全部键逐字一致；agent 的非 persona
//   字段也逐字一致）→ 内容基线断言（430 字下限 / 结构化小节 / 槽位逐字保留，
//   槽位名单从 staging/source-snapshot.json 的改版前 persona 自动派生）→
//   mcp allowTools 只许取 registry-allowtools.json 里的真实工具名 →
//   validatePackManifest（发布门同函数）→ POST /api/packs（同 id v+1）。
//
// 用法：
//   PAAS_SESSION='<cookie>' BASE_URL='https://…' node publish-batch2.mjs            # dry-run（默认）
//   同上 + --fire                                                                   # 真发布
//
// 发布身份：aloadtree@gmail.com（作者门）；会话必须带 platform 组（限流豁免，
// 否则 10/h 会把批量发布打成 429）。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validatePackManifest } from "../../../../lib/pack-manifest.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIRE = process.argv.includes("--fire");
const BASE = process.env.BASE_URL || "";
const COOKIE = process.env.PAAS_SESSION || "";
const AUTHOR = "aloadtree@gmail.com";
const PACING_MS = Number(process.env.PUBLISH_PACING_MS || 6500);

if (!BASE || !COOKIE) {
  console.error("需要 BASE_URL 与 PAAS_SESSION");
  process.exit(1);
}

const snapshot = JSON.parse(fs.readFileSync(path.join(here, "source-snapshot.json"), "utf8"));
const registryAllow = JSON.parse(fs.readFileSync(path.join(here, "registry-allowtools.json"), "utf8"));
const teamFiles = fs.readdirSync(path.join(here, "teams")).filter((f) => f.endsWith(".json")).sort();
const teams = teamFiles.map((f) => JSON.parse(fs.readFileSync(path.join(here, "teams", f), "utf8")));
if (teams.length !== Object.keys(snapshot).length) {
  console.error(`✗ 覆盖不齐：snapshot ${Object.keys(snapshot).length} 支，teams/ ${teams.length} 支`);
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36";
const call = async (apiPath, init) => {
  const r = await fetch(`${BASE}${apiPath}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      "user-agent": UA,
      referer: `${BASE}/packs`,
      cookie: `paas_session=${COOKIE}`,
      ...(init?.headers ?? {}),
    },
  });
  const text = await r.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text.slice(0, 300); }
  return { status: r.status, body };
};

// 从改版前 persona 自动派生槽位名单：匹配「槽位：a/b」「槽位 a/b」，只收 report_status 语境。
const deriveSlots = (persona) => {
  const out = new Set();
  for (const m of persona.matchAll(/槽位[：: ]+([A-Za-z0-9_/、,， ]+)/g)) {
    for (const tok of m[1].split(/[/、,，\s]+/)) if (/^[a-z][a-z0-9_]{2,}$/.test(tok)) out.add(tok);
  }
  return [...out];
};

const me = await call("/api/auth/me", { method: "GET" });
const email = me.body?.user?.email ?? me.body?.email;
if (email !== AUTHOR) {
  console.error(`身份闸失败：会话是 ${email ?? me.status}，不是 ${AUTHOR}`);
  process.exit(1);
}
console.log(`身份闸 ✓ ${email}${FIRE ? "（FIRE 模式）" : "（dry-run）"}`);

let failures = 0;
let fired = 0;
for (const team of teams) {
  const pid = team.packId;
  const tag = snapshot[pid]?.name ?? pid.slice(0, 8);
  const prev = snapshot[pid];
  if (!prev) { console.error(`✗ ${tag}: 快照缺此包`); failures++; continue; }

  const detail = await call(`/api/packs/${pid}`, { method: "GET" });
  if (detail.status !== 200) { console.error(`✗ ${tag} 读面失败 ${detail.status}`); failures++; continue; }
  if (detail.body.authorEmail !== AUTHOR) { console.error(`✗ ${tag} 作者漂移：${detail.body.authorEmail}`); failures++; continue; }
  const v = detail.body.manifest;
  const m = structuredClone(v);

  // ── 岗位覆盖：overlay 与现场 id 集合必须一一对应 ──
  const liveIds = (m.agents ?? []).map((a) => a.id).sort();
  const ovIds = Object.keys(team.personas).sort();
  if (JSON.stringify(liveIds) !== JSON.stringify(ovIds)) {
    console.error(`✗ ${tag} 岗位集合漂移：现场 ${liveIds} vs overlay ${ovIds}`);
    failures++; continue;
  }

  // ── persona 按 id 精确替换 + 内容基线 ──
  for (const a of m.agents ?? []) {
    const np = team.personas[a.id];
    const old = a.persona ?? "";
    if (np.length < 380) { console.error(`✗ ${tag}/${a.id} persona ${np.length} 字 < 380`); failures++; }
    if (!np.includes("【职责边界】")) { console.error(`✗ ${tag}/${a.id} 缺【职责边界】`); failures++; }
    if (!np.includes("【输出契约】") && !np.includes("【工作纪律】")) { console.error(`✗ ${tag}/${a.id} 缺契约/纪律小节`); failures++; }
    if (!["绝不编造", "不给结论", "不替其编造", "不臆造"].some((w) => np.includes(w))) {
      console.error(`✗ ${tag}/${a.id} 诚实纪律句丢失`); failures++;
    }
    if (!np.includes("report_status")) { console.error(`✗ ${tag}/${a.id} 缺 report_status 契约`); failures++; }
    if (np.includes("\\n")) { console.error(`✗ ${tag}/${a.id} persona 含字面 \\n 转义（换行没落地）`); failures++; }
    for (const slot of deriveSlots(old)) {
      if (!np.includes(slot)) { console.error(`✗ ${tag}/${a.id} 槽位丢失：${slot}`); failures++; }
    }
    a.persona = np;
  }

  // ── skills upsert（同包升级=替换自家同名技能，重名跳过会让新版发不出去）──
  for (const s of team.skills ?? []) {
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(s.name)) { console.error(`✗ ${tag} 技能名不合发布门字符集：${s.name}`); failures++; }
    if ((s.content ?? "").length < 200) { console.error(`✗ ${tag}/${s.name} 技能内容 < 200 字`); failures++; }
    if ((s.content ?? "").includes("\\n")) { console.error(`✗ ${tag}/${s.name} 技能内容含字面 \\n 转义`); failures++; }
    const i = (m.skills ?? []).findIndex((x) => x.name === s.name);
    if (i >= 0) m.skills[i] = s;
    else m.skills = [...(m.skills ?? []), s];
  }

  // ── mcpServers upsert + 工具名只许取 registry 真值 ──
  for (const x of team.mcpServers ?? []) {
    const known = registryAllow[x.registryName];
    if (!known) { console.error(`✗ ${tag} registryName 不在册：${x.registryName}`); failures++; continue; }
    const tools = x.allowTools ?? [];
    if (!tools.length) { console.error(`✗ ${tag}/${x.registryName} allowTools 为空（发布门要求真实工具名）`); failures++; }
    for (const t of tools) {
      if (!known.includes(t)) { console.error(`✗ ${tag}/${x.registryName} 工具名不在册：${t}`); failures++; }
    }
    const i = (m.mcpServers ?? []).findIndex((y) => y.registryName === x.registryName);
    if (i >= 0) m.mcpServers[i] = x;
    else m.mcpServers = [...(m.mcpServers ?? []), x];
  }

  // ── 结构零 diff：除三个内容桶外全部键逐字一致；agent 的非 persona 字段逐字一致 ──
  for (const k of new Set([...Object.keys(v), ...Object.keys(m)])) {
    if (["agents", "skills", "mcpServers"].includes(k)) continue;
    if (JSON.stringify(m[k] ?? null) !== JSON.stringify(v[k] ?? null)) {
      console.error(`✗ ${tag} 结构漂移：${k}`); failures++;
    }
  }
  const stripPersona = (agents) => JSON.stringify((agents ?? []).map(({ persona, ...rest }) => rest));
  if (stripPersona(m.agents) !== stripPersona(v.agents)) { console.error(`✗ ${tag} agent 非 persona 字段漂移`); failures++; }
  // 既有 mcpServer 一条不许被改（只许新增；同 registryName 的替换视为改，需显式 overlay——这里只允许新增）
  for (const x of v.mcpServers ?? []) {
    const after = (m.mcpServers ?? []).find((y) => y.registryName === x.registryName);
    if (!after) { console.error(`✗ ${tag} 既有 mcpServer 被删：${x.registryName}`); failures++; }
    else if (JSON.stringify(after) !== JSON.stringify(x)) { console.error(`✗ ${tag} 既有 mcpServer 被改：${x.registryName}`); failures++; }
  }

  const errors = validatePackManifest(m);
  if (errors.length) {
    console.error(`✗ ${tag} 合并后未过发布门：`);
    for (const e of errors.slice(0, 6)) console.error("   ", e.entry ?? "-", e.error);
    failures++; continue;
  }
  if (JSON.stringify(m) === JSON.stringify(v)) {
    console.log(`= [跳过] ${tag} 内容已与 overlay 一致（当前 v${detail.body.version}）`);
    continue;
  }
  if (!FIRE) {
    console.log(`✓ [dry-run] ${tag} v${detail.body.version} → v${detail.body.version + 1}（persona×${(m.agents ?? []).length} skills ${(v.skills ?? []).length}→${(m.skills ?? []).length} mcp ${(v.mcpServers ?? []).length}→${(m.mcpServers ?? []).length}，校验绿）`);
    continue;
  }
  await sleep(PACING_MS);
  const pub = await call("/api/packs", { method: "POST", body: JSON.stringify({ packId: pid, manifest: m }) });
  if (pub.status === 200 || pub.status === 201) {
    console.log(`✓ [发布] ${tag} → v${pub.body?.version ?? "?"}`);
    fired++;
  } else {
    console.error(`✗ [发布] ${tag} ${pub.status}:`, typeof pub.body === "string" ? pub.body : JSON.stringify(pub.body).slice(0, 300));
    failures++;
  }
}
console.log(failures ? `\n${failures} 处失败` : `\n全部完成${FIRE ? `（发布 ${fired} 支）` : "（dry-run 全绿）"}`);
process.exit(failures ? 1 : 0);
