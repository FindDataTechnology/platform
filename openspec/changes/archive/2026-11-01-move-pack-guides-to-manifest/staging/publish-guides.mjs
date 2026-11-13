#!/usr/bin/env node
// ── guide 迁移发布脚本（move-pack-guides-to-manifest task 2.2）────────────────
//
// 对 staging/guides.json 里的第一批（5 支官方 starter 团队）逐支执行：
//   登录读面取全量 manifest → 合并 guide/notes/i18n.en.guide →
//   validatePackManifest（发布门同函数）→ POST /api/packs（同 id 重发布 v+1）。
//
// 用法：
//   PAAS_SESSION='<cookie>' BASE_URL='https://<壹座域名>' node publish-guides.mjs            # dry-run（默认）
//   PAAS_SESSION='…' BASE_URL='…' node publish-guides.mjs --fire                             # 真发布
//
// 身份纪律：先打 /api/auth/me 断言会话是 aloadtree@gmail.com（5 支包的唯一
// 原作者，gateway/packs.js:608 只认原作者）；非作者包（文档工坊/数据研究）会
// 被 403 拒，脚本因而不包含它们。

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
  console.error("需要 BASE_URL 与 PAAS_SESSION 环境变量（铸造见 inventory.md 发布通道节）");
  process.exit(1);
}

const overlays = JSON.parse(fs.readFileSync(path.join(here, "guides.json"), "utf8"));

const call = async (apiPath, init) => {
  const r = await fetch(`${BASE}${apiPath}`, {
    ...init,
    headers: { "content-type": "application/json", cookie: `paas_session=${COOKIE}`, ...(init?.headers ?? {}) },
  });
  const text = await r.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text.slice(0, 300);
  }
  return { status: r.status, body };
};

// ── 0. 身份闸：会话必须是原作者 ──────────────────────────────────────────────
const me = await call("/api/auth/me", { method: "GET" });
const email = me.body?.user?.email ?? me.body?.email;
if (email !== AUTHOR) {
  console.error(`身份闸失败：会话是 ${email ?? me.status}，不是 ${AUTHOR}——5 支包仅原作者可发新版本`);
  process.exit(1);
}
console.log(`身份闸 ✓ ${email}${FIRE ? "（FIRE 模式）" : "（dry-run）"}`);

let failures = 0;
for (const [pid, ov] of Object.entries(overlays)) {
  const detail = await call(`/api/packs/${pid}`, { method: "GET" });
  if (detail.status !== 200) {
    console.error(`✗ ${pid.slice(0, 8)}… 读面失败 ${detail.status}`);
    failures += 1;
    continue;
  }
  if (detail.body.authorEmail !== AUTHOR) {
    console.error(`✗ ${pid.slice(0, 8)}… 作者漂移：${detail.body.authorEmail}——跳过`);
    failures += 1;
    continue;
  }
  const m = structuredClone(detail.body.manifest);
  m.guide = ov.guide;
  m.notes = ov.notes;
  m.i18n = { ...(m.i18n ?? {}), en: { ...(m.i18n?.en ?? {}), guide: ov.i18n_en_guide } };
  const errors = validatePackManifest(m);
  if (errors.length) {
    console.error(`✗ ${pid.slice(0, 8)}… 合并后未过发布门：`);
    for (const e of errors.slice(0, 5)) console.error("   ", e.entry ?? "-", e.error);
    failures += 1;
    continue;
  }
  if (!FIRE) {
    console.log(`✓ [dry-run] ${detail.body.name} v${detail.body.version} → v${detail.body.version + 1}（校验绿，未发布）`);
    continue;
  }
  const pub = await call("/api/packs", {
    method: "POST",
    body: JSON.stringify({ packId: pid, manifest: m }),
  });
  if (pub.status === 200 || pub.status === 201) {
    console.log(`✓ [发布] ${detail.body.name} → v${pub.body?.version ?? "?"}`);
  } else {
    console.error(`✗ [发布] ${detail.body.name} ${pub.status}:`, typeof pub.body === "string" ? pub.body : JSON.stringify(pub.body).slice(0, 300));
    failures += 1;
  }
}

console.log(failures ? `\n${failures} 支失败` : "\n全部完成");
process.exit(failures ? 1 : 0);
