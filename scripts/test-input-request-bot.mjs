// Input requests on the bot lane (add-input-request-cards, task 4.5):
//
//   §1 字段解析：枚举（数字/原文）、布尔（是/否）、数字、日期文本、取消词。
//   §2 渲染：一次问一个必填字段，带序号与取消提示；bot 能读懂。
//
// 只测纯函数——投递链路要真 bot 适配器，那属于 e2e（6.x）。

import { test, before } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "input-request-bot-"));
process.env.DB_PATH = path.join(tmpRoot, "app.db");
process.env.PLATFORM_DATA_DIR = tmpRoot;

before(async () => {
  const dbMod = await import("../db.js");
  await dbMod.initDb();
});

test("4.5 枚举字段：数字与原文都认", async () => {
  const { parseInputField } = await import("../server/bots.js");
  const field = {
    key: "channel",
    kind: "enum",
    label: "渠道",
    options: [
      { value: "online", label: "线上" },
      { value: "offline", label: "线下" },
    ],
  };
  assert.deepEqual(parseInputField("1", field), { kind: "value", value: "online" });
  assert.deepEqual(parseInputField("线下", field), { kind: "value", value: "offline" });
  assert.deepEqual(parseInputField("2. 线下", field), { kind: "value", value: "offline" });
  assert.equal(parseInputField("电话", field).kind, "reprompt");
  assert.equal(parseInputField("取消", field).kind, "cancel");
});

test("4.5b 布尔字段：是中英文都认，别的重问", async () => {
  const { parseInputField } = await import("../server/bots.js");
  const field = { key: "ok", kind: "boolean", label: "确认" };
  assert.deepEqual(parseInputField("是", field), { kind: "value", value: true });
  assert.deepEqual(parseInputField("否", field), { kind: "value", value: false });
  assert.deepEqual(parseInputField("yes", field), { kind: "value", value: true });
  assert.equal(parseInputField("可能吧", field).kind, "reprompt");
});

test("4.5c 数字字段：千分位也能解析，非数字重问", async () => {
  const { parseInputField } = await import("../server/bots.js");
  const field = { key: "amount", kind: "number", label: "金额" };
  assert.deepEqual(parseInputField("1200", field), { kind: "value", value: 1200 });
  assert.deepEqual(parseInputField("1,200", field), { kind: "value", value: 1200 });
  assert.equal(parseInputField("很多", field).kind, "reprompt");
});

test("4.5d 文本/日期/文件字段原样收下，空串重问", async () => {
  const { parseInputField } = await import("../server/bots.js");
  assert.deepEqual(parseInputField("甲公司", { kind: "text" }), { kind: "value", value: "甲公司" });
  assert.deepEqual(parseInputField("2026-11-30", { kind: "date" }), {
    kind: "value",
    value: "2026-11-30",
  });
  assert.deepEqual(parseInputField("https://x/y.pdf", { kind: "file" }), {
    kind: "value",
    value: "https://x/y.pdf",
  });
  assert.equal(parseInputField("   ", { kind: "text" }).kind, "reprompt");
});
