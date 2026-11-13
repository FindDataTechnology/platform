#!/usr/bin/env node
// ── 文档库的 office 格式抽取（fix-office-format-extraction）──────────────────
//
// 守的是一类"表面只是导入失败、实则能把进程带走"的故障：
//
//   1. officeparser v7 的回调给的是对象（文本在 `.toText()`），按字符串用就抛
//      `text.trim is not a function` —— 表现为"Excel 传不进去"。
//   2. 同一路径下 `parseOffice` 还会把这个错**再抛一次**，没人接的 promise 变成
//      unhandledRejection。Node 默认策略结束进程，所以一份坏文件就能让服务退出。
//
// 所以这里同时断言"抽得出"和"抽不出时也没有未捕获拒绝"——只断言前者会漏掉第 2 条。
//
//   node --test scripts/test-office-format-extraction.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

let readers = null;
try {
  readers = await import("../readers.js");
} catch {
  readers = null;
}

const XLSX_PATH = path.resolve("docs/vertical-packs/skills/doc-studio/samples/S2-数据工作簿.xlsx");
let XLSX = null;
try {
  XLSX = readFileSync(XLSX_PATH);
} catch {
  XLSX = null;
}

// 干净 worktree 没有 node_modules 时整组 skip：红应当表示"代码坏了"，不是"这台机器没装包"。
const SKIP = !readers && "依赖未安装";
const SKIP_XLSX = !XLSX && "缺 xlsx 夹具";

/** 在一个独立窗口里数未捕获拒绝。 */
async function countUnhandled(fn) {
  let count = 0;
  const onReject = () => {
    count += 1;
  };
  process.on("unhandledRejection", onReject);
  try {
    await fn();
    // 拒绝是在微任务/下一轮 tick 之后才被判定为"未捕获"的，必须等一拍。
    await new Promise((r) => setTimeout(r, 300));
  } finally {
    process.off("unhandledRejection", onReject);
  }
  return count;
}

test("真 xlsx 抽得出正文", { skip: SKIP || SKIP_XLSX }, async () => {
  const text = await readers.extractText("xlsx", XLSX);
  assert.ok(text.includes("毛利率"), `应含表头「毛利率」，实际前 80 字：${text.slice(0, 80)}`);
});

test("坏文件：抛可读错误，且不产生未捕获拒绝", { skip: SKIP }, async () => {
  let thrown = null;
  const unhandled = await countUnhandled(async () => {
    try {
      // ZIP 头对、内容不是合法容器 —— 最接近"客户发来一个半截文件"的形态。
      await readers.extractText("xlsx", Buffer.from("PK\u0003\u0004这不是一个真的 zip 容器", "utf8"));
    } catch (err) {
      thrown = err;
    }
  });

  assert.ok(thrown, "坏文件必须抛出，而不是静默返回空文本");
  assert.match(String(thrown.message), /officeparser/i, "错误要指向解析器，便于归因");
  assert.equal(unhandled, 0, "解析失败不得变成未捕获拒绝（默认会结束进程）");
});

test("空内容判失败，不返回空文本", { skip: SKIP }, async () => {
  await assert.rejects(() => readers.extractText("csv", Buffer.from("")), /empty/i);
});

test("未知类型仍然拒绝，不静默", { skip: SKIP }, async () => {
  await assert.rejects(() => readers.extractText("nope", Buffer.from("x")), /No reader/);
});
