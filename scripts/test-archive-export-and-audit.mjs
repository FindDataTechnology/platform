#!/usr/bin/env node
// ── 数据归属与打包边界 ──────────────────────────────────────────────────────
//
// 私有化交付的两条承诺，各配一组断言：
//   A. 客户随时能把数据拿走，且不需要我们的工具 —— 导出/导回条数一致
//   B. 我们的产物里不含腾讯 SDK 与客户私钥 —— 审计脚本能变红
//
// 「能变红」这条尤其重要：一个永远返回 ok 的审计脚本，比没有审计更糟，
// 因为它会让人以为检查过了。
//
//   node --test scripts/test-archive-export-and-audit.mjs

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";

const store = await import("../server/archive/store.js");
const { exportArchive, importArchive, integrityCheck, EXPORT_SCHEMA_VERSION } = await import(
  "../server/archive/export.js"
);
const { auditPackaging, walk, readIgnoreRules } = await import(
  "../scripts/audit-archive-packaging.mjs"
);

const ROOT = path.resolve(import.meta.dirname, "..");
const NOW = 1_700_000_000_000;

function seedDb() {
  const db = new DatabaseSync(":memory:");
  store.ensureArchiveSchema(db);

  store.upsertConversation(db, {
    conversationId: "room1",
    kind: "group",
    name: "客户群",
    agreeState: "agree",
    agreeAt: NOW - 1000,
  });
  store.upsertConversation(db, {
    conversationId: "dm1",
    kind: "single",
    agreeState: "disagree",
  });
  store.upsertParticipant(db, {
    conversationId: "room1",
    userId: "zhangsan",
    role: "member",
    displayName: "张三",
    at: NOW,
  });
  store.insertMessage(db, {
    id: "room1:m1",
    conversationId: "room1",
    msgId: "m1",
    seq: 1,
    sentAt: NOW - 5000,
    sender: "wmCUST",
    origin: "peer",
    msgType: "text",
    text: "帮我报个价",
    mergeKey: "room1|1|wmCUST|ab",
  });
  store.insertMessage(db, {
    id: "room1:m2",
    conversationId: "room1",
    msgId: "m2",
    seq: 2,
    sentAt: NOW - 4000,
    sender: "zhangsan",
    origin: "self",
    msgType: "image",
    text: "[图片]",
  });
  store.upsertMedia(db, {
    id: "room1:m2",
    conversationId: "room1",
    messageId: "room1:m2",
    sdkFileId: "FID-1",
    mediaType: "image",
    bytes: 1024,
    state: "done",
  });
  store.appendLoss(db, { fromTs: NOW - 9000, toTs: NOW - 8000, detectedAt: NOW });
  store.writeCursor(db, { seq: 2, lastCheckedAt: NOW, lastMessageAt: NOW - 4000 });
  store.refreshConversationStats(db, "room1");
  return db;
}

function freshEmptyDb() {
  const db = new DatabaseSync(":memory:");
  store.ensureArchiveSchema(db);
  return db;
}

test("导出产出 JSONL + manifest，计数与库一致", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "arch-export-"));
  try {
    const db = seedDb();
    const manifest = exportArchive(db, { dir, now: NOW });
    assert.equal(manifest.schemaVersion, EXPORT_SCHEMA_VERSION);
    assert.equal(manifest.integrity, "ok");
    assert.equal(manifest.counts.conversations, 2);
    assert.equal(manifest.counts.messages, 2);
    assert.equal(manifest.counts.media, 1);
    assert.equal(manifest.counts.losses, 1);
    assert.equal(manifest.counts.participants, 1);
    assert.equal(manifest.cursor.seq, 2);

    // 每行都是一个 JSON 对象（客户不需要我们的工具也能读）
    const lines = readFileSync(path.join(dir, "messages.jsonl"), "utf8").trim().split("\n");
    assert.equal(lines.length, 2);
    for (const line of lines) assert.equal(typeof JSON.parse(line), "object");
    assert.ok(lines[0].includes("帮我报个价") || lines[1].includes("帮我报个价"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("导出可幂等：两次导出除时间戳外字节一致", () => {
  const a = mkdtempSync(path.join(tmpdir(), "arch-export-a-"));
  const b = mkdtempSync(path.join(tmpdir(), "arch-export-b-"));
  try {
    const db = seedDb();
    exportArchive(db, { dir: a, now: NOW });
    exportArchive(db, { dir: b, now: NOW + 999_999 });
    for (const f of ["conversations.jsonl", "messages.jsonl", "media.jsonl", "losses.jsonl", "participants.jsonl"]) {
      assert.equal(
        readFileSync(path.join(a, f), "utf8"),
        readFileSync(path.join(b, f), "utf8"),
        `${f} 两次导出不一致（说明排序不稳定）`,
      );
    }
    const ma = JSON.parse(readFileSync(path.join(a, "manifest.json"), "utf8"));
    const mb = JSON.parse(readFileSync(path.join(b, "manifest.json"), "utf8"));
    assert.notEqual(ma.exportedAt, mb.exportedAt, "时间戳本来就该不同");
    assert.deepEqual(ma.counts, mb.counts);
    assert.deepEqual(ma.files, mb.files, "文件哈希必须一致");
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
});

test("导回空库：条数一致（「客户拿得走」才算验证过）", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "arch-roundtrip-"));
  try {
    const src = seedDb();
    const manifest = exportArchive(src, { dir, now: NOW });

    const dst = freshEmptyDb();
    const imported = importArchive(dst, { dir });
    assert.equal(imported.conversations, manifest.counts.conversations);
    assert.equal(imported.messages, manifest.counts.messages);
    assert.equal(imported.media, manifest.counts.media);
    assert.equal(imported.losses, manifest.counts.losses);

    const cov = store.coverageReport(dst);
    assert.equal(cov.messages.total, 2);
    assert.equal(cov.conversations.total, 2);
    assert.equal(cov.conversations.agreed, 1);
    assert.equal(cov.conversations.disagreed, 1, "同意状态必须原样搬过去");
    // 附件的关键凭据 sdkFileId 不能丢，否则客户拿到的库取不回附件
    const media = dst.prepare("SELECT sdk_file_id FROM archive_media").get();
    assert.equal(media.sdk_file_id, "FID-1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("manifest 自带覆盖口径：不宣称全量", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "arch-note-"));
  try {
    const manifest = exportArchive(seedDb(), { dir, now: NOW });
    assert.ok(manifest.coverageNote.includes("5 天"));
    assert.ok(manifest.coverageNote.includes("不宣称覆盖全部历史"));
    assert.ok(manifest.format.includes("JSONL"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("integrityCheck 对正常库返回 ok", () => {
  assert.equal(integrityCheck(seedDb()), "ok");
});

// ── 打包边界 ────────────────────────────────────────────────────────────────

test("真仓库通过打包边界审计（无 SDK 二进制、无私钥）", () => {
  const out = auditPackaging({ root: ROOT });
  assert.equal(out.ok, true, JSON.stringify(out.violations, null, 2));
  assert.ok(out.scanned > 0);
});

test("审计会变红：出现 SDK 二进制即违规", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "audit-sdk-"));
  try {
    writeFileSync(path.join(dir, "libWeWorkFinanceSdk_C.so"), "binary");
    const out = auditPackaging({ root: dir });
    assert.equal(out.ok, false);
    assert.equal(out.violations[0].kind, "sdk-binary");
    assert.ok(out.violations[0].fix.includes("不得随包分发"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("审计会变红：出现私钥即违规", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "audit-key-"));
  try {
    writeFileSync(
      path.join(dir, "private.pem"),
      "-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----\n",
    );
    const out = auditPackaging({ root: dir });
    assert.equal(out.ok, false);
    assert.equal(out.violations[0].kind, "private-key");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("审计会变红：依赖树里出现打包型封装", () => {
  const out = auditPackaging({
    root: ROOT,
    files: [],
    deps: ["lodash", "pyWecomArchive"],
  });
  assert.equal(out.ok, false);
  assert.equal(out.violations[0].kind, "bundled-sdk-dependency");
});

// 构建上下文：Dockerfile 是 `COPY . .`，源仓库干净不等于镜像干净。
// 这三条守的是「.dockerignore 里少了规则」——少一条，那类文件就会随镜像出去。
test("审计会变红：.dockerignore 缺 SDK 排除规则", () => {
  const out = auditPackaging({
    root: ROOT,
    files: [],
    deps: [],
    ignoreRules: ["node_modules", "*.pem", "*.key"],
  });
  assert.equal(out.ok, false);
  const gap = out.violations.find((v) => v.kind === "dockerignore-gap");
  assert.ok(gap, JSON.stringify(out.violations));
  assert.ok(gap.path.includes("libWeWorkFinanceSdk"), gap.path);
});

test("审计会变红：.dockerignore 缺私钥排除规则", () => {
  const out = auditPackaging({
    root: ROOT,
    files: [],
    deps: [],
    ignoreRules: ["node_modules", "**/libWeWorkFinanceSdk*"],
  });
  assert.equal(out.ok, false);
  const kinds = out.violations.filter((v) => v.kind === "dockerignore-gap").map((v) => v.path);
  assert.ok(kinds.some((p) => p.includes(".pem")), JSON.stringify(kinds));
  assert.ok(kinds.some((p) => p.includes(".key")), JSON.stringify(kinds));
});

test("审计会变红：有 Dockerfile 但没有 .dockerignore", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "audit-noignore-"));
  try {
    writeFileSync(path.join(dir, "Dockerfile"), "FROM alpine:3\nCOPY . .\n");
    const missing = auditPackaging({ root: dir, files: [], deps: [] });
    assert.equal(missing.ok, false);
    assert.equal(missing.violations[0].kind, "dockerignore-missing");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// 「有 Dockerfile 才检查」这个前提本身要守住：没有 Dockerfile 的目录不该被要求
// 提供 .dockerignore，否则纯 npm 客户端包和测试夹具都会被误判。
test("没有 Dockerfile 的目录不要求 .dockerignore", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "audit-nodockerfile-"));
  try {
    const out = auditPackaging({ root: dir, files: [], deps: [] });
    assert.equal(out.ok, true, JSON.stringify(out.violations));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("真仓库的 .dockerignore 覆盖全部必需项（与 .dockerignore 规则同步的守卫）", () => {
  const rules = readIgnoreRules(ROOT);
  assert.ok(rules && rules.length > 10, "真仓库应有 .dockerignore");
  const joined = rules.join("\n");
  for (const needle of ["libWeWorkFinanceSdk", ".pem", ".key", "private_key"]) {
    assert.ok(joined.includes(needle), `缺 ${needle} 排除规则`);
  }
  // 前提守卫：Dockerfile 一旦从 `COPY . .` 改成白名单，这组检查的前提就变了
  const df = readFileSync(path.join(ROOT, "Dockerfile"), "utf8");
  assert.ok(
    /^COPY\s+\.\s+\.\s*$/m.test(df),
    "Dockerfile 不再有 `COPY . .`——请重新评估这组守卫是否还需要，而不是直接删掉",
  );
});

test("node_modules 与 data 目录不参与扫描（它们不是交付物）", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "audit-skip-"));
  try {
    mkdirSync(path.join(dir, "node_modules", "x"), { recursive: true });
    writeFileSync(path.join(dir, "node_modules", "x", "libWeWorkFinanceSdk_C.so"), "binary");
    mkdirSync(path.join(dir, "data"), { recursive: true });
    writeFileSync(path.join(dir, "data", "private.pem"), "-----BEGIN PRIVATE KEY-----\nx\n");
    const files = walk(dir);
    assert.equal(files.length, 0, files.join(","));
    assert.equal(auditPackaging({ root: dir, files }).ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI 可执行：通过时退出 0 并打印一行结论", () => {
  const script = path.join(ROOT, "scripts", "audit-archive-packaging.mjs");
  const out = execFileSync(process.execPath, [script, "--root", ROOT], { encoding: "utf8" });
  assert.ok(out.includes("打包边界审计通过"), out);
});

// ── 交付侧 CLI（activate --check / integrity / export）────────────────────────

const ARCHIVE_CLI = path.join(ROOT, "server", "archive", "cli.mjs");

function runArchiveCli(args, env, cwd) {
  try {
    const stdout = execFileSync(process.execPath, [ARCHIVE_CLI, ...args], {
      encoding: "utf8",
      cwd: cwd || ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });
    return { status: 0, stdout };
  } catch (err) {
    return { status: err.status ?? 1, stdout: String(err.stdout || ""), stderr: String(err.stderr || "") };
  }
}

test("activate --check 未配置：退出码非 0，且逐项点名（没挂 SDK 也不崩）", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "arch-cli-"));
  try {
    const res = runArchiveCli(["activate", "--check"], {
      ARCHIVE_DB: path.join(dir, "a.db"),
      ARCHIVE_ENABLED: "",
      ARCHIVE_SECRET: "",
      ARCHIVE_PRIVATE_KEY: "",
      ARCHIVE_SEAT_SCOPE: "",
      ARCHIVE_SDK_PATH: "",
    });
    assert.equal(res.status, 1, res.stdout + (res.stderr || ""));
    const out = JSON.parse(res.stdout);
    assert.equal(out.ok, false);
    for (const b of [
      "archive_not_enabled",
      "private_key_missing",
      "secret_missing",
      "seat_scope_unset",
    ]) {
      assert.ok(out.blockers.includes(b), `缺少 ${b}：${JSON.stringify(out.blockers)}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("integrity：正常库退出 0", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "arch-cli-int-"));
  try {
    const dbFile = path.join(dir, "a.db");
    // 先用 store 建一个正常库
    const db = new DatabaseSync(dbFile);
    store.ensureArchiveSchema(db);
    db.close();
    const res = runArchiveCli(["integrity"], { ARCHIVE_DB: dbFile });
    assert.equal(res.status, 0);
    assert.equal(JSON.parse(res.stdout).integrity, "ok");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("deactivate：出凭据、不删数据（库文件仍在且可读）", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "arch-cli-deact-"));
  try {
    const dbFile = path.join(dir, "a.db");
    const db = new DatabaseSync(dbFile);
    store.ensureArchiveSchema(db);
    store.insertMessage(db, {
      id: "c1:m1",
      conversationId: "c1",
      msgId: "m1",
      sentAt: NOW,
      origin: "peer",
      msgType: "text",
      text: "停用后还得能读",
    });
    db.close();

    const res = runArchiveCli(["deactivate"], { ARCHIVE_DB: dbFile });
    assert.equal(res.status, 0, res.stdout + (res.stderr || ""));
    const receipt = JSON.parse(res.stdout);
    assert.equal(receipt.deletesAnything, false, "停用不得删除任何东西");
    assert.equal(receipt.counts.messages, 1);
    assert.equal(receipt.integrity, "ok");
    assert.ok(receipt.dbBytes > 0);

    // 文件必须还在，且内容仍可读
    const check = new DatabaseSync(dbFile);
    const row = check.prepare("SELECT text FROM archive_message").get();
    assert.equal(row.text, "停用后还得能读");
    check.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("export：写盘并给出清单，退出 0", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "arch-cli-exp-"));
  try {
    const dbFile = path.join(dir, "a.db");
    const db = new DatabaseSync(dbFile);
    store.ensureArchiveSchema(db);
    store.insertMessage(db, {
      id: "c1:m1",
      conversationId: "c1",
      msgId: "m1",
      sentAt: NOW,
      origin: "peer",
      msgType: "text",
      text: "导出我",
    });
    db.close();

    const outDir = path.join(dir, "out");
    const res = runArchiveCli(["export", "--dir", outDir], { ARCHIVE_DB: dbFile });
    assert.equal(res.status, 0, res.stdout + (res.stderr || ""));
    const manifest = JSON.parse(res.stdout);
    assert.equal(manifest.counts.messages, 1);
    assert.equal(manifest.integrity, "ok");
    assert.ok(readFileSync(path.join(outDir, "messages.jsonl"), "utf8").includes("导出我"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 第 5 项：git 历史（2026-11-12 补）──────────────────────────────────────
//
// 为什么单独验：CI 是从某个 commit clone 后构建的。文件后来被删掉也没用——
// 那个 commit 仍然能构建出带 SDK 的镜像。工作区干净 ≠ 历史干净。

test("审计第 5 项：非 git 目录明确报「未检查」，不假装通过", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "audit-nogit-"));
  try {
    writeFileSync(path.join(dir, "Dockerfile"), "FROM scratch\n");
    writeFileSync(path.join(dir, ".dockerignore"), "**/libWeWorkFinanceSdk*\n*.pem\n*.key\n");
    const out = auditPackaging({ root: dir });
    assert.equal(out.history.state, "skipped");
    assert.equal(out.ok, true, "非 git 环境不该因此判红");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("审计第 5 项：工作区已删、但历史提交过的 SDK 仍判违规", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "audit-hist-"));
  const git = (...args) =>
    execFileSync("git", ["-C", dir, ...args], {
      encoding: "utf8",
      env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "a@b", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "a@b" },
    });
  try {
    writeFileSync(path.join(dir, "Dockerfile"), "FROM scratch\n");
    writeFileSync(path.join(dir, ".dockerignore"), "**/libWeWorkFinanceSdk*\n*.pem\n*.key\n");
    git("init", "-q");
    git("add", "-A");
    git("commit", "-q", "-m", "干净起点");
    assert.equal(auditPackaging({ root: dir }).history.state, "clean");

    // 提交一次 SDK，再从工作区删掉并提交：工作区干净，历史不干净
    writeFileSync(path.join(dir, "libWeWorkFinanceSdk_C.so"), "binary");
    git("add", "-A");
    git("commit", "-q", "-m", "tmp: 假 SDK 进历史");
    rmSync(path.join(dir, "libWeWorkFinanceSdk_C.so"));
    git("add", "-A");
    git("commit", "-q", "-m", "tmp: 又从工作区删掉");

    const out = auditPackaging({ root: dir });
    assert.equal(out.history.state, "dirty");
    assert.equal(out.ok, false, "历史里有 SDK 必须判红");
    assert.ok(out.violations.some((v) => v.kind === "sdk-in-history"), JSON.stringify(out.violations));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
