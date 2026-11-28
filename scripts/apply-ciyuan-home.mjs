#!/usr/bin/env node
// 词元面板首页灌入器（refresh-ciyuan-intro 1.3）。
//
// 首页 HTML 的权威副本是 docs/ciyuan/home-content.html；本脚本把它写入词元
// 系统设置 home_content（经 admin API）。灌入是**部分 PUT**——只发 home_content
// 一个键，上游的 omittedSettingKeys 机制保证其余设置不被重置（已实证）。
//
// 用法：
//   node scripts/apply-ciyuan-home.mjs --dry-run          # 打印新旧长度与段标题
//   node scripts/apply-ciyuan-home.mjs                    # 正式灌入
//   node scripts/apply-ciyuan-home.mjs --restore-baseline # 回滚到基线副本
//
// 凭据：SUB2API_ADMIN_KEY（缺省从 cheap 集群 secret 读取）；目标域名
// SUB2API_BASE（缺省 https://router.finddatatech.cloud）。

import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HOME_FILE = join(ROOT, "docs/ciyuan/home-content.html");
const BASELINE_FILE = join(ROOT, "docs/ciyuan/home-content.baseline-2026-10-05.html");

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const restore = args.has("--restore-baseline");

const base = process.env.SUB2API_BASE || "https://router.finddatatech.cloud";

function adminKey() {
  if (process.env.SUB2API_ADMIN_KEY) return process.env.SUB2API_ADMIN_KEY.trim();
  try {
    const raw = execFileSync(
      "kubectl",
      [
        "--context", "cheap",
        "get", "secret", "mcp-registry-env-auth", "-n", "mcp-registry",
        "-o", "jsonpath={.data.SUB2API_ADMIN_KEY}",
      ],
      { encoding: "utf8" },
    ).trim();
    if (raw) return Buffer.from(raw, "base64").toString("utf8").trim();
  } catch {
    // 落空由下方统一报错
  }
  throw new Error("SUB2API_ADMIN_KEY 未设置，且无法从集群 secret 读取");
}

async function readCurrent(key) {
  const res = await fetch(`${base}/api/v1/admin/settings`, {
    headers: { "x-api-key": key },
  });
  if (!res.ok) throw new Error(`读设置失败 HTTP ${res.status}`);
  const body = await res.json();
  return body?.data?.home_content ?? "";
}

function sectionTitles(html) {
  return [...html.matchAll(/<h[1-3][^>]*>(.*?)<\/h[1-3]>/gs)]
    .map((m) => m[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

const sourceFile = restore ? BASELINE_FILE : HOME_FILE;
if (!existsSync(sourceFile)) throw new Error(`找不到源文件：${sourceFile}`);
const next = readFileSync(sourceFile, "utf8");

const key = adminKey();
const current = await readCurrent(key);

console.log(`目标：${base}`);
console.log(`源文件：${sourceFile.replace(ROOT + "/", "")}${restore ? "（基线回滚）" : ""}`);
console.log(`当前 home_content：${current.length} 字符`);
console.log(`待写入：${next.length} 字符`);
console.log("待写入段标题：");
for (const t of sectionTitles(next)) console.log(`  · ${t}`);

if (current === next) {
  console.log("\n内容与现网一致，无需写入。");
  process.exit(0);
}

if (dryRun) {
  console.log("\n--dry-run：未写入。");
  process.exit(0);
}

const res = await fetch(`${base}/api/v1/admin/settings`, {
  method: "PUT",
  headers: { "x-api-key": key, "Content-Type": "application/json" },
  body: JSON.stringify({ home_content: next }),
});
if (!res.ok) {
  throw new Error(`写入失败 HTTP ${res.status}：${(await res.text()).slice(0, 300)}`);
}

const after = await readCurrent(key);
if (after !== next) throw new Error("写入后回读不一致——请检查设置保存链路");

// 回归确认：其余公开设置未被重置（部分 PUT 的核心保证）。
const pub = await fetch(`${base}/api/v1/settings/public`).then((r) => r.json());
console.log(`\n✅ 已灌入：home_content ${after.length} 字符`);
console.log(`   回归抽查 site_name=${pub?.data?.site_name} compact_home_enabled=${pub?.data?.compact_home_enabled}`);
