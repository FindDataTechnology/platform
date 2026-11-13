#!/usr/bin/env node
// ── 用真实响应核对报文形状（一次性，需要真凭据）──────────────────────────────
//
//   export KF_CORPID=ww... KF_SECRET=...
//   node scripts/kf-verify-real.mjs [--open-kfid kfX] [--json]
//
// 它只做三件事：取票、列客服账号、拉一批消息，然后把**原始响应**交给纯函数比对形状。
// 不写库、不发消息、不改任何东西——这是给"第一次接真接口"用的核对工具，
// 失败要能一眼看出是哪个字段变了，而不是等入库之后发现时间不对。
//
// 输出里不会出现 access_token 或 secret（比对只看结构，不看值）。

import { verifyShape, shapeLine } from "../server/archive/kf/verify-shape.js";
import { redact } from "../server/archive/kf/api.js";

const DEFAULT_BASE = "https://qyapi.weixin.qq.com";
const base = process.env.KF_BASE_URL || DEFAULT_BASE;
const corpId = process.env.KF_CORPID || "";
const secret = process.env.KF_SECRET || "";
const openKfId = process.env.KF_OPEN_KFID || "";
const jsonOut = process.argv.includes("--json");

function die(msg) {
  process.stderr.write(`${msg}\n`);
  process.exit(2);
}

if (!corpId || !secret) {
  die("缺少 KF_CORPID / KF_SECRET。用法：KF_CORPID=ww... KF_SECRET=... node scripts/kf-verify-real.mjs");
}

let token = "";
async function callJson({ path, method = "POST", query = {}, body }) {
  const url = new URL(path, base);
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }
  const init = { method, headers: { "content-type": "application/json" } };
  if (body !== undefined) init.body = JSON.stringify(body);
  const resp = await fetch(url.toString(), init);
  const text = await resp.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${path} 返回非 JSON（HTTP ${resp.status}）：${redact(text.slice(0, 200), [secret, token])}`);
  }
}

// 1. 取票
const tokenResp = await callJson({
  path: "/cgi-bin/gettoken",
  method: "GET",
  query: { corpid: corpId, corpsecret: secret },
});
if (Number(tokenResp.errcode) !== 0) {
  process.stderr.write(
    `取票失败：errcode=${tokenResp.errcode} ${redact(tokenResp.errmsg, [secret])}\n` +
      "优先核对 corpid/secret 是否属于同一个自建应用。\n",
  );
  process.exit(1);
}
token = tokenResp.access_token;

// 2. 列客服账号
let accounts = null;
try {
  accounts = await callJson({
    path: "/cgi-bin/kf/account/list",
    query: { access_token: token },
    body: { offset: 0, limit: 100 },
  });
} catch (err) {
  process.stderr.write(`account/list 调用失败：${err.message}\n`);
}

// 3. 拉一批（不推进任何游标：本脚本不写库）
let sync = null;
try {
  sync = await callJson({
    path: "/cgi-bin/kf/sync_msg",
    query: { access_token: token },
    body: { limit: 10, ...(openKfId ? { open_kfid: openKfId } : {}) },
  });
} catch (err) {
  process.stderr.write(`sync_msg 调用失败：${err.message}\n`);
}

// 4. 比对（结构只看形状，不看具体值；输出前整体擦一遍凭据）
const result = verifyShape({
  token: tokenResp,
  accounts: Number(accounts?.errcode) === 0 ? accounts : null,
  sync: Number(sync?.errcode) === 0 ? sync : null,
});

const payload = {
  base,
  accountsOk: Number(accounts?.errcode) === 0,
  syncOk: Number(sync?.errcode) === 0,
  accountErr: Number(accounts?.errcode) === 0 ? null : { errcode: accounts?.errcode, errmsg: redact(accounts?.errmsg, [secret, token]) },
  syncErr: Number(sync?.errcode) === 0 ? null : { errcode: sync?.errcode, errmsg: redact(sync?.errmsg, [secret, token]) },
  sampleCount: Array.isArray(sync?.msg_list) ? sync.msg_list.length : 0,
  shape: result,
};

if (jsonOut) {
  process.stdout.write(`${JSON.stringify(JSON.parse(redact(JSON.stringify(payload), [secret, token])), null, 2)}\n`);
} else {
  process.stdout.write(`${shapeLine(result)}\n`);
  for (const c of result.checks) {
    process.stdout.write(`  ${c.ok ? "✓" : "✗"} ${c.name}`);
    if (!c.ok) process.stdout.write(`  期望 ${c.expected ?? "—"}，实际 ${c.actual ?? "—"}`);
    if (!c.ok && c.note) process.stdout.write(`\n      ${c.note}`);
    process.stdout.write("\n");
  }
  if (payload.accountErr) {
    process.stdout.write(`\naccount/list errcode=${payload.accountErr.errcode} ${payload.accountErr.errmsg}\n`);
  }
  if (payload.syncErr) {
    process.stdout.write(`sync_msg errcode=${payload.syncErr.errcode} ${payload.syncErr.errmsg}\n`);
  }
  process.stdout.write(
    `\n样本 ${payload.sampleCount} 条；如需核对更多类型，从微信侧分别发文本/图片/语音/文件各一条后重跑。\n`,
  );
}

process.exit(result.ok ? 0 : 1);
