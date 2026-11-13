#!/usr/bin/env node
// ── 官方助手型/套件型包内容改版发布脚本（modernize-official-assistant-packs）────
//
// 对 staging/teams/*.json 的 12 支包逐支执行（与 batch2 同源断言 + 多作者会话）：
//   按包作者从 SESSIONS 选会话 → 读面取 manifest → 合并（persona 前缀逐字保留+
//   精确替换；skills 按 name upsert；零 mcp 改动）→ 结构零 diff → 内容基线 →
//   validatePackManifest → POST /api/packs（同 id v+1）。
//
// 用法：
//   SESSIONS='{"aloadtree@gmail.com":"ck1","aloadtree@finddatatech.cloud":"ck2",
//             "platform-test@findmail.com":"ck3","publisher@finddatatech.cloud":"ck4"}'
//   BASE_URL='https://…' node publish-assistant-packs.mjs          # dry-run（默认）
//   同上 + --fire                                                   # 真发布

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validatePackManifest } from "../../../../lib/pack-manifest.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIRE = process.argv.includes("--fire");
const BASE = process.env.BASE_URL || "";
const SESSIONS = JSON.parse(process.env.SESSIONS || "{}");
const PACING_MS = Number(process.env.PUBLISH_PACING_MS || 6500);

if (!BASE || !Object.keys(SESSIONS).length) {
  console.error("需要 BASE_URL 与 SESSIONS（作者邮箱→cookie 映射）");
  process.exit(1);
}

const snapshot = JSON.parse(fs.readFileSync(path.join(here, "source-snapshot.json"), "utf8"));
const teamFiles = fs.readdirSync(path.join(here, "teams")).filter((f) => f.endsWith(".json")).sort();
const ONLY = (process.env.ONLY || "").split(",").map((s) => s.trim()).filter(Boolean);
let teams = teamFiles.map((f) => JSON.parse(fs.readFileSync(path.join(here, "teams", f), "utf8")));
if (ONLY.length) teams = teams.filter((t) => ONLY.includes(t.name) || ONLY.includes(t.packId));
if (teams.length !== Object.keys(snapshot).length && !ONLY.length) {
  console.error(`✗ 覆盖不齐：snapshot ${Object.keys(snapshot).length} 支，teams/ ${teams.length} 支`);
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36";
// WAF 律：连续裸请求会被雷池拦成 502/HTML——每次请求间节流，502 退避重试
const THROTTLE_MS = Number(process.env.PUBLISH_THROTTLE_MS || 1200);
const call = (cookie) => {
  let last = 0;
  return async (apiPath, init) => {
    const gap = Date.now() - last;
    if (gap < THROTTLE_MS) await sleep(THROTTLE_MS - gap);
    last = Date.now();
    for (let attempt = 0; ; attempt++) {
      const r = await fetch(`${BASE}${apiPath}`, {
        ...init,
        headers: {
          "content-type": "application/json",
          "user-agent": UA,
          referer: `${BASE}/packs`,
          cookie: `paas_session=${cookie}`,
          ...(init?.headers ?? {}),
        },
      });
      const text = await r.text();
      let body;
      try { body = JSON.parse(text); } catch { body = text.slice(0, 300); }
      if ((r.status === 502 || r.status === 429) && attempt < 3) { await sleep(5000 * (attempt + 1)); continue; }
      return { status: r.status, body };
    }
  };
};

let failures = 0;
let fired = 0;
for (const team of teams) {
  const pid = team.packId;
  const tag = snapshot[pid]?.name ?? pid.slice(0, 8);
  const author = snapshot[pid]?.author;
  const cookie = SESSIONS[author];
  if (!cookie) { console.error(`✗ ${tag}: 无 ${author} 的会话`); failures++; continue; }
  const callApi = call(cookie);

  const me = await callApi("/api/auth/me", { method: "GET" });
  const email = me.body?.user?.email ?? me.body?.email;
  if (email !== author) { console.error(`✗ ${tag} 身份闸失败：会话是 ${email ?? me.status}，不是 ${author}`); failures++; continue; }

  const detail = await callApi(`/api/packs/${pid}`, { method: "GET" });
  if (detail.status !== 200) { console.error(`✗ ${tag} 读面失败 ${detail.status}`); failures++; continue; }
  if (detail.body.authorEmail !== author) { console.error(`✗ ${tag} 作者漂移：${detail.body.authorEmail}`); failures++; continue; }
  const v = detail.body.manifest;
  const m = structuredClone(v);

  // ── persona 精确替换 + 内容基线（改版前文本必须是其前缀——零改写保证）──
  for (const a of m.agents ?? []) {
    const np = team.personas[a.id];
    if (np === undefined) continue;
    const old = a.persona ?? "";
    if (!np.startsWith(old)) { console.error(`✗ ${tag}/${a.id} 改版前文本被改写（非前缀）`); failures++; }
    if (np.length < 380) { console.error(`✗ ${tag}/${a.id} persona ${np.length} 字 < 380`); failures++; }
    if (!np.includes("【职责边界】") || !np.includes("【输出契约】")) { console.error(`✗ ${tag}/${a.id} 缺结构段`); failures++; }
    if (!["绝不编造", "不给结论", "不替其编造", "不臆造"].some((w) => np.includes(w))) { console.error(`✗ ${tag}/${a.id} 诚实纪律句丢失`); failures++; }
    if (np.includes("\\n")) { console.error(`✗ ${tag}/${a.id} persona 含字面 \\n 转义（换行没落地）`); failures++; }
    a.persona = np;
  }
  const overlayMissing = Object.keys(team.personas).filter((id) => !(m.agents ?? []).some((a) => a.id === id));
  if (overlayMissing.length) { console.error(`✗ ${tag} overlay 引用不存在的岗位：${overlayMissing}`); failures++; continue; }

  // ── 转正包红线：技能正文是上游钉定快照，overlay 绝不带 skills ──
  const adopted = Boolean(snapshot[pid].adopted);
  if (adopted && team.skills) { console.error(`✗ ${tag} 转正包 overlay 不得带 skills`); failures++; }

  // ── skills upsert ──
  for (const s of team.skills ?? []) {
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(s.name)) { console.error(`✗ ${tag} 技能名不合发布门字符集：${s.name}`); failures++; }
    if ((s.content ?? "").length < 200) { console.error(`✗ ${tag}/${s.name} 技能内容 < 200 字`); failures++; }
    if ((s.content ?? "").includes("\\n")) { console.error(`✗ ${tag}/${s.name} 技能内容含字面 \\n 转义`); failures++; }
    const i = (m.skills ?? []).findIndex((x) => x.name === s.name);
    if (i >= 0) m.skills[i] = s;
    else m.skills = [...(m.skills ?? []), s];
  }

  // ── 结构零 diff：除 agents/skills 外全部键逐字一致；agent 非 persona 字段逐字一致 ──
  for (const k of new Set([...Object.keys(v), ...Object.keys(m)])) {
    if (["agents", "skills", "mcpServers"].includes(k)) continue;
    if (JSON.stringify(m[k] ?? null) !== JSON.stringify(v[k] ?? null)) {
      console.error(`✗ ${tag} 结构漂移：${k}`); failures++;
    }
  }
  const stripPersona = (agents) => JSON.stringify((agents ?? []).map(({ persona, ...rest }) => rest));
  if (stripPersona(m.agents) !== stripPersona(v.agents)) { console.error(`✗ ${tag} agent 非 persona 字段漂移`); failures++; }
  if (JSON.stringify(m.mcpServers ?? []) !== JSON.stringify(v.mcpServers ?? [])) { console.error(`✗ ${tag} mcpServers 被改动（本批零 mcp）`); failures++; }

  const errors = validatePackManifest(m);
  if (errors.length) {
    console.error(`✗ ${tag} 合并后未过发布门：`);
    for (const e of errors.slice(0, 6)) console.error("   ", e.entry ?? "-", e.error);
    failures++; continue;
  }
  if (JSON.stringify(m) === JSON.stringify(v)) {
    console.log(`= [跳过] ${tag} 内容已与 overlay 一致（当前 v${detail.body.version}，作者 ${author}）`);
    continue;
  }
  if (!FIRE) {
    console.log(`✓ [dry-run] ${tag} v${detail.body.version} → v${detail.body.version + 1}（${author}；persona×${Object.keys(team.personas).length} skills ${(v.skills ?? []).length}→${(m.skills ?? []).length}，校验绿）`);
    continue;
  }
  await sleep(PACING_MS);
  const pub = await callApi("/api/packs", { method: "POST", body: JSON.stringify({ packId: pid, manifest: m }) });
  if (pub.status === 200 || pub.status === 201) {
    console.log(`✓ [发布] ${tag} → v${pub.body?.version ?? "?"}（${author}）`);
    fired++;
  } else {
    console.error(`✗ [发布] ${tag} ${pub.status}:`, typeof pub.body === "string" ? pub.body : JSON.stringify(pub.body).slice(0, 300));
    failures++;
  }
}
console.log(failures ? `\n${failures} 处失败` : `\n全部完成${FIRE ? `（发布 ${fired} 支）` : "（dry-run 全绿）"}`);
process.exit(failures ? 1 : 0);
