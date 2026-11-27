#!/usr/bin/env node
// ── 官方 en 覆盖草稿合并/校验/发布 (overhaul-market-catalog-presentation 5.2) ──
//
// Turns /tmp/en-coverage-drafts/<packId>.json (from plan-official-en-coverage,
// with every gap.en filled by the translation pass) into a full new manifest
// carrying the merged i18n.en overlay — then VALIDATES LOCALLY (coverage=0 and
// the repo validator clean) before touching anything, and only PUBLISHES under
// a triple gate:
//   · explicit --apply (default = check + emit payload files, zero writes)
//   · explicit confirmation phrase: CONFIRM=PATCH-PRODUCTION-PACKS
//   · ownership: the acting account (x-forwarded-* internal channel or cookie)
//     must equal the pack's authorEmail — 管理员不能代发他人版本 is registry
//     law; foreign-owned packs are listed and skipped, never force-patched.
//
// Idempotent by data, so a 10/h rate limit only ever means "run it again later":
// a live entry already at full coverage is skipped (no version churn).
//
//   node scripts/apply-official-en-coverage.mjs                 # check only
//   node scripts/apply-official-en-coverage.mjs --emit=/tmp/en-coverage-payloads
//   CONFIRM=PATCH-PRODUCTION-PACKS node scripts/apply-official-en-coverage.mjs --apply \
//     --base=https://facet.finddatatech.cloud --cookie='<paas_session cookie>' --as=aloadtree@gmail.com
//
// Publish path follows the established lane (scripts/daas-packs.mjs): direct to
// the platform gateway with the user session; if the edge WAF cuts a large
// manifest (known ledger hazard), re-run with --via-facet to use the internal
// x-facet-token/x-facet-user forwarding channel instead.

import { mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { localeCoverage } from "../lib/pack-locale-coverage.js";
import { validatePackManifest } from "../lib/pack-manifest.js";

const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};

const draftsDir = arg("drafts", "/tmp/en-coverage-drafts");
const base = (arg("base", "https://facet.finddatatech.cloud") || "").replace(/\/+$/, "");
const locale = arg("locale", "en");
const emitDir = arg("emit", "");
const doApply = process.argv.includes("--apply");
const asEmail = arg("as", "");
const cookie = process.env.MARKET_COOKIE || arg("cookie", "");
const facetToken = process.env.FACET_INTERNAL_TOKEN || "";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Merge one draft's filled en values into the manifest's i18n.<locale> block.
// Purely additive: pre-existing overlay entries the draft does not mention stay
// untouched; the draft NEVER rewrites runtime fields or the zh main track.
export function mergeOverlay(manifest, gaps, loc = locale) {
  const block = { ...(manifest.i18n?.[loc] ?? {}) };
  const steps = [...(block.guide?.steps ?? [])];
  for (const g of gaps) {
    const en = g.en;
    if (en == null || en === "" || (Array.isArray(en) && en.length === 0)) continue;
    if (/^(name|description|notes|promise)$/.test(g.path)) block[g.path] = en;
    else if (g.path === "tags") block.tags = en;
    else {
      const guide = /^guide\.steps\[(\d+)\]\.(title|body)$/.exec(g.path);
      if (guide) {
        const i = Number(guide[1]);
        steps[i] = { ...steps[i], [guide[2]]: en };
        continue;
      }
      const named = /^(skills|agents|bots)\['([^']+)'\]\.(description|name)$/.exec(g.path);
      if (named) {
        block[named[1]] = { ...(block[named[1]] ?? {}), [named[2]]: { ...(block[named[1]]?.[named[2]] ?? {}), [named[3]]: en } };
        continue;
      }
      const item = /^(outcomes|examples)\[(\d+)\]\.(title|detail|prompt)$/.exec(g.path);
      if (item) {
        const arr = [...(block[item[1]] ?? [])];
        const i = Number(item[2]);
        arr[i] = { ...arr[i], [item[3]]: en };
        block[item[1]] = arr;
      }
    }
  }
  if (steps.length > 0) block.guide = { ...(block.guide ?? {}), steps };
  return { ...(manifest ?? {}), i18n: { ...(manifest?.i18n ?? {}), [loc]: block } };
}

async function getDetail(id) {
  const r = await fetch(`${base}/api/packs/${encodeURIComponent(id)}`);
  if (!r.ok) throw new Error(`detail ${r.status}`);
  return r.json();
}

// Publish round-trip truth: the DETAIL face strips skill file CONTENTS to a
// path inventory (gateway/packs.js projectManifestForDetail), so republishing
// from it would wipe the file tree. The stored-VERSION read is the install
// channel and returns the full manifest — that is what a new version must be
// built on.
async function getFullVersion(id, version) {
  const r = await fetch(`${base}/api/packs/${encodeURIComponent(id)}/versions/${version}`);
  if (!r.ok) throw new Error(`versions/${version} ${r.status}`);
  const v = await r.json();
  const filesShapeBad = (v.manifest?.skills ?? []).some((s) => Array.isArray(s?.files));
  if (filesShapeBad) throw new Error("版本读面仍是 files 清单（不应发生）——拒绝从残缺形状再发布");
  return v;
}

async function publish(manifest, packId) {
  const headers = { "Content-Type": "application/json" };
  if (facetToken) {
    headers["x-facet-token"] = facetToken;
    const doc = { email: asEmail, groups: ["creators"] };
    headers["x-facet-user"] = Buffer.from(JSON.stringify(doc)).toString("base64url");
  } else if (cookie) {
    headers.cookie = cookie;
  } else {
    throw new Error("no credential: set MARKET_COOKIE/--cookie or FACET_INTERNAL_TOKEN/--as");
  }
  // packId is REQUIRED when upgrading an existing pack — without it the
  // registry treats the publish as a new pack and rejects with
  // DUPLICATE_PACK_NAME (409 tells you to republish with packId).
  const r = await fetch(`${base}/api/packs`, { method: "POST", headers, body: JSON.stringify({ packId, manifest }) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

async function main() {
  const files = readdirSync(draftsDir).filter((f) => f.endsWith(".json") && f !== "index.json").sort();
  if (emitDir && doApply === false) mkdirSync(emitDir, { recursive: true });

  if (doApply) {
    if (process.env.CONFIRM !== "PATCH-PRODUCTION-PACKS") {
      console.error("拒绝执行：--apply 需要 CONFIRM=PATCH-PRODUCTION-PACKS（改生产数据是外部动作）。");
      process.exit(2);
    }
    if (!asEmail) { console.error("--apply 需要 --as=<发布账号邮箱> 用于归属核对"); process.exit(2); }
  }

  let ready = 0; let skippedCovered = 0; let skippedForeign = 0; let published = 0; let failed = 0;
  const foreignOwners = new Map();
  for (const f of files) {
    const draft = JSON.parse(readFileSync(path.join(draftsDir, f), "utf8"));
    const id = draft.packId;
    const blanks = draft.gaps.filter((g) => g.en == null || g.en === "" || (Array.isArray(g.en) && g.en.length === 0));
    if (blanks.length > 0) {
      console.log(`  [未就绪] ${id}: ${blanks.length} 个 en 槽仍空 → 跳过（不发半成品）`);
      failed += 1;
      continue;
    }
    const detail = await getDetail(id); // visibility-safe read for the coverage truth
    const zhManifest = detail.manifest ?? {};
    if (localeCoverage(zhManifest, locale).missing.length === 0) {
      skippedCovered += 1; // live truth already full → no version churn (resume-safe)
      continue;
    }
    if (doApply && asEmail && draft.authorEmail && draft.authorEmail !== asEmail) {
      skippedForeign += 1;
      foreignOwners.set(draft.authorEmail, (foreignOwners.get(draft.authorEmail) ?? 0) + 1);
      continue;
    }
    // The bytes we republish MUST come from the version channel (full files
    // tree), never the stripped detail face. Detail's zhManifest above only
    // answers "is there still a gap".
    const ver = draft.version ?? detail.version;
    if (ver == null) {
      console.log(`  [跳过] ${id}: 草稿无版本号，无法走版本读面（不拿残缺形状赌）`);
      failed += 1;
      continue;
    }
    const full = await getFullVersion(id, ver);
    const next = mergeOverlay(full.manifest ?? zhManifest, draft.gaps);
    const cov = localeCoverage(next, locale);
    const errs = validatePackManifest(next);
    if (cov.missing.length > 0 || errs.length > 0) {
      console.log(`  [校验红] ${id}: 缺项=${JSON.stringify(cov.missing)} 错误=${JSON.stringify(errs.slice(0, 3))}`);
      failed += 1;
      continue;
    }
    ready += 1;
    if (emitDir && !doApply) {
      mkdirSync(emitDir, { recursive: true });
      writeFileSync(path.join(emitDir, `${id}.json`), JSON.stringify(next, null, 2) + "\n");
    }
    if (doApply) {
      const pub = await publish(next, id);
      if (pub.status >= 200 && pub.status < 300) {
        published += 1;
        console.log(`  [已发布] ${id} → v${pub.body.version ?? "?"}`);
      } else if (pub.status === 429) {
        console.log(`  [限流] ${id}：发布速率门生效（已知 10/h）——停止，稍后重跑同一命令即续。`);
        failed += 1;
        break;
      } else {
        failed += 1;
        console.log(`  [发布失败 ${pub.status}] ${id}: ${JSON.stringify(pub.body).slice(0, 200)}`);
        if (pub.status === 403) {
          console.error("  403：核对归属/鉴权通道（x-forwarded-roles 必须是合法业务角色；或改用 --via-facet 内网通道）。");
          break;
        }
      }
      await sleep(400); // polite pacing under any lane
    }
  }

  console.log(
    `${doApply ? "发布完成" : "检查完成"}：校验通过 ${ready} · 已发布 ${published} · 已在覆盖跳过 ${skippedCovered} · 归属他人跳过 ${skippedForeign} · 红/未就绪 ${failed}`,
  );
  if (skippedForeign > 0) {
    console.log("需所有者协调（非本人条目，代发被注册表规则禁止）：");
    for (const [email, n] of foreignOwners) console.log(`  ${email}: ${n} 条`);
  }
  if (!doApply) console.log("这是干跑（默认）。发布需：CONFIRM=PATCH-PRODUCTION-PACKS node scripts/apply-official-en-coverage.mjs --apply --cookie=... --as=<email>");
  process.exit(failed > 0 ? 1 : 0);
}

// Direct-run guard: importing mergeOverlay for tests must NOT execute the
// live check/apply loop. (fileURLToPath + realpath: argv paths through /tmp
// symlinks still match import.meta.url.)
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
const invokedDirectly =
  process.argv[1] && (() => {
    try {
      return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
    } catch {
      return false;
    }
  })();
if (invokedDirectly) await main();
