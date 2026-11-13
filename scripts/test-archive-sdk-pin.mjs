#!/usr/bin/env node
// ── SDK 文件固定校验 ────────────────────────────────────────────────────────
//
// SDK 由客户自己下载放进挂载点，我们的产物里没有它。于是"被替换过的 .so"与正版
// 在行为上无法区分——而它跑在客户生产环境、能读到用客户私钥解出的明文。
// sha256 钉住是最便宜的防线，代价是客户升级 SDK 要改一个值。
//
// 关键断言：**不符就拒**，而且四种状态要能分开（缺/读不了/不符/未固定），
// 因为"未固定"如果被当成通过且不告知，就等于假装校验过。
//
//   node --test scripts/test-archive-sdk-pin.mjs

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const { verifySdkFile } = await import("../server/archive/sdk.js");
const { runDoctor } = await import("../server/archive/doctor.js");
const store = await import("../server/archive/store.js");

const NOW = 1_700_000_000_000;

function freshDb() {
  const db = new DatabaseSync(":memory:");
  store.ensureArchiveSchema(db);
  return db;
}

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

test("文件不存在：state=missing，不算通过", () => {
  const out = verifySdkFile({ path: "/nonexistent/libWeWorkFinanceSdk_C.so", expectedSha256: "abc" });
  assert.equal(out.ok, false);
  assert.equal(out.state, "missing");
});

test("未给路径：state=missing，不抛异常", () => {
  const out = verifySdkFile({ path: "", expectedSha256: "abc" });
  assert.equal(out.ok, false);
  assert.equal(out.state, "missing");
});

test("哈希相符：state=ok", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sdk-pin-ok-"));
  try {
    const file = path.join(dir, "libWeWorkFinanceSdk_C.so");
    const payload = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x01]);
    writeFileSync(file, payload);
    const out = verifySdkFile({ path: file, expectedSha256: sha256(payload) });
    assert.equal(out.ok, true);
    assert.equal(out.state, "ok");
    assert.equal(out.actual, sha256(payload));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("哈希不符：state=mismatch，且带期望与实际两个值", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sdk-pin-bad-"));
  try {
    const file = path.join(dir, "libWeWorkFinanceSdk_C.so");
    writeFileSync(file, "tampered");
    const out = verifySdkFile({ path: file, expectedSha256: "0".repeat(64) });
    assert.equal(out.ok, false);
    assert.equal(out.state, "mismatch");
    assert.equal(out.expected, "0".repeat(64));
    assert.equal(out.actual, sha256(Buffer.from("tampered")));
    assert.ok(out.message.includes("sha256 不符"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("大小写与空白不敏感（客户从文档里复制哈希常带空格）", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sdk-pin-case-"));
  try {
    const file = path.join(dir, "sdk.so");
    const payload = Buffer.from("x");
    writeFileSync(file, payload);
    const out = verifySdkFile({ path: file, expectedSha256: `  ${sha256(payload).toUpperCase()}  ` });
    assert.equal(out.ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("未配置期望值：允许运行但明确标为 unpinned（不假装校验过）", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sdk-pin-none-"));
  try {
    const file = path.join(dir, "sdk.so");
    writeFileSync(file, "whatever");
    const out = verifySdkFile({ path: file, expectedSha256: "" });
    assert.equal(out.ok, true);
    assert.equal(out.state, "unpinned");
    assert.ok(out.actual, "仍要给出实际哈希，方便部署方回填");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("文件存在但读不了：state=unreadable，与 missing 区分", () => {
  const out = verifySdkFile({
    path: "/some/path",
    expectedSha256: "abc",
    readFile: () => {
      const err = new Error("EACCES: permission denied");
      err.code = "EACCES";
      throw err;
    },
  });
  assert.equal(out.ok, false);
  assert.equal(out.state, "unreadable");
  assert.ok(out.message.includes("EACCES"));
});

test("doctor：哈希不符进 blockers（拒绝启动）", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sdk-pin-doc-"));
  try {
    const file = path.join(dir, "libWeWorkFinanceSdk_C.so");
    writeFileSync(file, "tampered");
    const db = freshDb();
    const result = await runDoctor({
      db,
      config: { sdkPath: file, expectedSdkSha256: "f".repeat(64) },
      now: NOW,
    });
    assert.equal(result.ok, false);
    assert.ok(result.blockers.includes("sdk_sha256_mismatch"), JSON.stringify(result.blockers));
    assert.equal(result.checks.sdkPin, "mismatch");
    assert.equal(result.checks.sdkExpectedSha256, "f".repeat(64));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("doctor：未固定不阻塞，但 checks 里看得见", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sdk-pin-doc2-"));
  try {
    const file = path.join(dir, "libWeWorkFinanceSdk_C.so");
    writeFileSync(file, "real");
    const db = freshDb();
    const result = await runDoctor({ db, config: { sdkPath: file }, now: NOW });
    assert.equal(result.checks.sdkPin, "unpinned");
    assert.ok(!result.blockers.includes("sdk_sha256_mismatch"));
    assert.ok(result.checks.sdkActualSha256, "必须给出实际哈希供回填");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
