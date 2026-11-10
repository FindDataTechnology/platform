#!/usr/bin/env node
// ── publish-mcp-registry — the official MCP Registry channel ─────────────────
//
//   node scripts/publish-mcp-registry.mjs --facet-url <url> [--out <dir>]
//                                         [--dry-run] [--publish]
//
// Fetches the facet's projection (`GET {facet-url}/api/mcp-registry.json`),
// writes one `<out>/<namespace>/<server>/server.json` tree, and optionally
// hands each document to `mcp-publisher publish`.
//
// Authentication is NOT this script's business, and deliberately so: publishing
// under the organization namespace (io.github.FindDataTechnology/*) only works
// through GitHub Actions OIDC with `permissions: id-token: write`. The
// interactive `mcp-publisher login github` device flow grants *personal*
// `io.github.<username>/*` only — it cannot read org membership, so it is not a
// supported path here (design D4). A local run therefore stops at --dry-run.
//
// Last-good is the contract, copied from export-marketplace-repo.mjs: build and
// validate into a staging directory first, swap only when the whole batch is
// clean. A failure leaves the previous tree byte-identical.
//
//   --facet-url  base URL of the facet service (required)
//   --out        output tree (default ./mcp-registry-out)
//   --dry-run    fetch + project + validate + report, write nothing
//   --publish    run `mcp-publisher publish` per server (CI only)
//   --skip <name>  exclude a server from publishing (repeatable; bare name or
//                full reverse-DNS). First-batch operational exclusions land here.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, dflt = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : dflt;
};

const FACET_URL = (opt("facet-url") || process.env.FACET_URL || "").replace(/\/+$/, "");
const OUT = path.resolve(opt("out", "mcp-registry-out"));
const DRY = flag("dry-run");
const PUBLISH = flag("publish");

if (!FACET_URL) {
  console.error("用法：node scripts/publish-mcp-registry.mjs --facet-url <url> [--out <dir>] [--dry-run] [--publish]");
  process.exit(2);
}
if (PUBLISH && DRY) {
  console.error("✗ --publish 与 --dry-run 互斥");
  process.exit(2);
}

// Same name pattern the projector enforces and the registry validates. This is
// a second lock on the same door (the source is our own projection), not a new
// rule — a malformed name must never reach the filesystem as a path.
const NAME_RE = /^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/;

// The registry caps `description` at 100 characters and answers 422
// (`{"errors":[{"message":"expected length <= 100","location":"body.description"}]}`).
// Learned on the first real publish (2026-10-31, run 41142472745): 6 of 14 went
// live, the other 8 were refused. The projector now fits the text into this
// budget; this refuses again so a projection regression cannot burn a run.
const MAX_DESCRIPTION = 100;

// The official schema's required fields, checked again here so a broken
// projection cannot be published by a CI run that skipped the unit tests.
function validateDoc(doc) {
  const problems = [];
  if (typeof doc?.name !== "string" || doc.name.split("/").length !== 2 || !NAME_RE.test(doc.name)) {
    problems.push(`name 不是反向 DNS 形：${JSON.stringify(doc?.name)}`);
  }
  if (typeof doc?.description !== "string" || !doc.description.trim()) problems.push("description 缺失或为空");
  else {
    // Code points, not UTF-16 units — that is what the registry counts.
    const len = Array.from(doc.description).length;
    if (len > MAX_DESCRIPTION) problems.push(`description 超 ${MAX_DESCRIPTION} 字符（实际 ${len}）`);
  }
  if (typeof doc?.version !== "string" || !doc.version.trim()) problems.push("version 缺失");
  if (!Array.isArray(doc?.remotes) || doc.remotes.length === 0) problems.push("remotes 缺失或为空");
  for (const [i, r] of (doc?.remotes ?? []).entries()) {
    if (!["streamable-http", "sse"].includes(r?.type)) problems.push(`remotes[${i}].type 非法：${JSON.stringify(r?.type)}`);
    if (typeof r?.url !== "string" || !/^https?:\/\//.test(r.url)) problems.push(`remotes[${i}].url 非绝对 URL`);
    if (r && "headers" in r) problems.push(`remotes[${i}].headers 必须整块省略（免键端点）`);
  }
  return problems;
}

async function fetchProjection() {
  const url = `${FACET_URL}/api/mcp-registry.json`;
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GET ${url} → ${res.status} ${res.statusText} ${body.slice(0, 300)}`);
  }
  const doc = await res.json();
  if (!Array.isArray(doc?.servers)) throw new Error("投影响应缺少 servers 数组");
  return doc.servers;
}

// ── publish eligibility gate (pre-publish visibility gate, task 2.4) ─────────
// The projection serves every group-free public server — and some of those
// entries point at internal addresses (mesh hostnames, hostPort, plain http).
// Those belong to the catalog face but must NEVER reach the community MCP
// Registry: listing is irrevocable and an internal hostname in a public
// registry document is a topology leak. The gate SKIPS with a reported reason
// (the skip set = exactly the entries ops must fix at the registry source);
// it never rewrites a URL to make it pass.
const PUBLIC_HOST_RE = /(^|\.)finddatatech\.cloud$/i;
function publishEligibility(doc) {
  for (const r of doc.remotes ?? []) {
    let u;
    try {
      u = new URL(r.url);
    } catch {
      return `remote url 无法解析：${r.url}`;
    }
    if (u.protocol !== "https:") return `非 https：${u.protocol}//${u.host}`;
    if (!PUBLIC_HOST_RE.test(u.hostname)) return `非公网发布域：${u.hostname}`;
  }
  return null;
}

// Repeated --skip <name> (bare server name or full reverse-DNS name).
const SKIP_NAMES = [];
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === "--skip" && args[i + 1] && !args[i + 1].startsWith("--")) SKIP_NAMES.push(args[i + 1]);
}

const servers = await fetchProjection();
console.log(`投影返回 ${servers.length} 个公开 MCP server`);

// Validate the entire batch before touching disk: a single malformed document
// means the projection face is broken, and publishing the rest would hide it.
const rejects = [];
for (const doc of servers) {
  const problems = validateDoc(doc);
  if (problems.length) rejects.push({ name: doc?.name ?? null, problems });
}
if (rejects.length) {
  console.error("✗ 校验失败，整批不发布（last-good 保持）：");
  for (const r of rejects) console.error(`  - ${r.name}: ${r.problems.join("；")}`);
  process.exit(1);
}

const eligible = [];
const gateSkipped = [];
for (const doc of servers) {
  const reason = publishEligibility(doc);
  if (reason) {
    gateSkipped.push({ name: doc.name, reason });
    continue;
  }
  const short = doc.name.split("/")[1];
  if (SKIP_NAMES.includes(doc.name) || SKIP_NAMES.includes(short)) {
    gateSkipped.push({ name: doc.name, reason: "--skip 名单（首批人工排除）" });
    continue;
  }
  eligible.push(doc);
}

if (eligible.length === 0) {
  console.error("✗ 发布闸后零可发布条目——发布无意义，中止（查投影/网关）");
  process.exit(1);
}

if (DRY) {
  console.log(`发布闸：可发 ${eligible.length}，跳过 ${gateSkipped.length}`);
  for (const doc of eligible) console.log(`  ✓ ${doc.name} → ${doc.remotes[0].url}`);
  for (const s of gateSkipped) console.log(`  ✗ ${s.name} —— ${s.reason}`);
  console.log("✓ 自检通过（--dry-run，未写盘、未发布）");
  console.log("  发布源可见性：本脚本只消费 facet 的公开投影（groups=[] 的 server），");
  console.log("  不读私有仓、不含凭据（remotes 无 headers 块）。");
  process.exit(0);
}

// Stage → validate → swap (same-filesystem atomic rename, as the repo exporter).
const parent = path.dirname(OUT);
mkdirSync(parent, { recursive: true });
const staging = mkdtempSync(path.join(parent, ".mcp-registry-out-staging-"));

try {
  let files = 0;
  for (const doc of eligible) {
    // "<namespace>/<server>" → "<namespace>__<server>" is NOT what the registry
    // wants: mcp-publisher reads the tree relative to cwd and takes name from
    // the document itself, so a flat directory per server is the shape.
    const dir = path.join(staging, doc.name.replace(/\//g, "__"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "server.json"), `${JSON.stringify(doc, null, 2)}\n`);
    files += 1;
  }

  if (existsSync(OUT)) {
    for (const entry of readdirSync(OUT)) rmSync(path.join(OUT, entry), { recursive: true, force: true });
  } else {
    mkdirSync(OUT, { recursive: true });
  }
  for (const entry of readdirSync(staging)) {
    execFileSync("mv", [path.join(staging, entry), path.join(OUT, entry)]);
  }
  console.log(`✓ 已写出 ${files} 个 server.json 到 ${OUT}`);

  if (PUBLISH) {
    let published = 0;
    let already = 0;
    const failures = [];
    for (const doc of eligible) {
      try {
        execFileSync("mcp-publisher", ["publish"], {
          cwd: path.join(OUT, doc.name.replace(/\//g, "__")),
          stdio: ["ignore", "pipe", "pipe"],
          encoding: "utf8",
        });
        published += 1;
        console.log(`  ✓ 已发布 ${doc.name}`);
      } catch (e) {
        // Idempotent re-runs: the registry answers 400 "cannot publish duplicate
        // version" for entries already in the listing. That is the desired end
        // state, NOT a failure — treating it as one turned a fully-successful
        // re-publish green batch red (2026-10-31, run 41143983762).
        const errText = `${e?.stdout ?? ""}${e?.stderr ?? ""}`;
        if (/already exists|duplicate version/i.test(errText)) {
          already += 1;
          console.log(`  = 已在名录（重复版本，跳过）${doc.name}`);
          continue;
        }
        failures.push({ name: doc.name, message: String(e?.message || e).split("\n")[0] });
      }
    }
    console.log(`✓ 发布完成：新发 ${published}、已在名录 ${already}（共 ${eligible.length}）`);
    if (failures.length) {
      for (const f of failures) console.error(`  ✗ ${f.name}: ${f.message}`);
      process.exitCode = 1;
      console.error(`  （${gateSkipped.length} 条被发布闸跳过，见 --dry-run 报告）`);
    }
  } else {
    console.log("  （未 --publish；仅写出。CI 的 OIDC 登录由 workflow 负责）");
  }
} catch (e) {
  console.error(`✗ 生成失败，已保留上一份（last-good）：${e.message}`);
  process.exitCode = 1;
} finally {
  rmSync(staging, { recursive: true, force: true });
}
