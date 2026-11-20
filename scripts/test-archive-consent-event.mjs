#!/usr/bin/env node
// ── 同意变更回调 `msg_audit_approved`（任务 3.2b）────────────────────────────
//
// 守的是四条，每条都对应一个真实的错法：
//
//   1. 状态读不懂就"当同意" → 越权存档。所以读不懂**只失效、不落库**。
//   2. 状态读不懂就"当不同意" → 客户的会话被静默丢弃且不可见。同样不行。
//      正确答案是：什么都不写，让下一次拉取重新问官方接口。
//   3. 回调只清自己进程的缓存 → 拉取进程继续用旧结论。所以有跨进程水位表。
//   4. 别的回调事件也走这条路径 → 进入会话、通讯录变更之类的事件被误当同意变更。
//      非本事件必须零副作用（回调 URL 是全企业共用的）。
//
//   node --test scripts/test-archive-consent-event.mjs

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { test } from "node:test";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const {
  APPROVAL_EVENT,
  parseApprovalEvent,
  applyApprovalEvent,
} = await import("../server/archive/consent-event.js");
const { createConsentCache } = await import("../server/archive/consent.js");
const store = await import("../server/archive/store.js");

const NOW = 1_700_000_000_000;

function freshDb() {
  const db = new DatabaseSync(":memory:");
  store.ensureArchiveSchema(db);
  return db;
}

function xml(fields) {
  const body = Object.entries(fields)
    .map(([k, v]) => `<${k}><![CDATA[${v}]]></${k}>`)
    .join("");
  return `<xml><ToUserName><![CDATA[ww1]]></ToUserName><MsgType><![CDATA[event]]></MsgType>${body}</xml>`;
}

test("解析：群聊事件按 ChatId 定位会话", () => {
  const ev = parseApprovalEvent(
    xml({ Event: APPROVAL_EVENT, UserID: "zhangsan", OpenId: "wmOPEN", ChatId: "wrROOM", Status: "1" }),
  );
  assert.equal(ev.event, APPROVAL_EVENT);
  assert.equal(ev.conversationId, "wrROOM");
  assert.equal(ev.status, "agree");
});

test("解析：单聊事件的会话键必须与 ingest 的 dm 键一致（含排序）", () => {
  const a = parseApprovalEvent(xml({ Event: APPROVAL_EVENT, UserID: "zhangsan", OpenId: "wmOPEN", Status: "0" }));
  const b = parseApprovalEvent(xml({ Event: APPROVAL_EVENT, UserID: "wmOPEN", OpenId: "zhangsan", Status: "0" }));
  assert.equal(a.conversationId, "dm:wmOPEN:zhangsan");
  assert.equal(a.conversationId, b.conversationId, "两端视角必须归一到同一个键，否则失效打偏");
  assert.equal(a.status, "disagree");
});

test("解析：容忍非 CDATA 写法与字段名变体", () => {
  const plain = "<xml><Event>msg_audit_approved</Event><Userid>zhangsan</Userid><ExternalOpenId>wmOPEN</ExternalOpenId><AgreeStatus>Agree</AgreeStatus></xml>";
  const ev = parseApprovalEvent(plain);
  assert.equal(ev.event, APPROVAL_EVENT);
  assert.equal(ev.status, "agree");
  assert.equal(ev.conversationId, "dm:wmOPEN:zhangsan");
});

test("同意：落库 + 缓存失效 + 写水位", () => {
  const db = freshDb();
  const cache = createConsentCache({ now: () => NOW });
  cache.set("wmOPEN", "disagree");
  cache.set("wrROOM", "disagree");

  const out = applyApprovalEvent({
    db,
    cache,
    xml: xml({ Event: APPROVAL_EVENT, UserID: "zhangsan", OpenId: "wmOPEN", Status: "1" }),
    now: () => NOW,
  });

  assert.equal(out.handled, true);
  assert.equal(out.status, "agree");
  assert.equal(out.persisted, true);
  assert.equal(out.invalidated, "one");
  assert.equal(cache.get("dm:wmOPEN:zhangsan"), null, "该会话缓存必须被清掉");
  assert.equal(cache.get("wrROOM"), "disagree", "只失效指定会话");
  assert.equal(store.getAgreeState(db, "dm:wmOPEN:zhangsan"), "agree");
  assert.ok(store.lastConsentEventAt(db, "dm:wmOPEN:zhangsan") > 0, "必须留下跨进程水位");
});

test("状态读不懂：只失效、不落库、不猜", () => {
  const db = freshDb();
  const cache = createConsentCache({ now: () => NOW });
  cache.set("wrROOM", "agree");

  const out = applyApprovalEvent({
    db,
    cache,
    xml: xml({ Event: APPROVAL_EVENT, ChatId: "wrROOM", Status: "maybe" }),
    now: () => NOW,
  });

  assert.equal(out.handled, false);
  assert.equal(out.persisted, false);
  assert.ok(String(out.reason).startsWith("unrecognized_status"), out.reason);
  assert.equal(cache.get("wrROOM"), null, "读不懂也要失效——不该继续用旧结论");
  assert.equal(store.getAgreeState(db, "wrROOM"), "unknown", "不得写任何状态");
});

test("撤回同意（Status=0）：落库为 disagree，且不会被后续 unknown 覆盖", () => {
  const db = freshDb();
  applyApprovalEvent({
    db,
    cache: createConsentCache({ now: () => NOW }),
    xml: xml({ Event: APPROVAL_EVENT, ChatId: "wrROOM", Status: "0" }),
    now: () => NOW,
  });
  assert.equal(store.getAgreeState(db, "wrROOM"), "disagree");

  applyApprovalEvent({
    db,
    cache: createConsentCache({ now: () => NOW }),
    xml: xml({ Event: APPROVAL_EVENT, ChatId: "wrROOM", Status: "?" }),
    now: () => NOW,
  });
  assert.equal(store.getAgreeState(db, "wrROOM"), "disagree", "读不懂不得把已有结论洗成 unknown");
});

test("认不出会话：全清缓存 + 记全局水位", () => {
  const db = freshDb();
  const cache = createConsentCache({ now: () => NOW });
  cache.set("r1", "agree");
  cache.set("r2", "agree");

  const out = applyApprovalEvent({
    db,
    cache,
    xml: xml({ Event: APPROVAL_EVENT, Status: "1" }),
    now: () => NOW,
  });

  assert.equal(out.handled, false);
  assert.equal(out.reason, "unresolved_conversation");
  assert.equal(out.invalidated, "all");
  assert.equal(cache.size(), 0, "认不出是哪个会话就全清（TTL 5 分钟，代价近乎零）");
  assert.ok(store.lastConsentEventAt(db, "任意会话") > 0, "全局水位要对所有会话生效");
});

test("不是同意变更事件：零副作用", () => {
  const db = freshDb();
  const cache = createConsentCache({ now: () => NOW });
  cache.set("r1", "agree");

  const out = applyApprovalEvent({
    db,
    cache,
    xml: xml({ Event: "enter_agent", UserID: "zhangsan", Status: "1" }),
    now: () => NOW,
  });

  assert.equal(out.handled, false);
  assert.equal(out.reason, "not_approval_event");
  assert.equal(out.invalidated, "none");
  assert.equal(cache.get("r1"), "agree", "别的回调不该清缓存");
  assert.equal(store.lastConsentEventAt(db, "r1"), 0, "别的回调不该写水位");
});

// ── 接线：命令行真的把回调接到库里（不是"模块写好了但没人调"）──────────────

const CLI = path.resolve(import.meta.dirname, "..", "server", "archive", "cli.mjs");
const ROOT = path.resolve(import.meta.dirname, "..");

function runCli(args, { stdin = "", env = {} } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "archive-consent-cli-"));
  const dbFile = path.join(dir, "archive.db");
  const res = spawnSync("node", [CLI, ...args], {
    cwd: ROOT,
    input: stdin,
    encoding: "utf8",
    timeout: 60_000,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ARCHIVE_DB: dbFile, ...env },
  });
  return { ...res, dbFile, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("cli consent-event：stdin 的回调直接落库（退出码 0）", () => {
  const run = runCli(["consent-event"], {
    stdin: xml({ Event: APPROVAL_EVENT, ChatId: "wrCLI", Status: "1" }),
  });
  try {
    assert.equal(run.status, 0, `stderr: ${run.stderr}`);
    const db = new DatabaseSync(run.dbFile);
    store.ensureArchiveSchema(db);
    assert.equal(store.getAgreeState(db, "wrCLI"), "agree");
    db.close();
  } finally {
    run.cleanup();
  }
});

test("cli consent-event：非本通道事件退出码 0（共用回调 URL 是常态）", () => {
  const run = runCli(["consent-event"], {
    stdin: xml({ Event: "enter_agent", UserID: "zhangsan" }),
  });
  try {
    assert.equal(run.status, 0, `stderr: ${run.stderr}`);
    assert.match(run.stdout, /not_approval_event/);
  } finally {
    run.cleanup();
  }
});

test("cli consent-event：读不懂的状态退出码 1（网关应记失败）", () => {
  const run = runCli(["consent-event"], {
    stdin: xml({ Event: APPROVAL_EVENT, ChatId: "wrCLI", Status: "?" }),
  });
  try {
    assert.equal(run.status, 1, `stdout: ${run.stdout} stderr: ${run.stderr}`);
    assert.match(run.stdout, /unrecognized_status/);
  } finally {
    run.cleanup();
  }
});

test("cli pull：没有 corpId/secret 时拒绝运行（不退化成全部丢弃）", () => {
  const run = runCli(["pull"], { env: { ARCHIVE_CORPID: "", ARCHIVE_SECRET: "" } });
  try {
    assert.equal(run.status, 2, `stdout: ${run.stdout} stderr: ${run.stderr}`);
    assert.match(run.stderr, /ARCHIVE_CORPID/);
  } finally {
    run.cleanup();
  }
});
