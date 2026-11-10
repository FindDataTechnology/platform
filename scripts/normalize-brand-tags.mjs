#!/usr/bin/env node
// ── 品牌双写 tag 归一到受控 slug (overhaul-market-catalog-presentation 5.3) ──
//
// 同义双写对（zh 品牌词 ↔ 线 slug）在生产 tags 里并存了两个形态：检索被劈成
// 两半、en 轨还多出品牌拼音。归一方向=受控 slug（wire/lex/wanxing——与
// lib/pack-taxonomy 的线 slug 同形，跨语言常量，en.tags 对应槽写同一个
// slug，进 i18n.tags 对齐轨）。同包双写则去重保序（zh 与 en 同步去重）。
//
// 发布与 5.2 的 apply 脚本同三重闸：显式 CONFIRM、归属核对（他人条目只列
// 不强发）、数据幂等（已归一即跳过）；默认干跑。与 5.2 共享 10/h 速率门——
// 排在 5.2 续跑环之后执行。
//
//   node scripts/normalize-brand-tags.mjs                    # 干跑清单
//   node scripts/normalize-brand-tags.mjs --emit=/tmp/tag-norm-payloads
//   CONFIRM=PATCH-PRODUCTION-PACKS node scripts/normalize-brand-tags.mjs --apply \
//     --base=https://platform.finddatatech.cloud --cookie='<paas_session>' --as=aloadtree@gmail.com

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { validatePackManifest } from "../lib/pack-manifest.js";
import { localeCoverage } from "../lib/pack-locale-coverage.js";

const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const base = (arg("base", "https://platform.finddatatech.cloud") || "").replace(/\/+$/, "");
const emitDir = arg("emit", "");
const doApply = process.argv.includes("--apply");
const asEmail = arg("as", "");
const cookie = process.env.MARKET_COOKIE || arg("cookie", "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 归一映射：zh 品牌双写词 → 受控线 slug（与 pack-taxonomy lineSlugs 同形）。
const BRAND_TO_SLUG = { 柏讯: "wire", 识律: "lex", 萬星: "wanxing", 万星: "wanxing" };

// 归一一条 tags 数组：品牌词换 slug + 去重保序。返回 {tags, changed}。
export function normalizeTags(tags) {
  const out = [];
  let changed = false;
  for (const t of tags ?? []) {
    const mapped = typeof t === "string" && BRAND_TO_SLUG[t] ? BRAND_TO_SLUG[t] : t;
    if (mapped !== t) changed = true;
    if (out.includes(mapped)) {
      changed = true; // 双写同有 → 去重
      continue;
    }
    out.push(mapped);
  }
  return { tags: out, changed };
}

// en.tags 与 zh tags 槽位对齐：先按 index 归一（品牌槽→slug、去重同一索引），
// 再与归一后的 zh tags 等长补齐（en 槽缺则沿用 slug——slug 本身跨语言常量）。
export function normalizeEnTags(zhTags, enTags) {
  if (!Array.isArray(enTags) || enTags.length !== zhTags.length) {
    // 兜底也是归一后的 zh tags（slug 是跨语言常量）——兜底裸 zh 品牌词=归一漏网。
    return { tags: normalizeTags(zhTags).tags, changed: true };
  }
  const zhNorm = normalizeTags(zhTags);
  const out = [];
  let changed = false;
  for (let i = 0; i < zhTags.length; i += 1) {
    const mapped = BRAND_TO_SLUG[zhTags[i]] ? BRAND_TO_SLUG[zhTags[i]] : enTags[i];
    if (mapped !== enTags[i]) changed = true;
    if (out.includes(mapped)) {
      changed = true;
      continue;
    }
    out.push(mapped);
  }
  // 长度对齐律：en.tags 必须与归一后的 zh tags 等长（去重已在同一索引同步发生）。
  if (out.length !== zhNorm.tags.length) {
    changed = true;
    while (out.length < zhNorm.tags.length) out.push(zhNorm.tags[out.length]);
  }
  return { tags: out, changed };
}

async function getVersion(id, version) {
  const r = await fetch(`${base}/api/packs/${encodeURIComponent(id)}/versions/${version}`);
  if (!r.ok) throw new Error(`versions ${r.status}`);
  return r.json();
}

async function publish(packId, manifest) {
  const headers = { "Content-Type": "application/json", cookie };
  const r = await fetch(`${base}/api/packs`, { method: "POST", headers, body: JSON.stringify({ packId, manifest }) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

async function main() {
  const listRes = await fetch(`${base}/api/packs?pageSize=100`);
  if (!listRes.ok) throw new Error(`list ${listRes.status}`);
  const rows = (await listRes.json()).packs ?? [];

  if (doApply) {
    if (process.env.CONFIRM !== "PATCH-PRODUCTION-PACKS") {
      console.error("拒绝执行：--apply 需要 CONFIRM=PATCH-PRODUCTION-PACKS。");
      process.exit(2);
    }
    if (!asEmail || !cookie) { console.error("--apply 需要 --as 与 --cookie/MARKET_COOKIE。"); process.exit(2); }
  }

  let candidates = 0; let published = 0; let skippedForeign = 0; let failed = 0; let rateLimited = false;
  const foreignOwners = new Map();
  for (const row of rows) {
    const zhTags = row.tags ?? [];
    const norm = normalizeTags(zhTags);
    if (!norm.changed) continue;
    candidates += 1;
    if (doApply && asEmail && row.authorEmail && row.authorEmail !== asEmail) {
      skippedForeign += 1;
      foreignOwners.set(row.authorEmail, (foreignOwners.get(row.authorEmail) ?? 0) + 1);
      continue;
    }
    const v = await getVersion(row.id, row.version);
    const m = v.manifest ?? {};
    const enBlock = { ...(m.i18n?.en ?? {}) };
    const zhNext = normalizeTags(m.tags ?? zhTags).tags;
    const enNext = normalizeEnTags(m.tags ?? zhTags, enBlock.tags);
    const next = {
      ...m,
      tags: zhNext,
      i18n: { ...(m.i18n ?? {}), en: { ...enBlock, tags: enNext.tags } },
    };
    const errs = validatePackManifest(next);
    if (errs.length > 0) {
      console.log(`  [校验红] ${row.id}: ${JSON.stringify(errs.slice(0, 2))}`);
      failed += 1;
      continue;
    }
    const covered = localeCoverage(next, "en").missing.length === 0;
    if (emitDir && !doApply) {
      mkdirSync(emitDir, { recursive: true });
      writeFileSync(path.join(emitDir, `${row.id}.json`), JSON.stringify(next, null, 2) + "\n");
    }
    const label = `${row.id} (${row.name}) ${JSON.stringify(zhTags)}→${JSON.stringify(zhNext)}${covered ? "" : " [en覆盖未满，5.2 在途]"}`;
    if (!doApply) {
      console.log(`  [干跑] ${label}`);
      continue;
    }
    const pub = await publish(row.id, next);
    if (pub.status >= 200 && pub.status < 300) {
      published += 1;
      console.log(`  [已归一] ${label} → v${pub.body.version ?? "?"}`);
    } else if (pub.status === 429) {
      console.log(`  [限流] ${row.id}：速率门生效——停止，稍后重跑即续。`);
      rateLimited = true;
      failed += 1;
      break;
    } else {
      failed += 1;
      console.log(`  [发布失败 ${pub.status}] ${row.id}: ${JSON.stringify(pub.body).slice(0, 160)}`);
      if (pub.status === 403) break;
    }
    await sleep(400);
  }

  console.log(
    `${doApply ? "归一完成" : "归一干跑"}：候选 ${candidates} · 已发布 ${published} · 归属他人跳过 ${skippedForeign} · 红 ${failed}${rateLimited ? "（限流中断，重跑即续）" : ""}`,
  );
  if (skippedForeign > 0) {
    console.log("需所有者协调：");
    for (const [email, n] of foreignOwners) console.log(`  ${email}: ${n} 条`);
  }
  process.exit(failed > 0 ? 1 : 0);
}

// Direct-run guard（同 5.2 apply 脚本）。
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
if (process.argv[1] && (() => { try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })()) await main();
