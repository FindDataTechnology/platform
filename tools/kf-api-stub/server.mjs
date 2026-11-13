#!/usr/bin/env node
// ── qyapi 本地桩：只为验证 kf 客户端的传输层 ────────────────────────────────
//
// 它证明的是「CLI 进程 → kf 客户端 → 真 HTTP → 响应 → 入库 → 检索」这条链跑得通，
// 覆盖注入 fetch 测不到的东西：URL 拼装、query 编码、body 序列化、AbortSignal、
// 以及"HTTP 200 但 errcode 非 0"这种必须当成错误的分支。
//
// ⚠ 它**不**证明腾讯的响应形状就是这样。报文按官方文档抄写，真账号验收时
// （tasks 7.3）必须拿一条真实响应比对一次——夹具形状写错了比没测试更危险。
//
// 用法（测试里 spawn 它，端口由系统分配后打到 stdout 第一行）：
//   node tools/kf-api-stub/server.mjs
//   {"port":53211}

import { createServer } from "node:http";

const SECRET = "S".repeat(40);
const OPEN_KFID = "kf-stub-1";
const ACCESS_TOKEN = "TOKEN-STUB-" + "x".repeat(8);

const SEND_AT = Math.floor(Date.parse("2026-11-11T10:00:00Z") / 1000);

// 三个批次：客户问价 → 接待人员回复 → 系统事件收尾。origin 覆盖 3/5/4。
const BATCHES = [
  {
    next_cursor: "c1",
    has_more: 1,
    msg_list: [
      {
        msgid: "stub-m1",
        open_kfid: OPEN_KFID,
        external_userid: "wmCUST0001",
        send_time: SEND_AT,
        origin: 3,
        msgtype: "text",
        text: { content: "你们能开专票吗？需要一份报价" },
      },
    ],
  },
  {
    next_cursor: "c2",
    has_more: 0,
    msg_list: [
      {
        msgid: "stub-m2",
        open_kfid: OPEN_KFID,
        external_userid: "wmCUST0001",
        send_time: SEND_AT + 30,
        origin: 5,
        servicer_userid: "zhangsan",
        msgtype: "text",
        text: { content: "可以开专票，报价单稍后发您" },
      },
      {
        msgid: "stub-m3",
        open_kfid: OPEN_KFID,
        external_userid: "wmCUST0001",
        send_time: SEND_AT + 60,
        origin: 4,
        msgtype: "event",
        event: { event_type: "session_status_change" },
      },
    ],
  },
];

/** 记录收到的请求，测试结束后由测试侧读取断言。 */
const seen = {
  gettoken: 0,
  sync_msg: 0,
  send_msg: 0,
  customer_batchget: 0,
  account_list: 0,
  media_get: 0,
  sent: [],
  violations: [],
};

function send(res, obj, status = 200) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(body);
}

/** 二进制响应：带 content-disposition，模拟真实 CDN/接口的形态。 */
function sendBinary(res, buf, { type = "image/jpeg", filename = "stub.jpg" } = {}) {
  res.writeHead(200, {
    "content-type": type,
    "content-disposition": `attachment; filename="${filename}"`,
    "content-length": String(buf.length),
  });
  res.end(buf);
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve({ __badJson: raw });
      }
    });
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  const token = url.searchParams.get("access_token") || "";

  if (url.pathname === "/__seen") {
    send(res, seen);
    return;
  }

  if (url.pathname === "/cgi-bin/gettoken") {
    seen.gettoken += 1;
    if (url.searchParams.get("corpsecret") !== SECRET) {
      send(res, { errcode: 40001, errmsg: "invalid credential" });
      return;
    }
    send(res, { errcode: 0, errmsg: "ok", access_token: ACCESS_TOKEN, expires_in: 7200 });
    return;
  }

  // 其余接口都要求令牌，且令牌必须在 query（官方形态）
  if (token !== ACCESS_TOKEN) {
    send(res, { errcode: 40014, errmsg: "invalid access_token" });
    return;
  }

  if (url.pathname === "/cgi-bin/kf/account/list") {
    seen.account_list += 1;
    send(res, { errcode: 0, errmsg: "ok", account_list: [{ open_kfid: OPEN_KFID, name: "寻数科技客服" }] });
    return;
  }

  if (url.pathname === "/cgi-bin/kf/sync_msg") {
    seen.sync_msg += 1;
    const body = await readBody(req);
    if (body.__badJson !== undefined) {
      seen.violations.push(`sync_msg body 不是 JSON：${String(body.__badJson).slice(0, 80)}`);
      send(res, { errcode: 40058, errmsg: "bad json" });
      return;
    }
    // 两条"客户端必须做对"的形状：limit 上限、不得把一次性事件令牌当游标持久化。
    if (Number(body.limit) > 1000) {
      seen.violations.push(`limit 未夹到 1000：${body.limit}`);
      send(res, { errcode: 40058, errmsg: "limit too large" });
      return;
    }
    if (body.token !== undefined) {
      seen.violations.push("请求体里出现了 token（一次性事件令牌不应被持久化复用）");
      send(res, { errcode: 40058, errmsg: "unexpected token" });
      return;
    }
    const cursor = String(body.cursor || "");
    if (!cursor) {
      send(res, { errcode: 0, errmsg: "ok", ...BATCHES[0] });
      return;
    }
    const idx = BATCHES.findIndex((b) => b.next_cursor === cursor);
    const next = BATCHES[idx + 1];
    if (!next) {
      send(res, { errcode: 0, errmsg: "ok", next_cursor: cursor, has_more: 0, msg_list: [] });
      return;
    }
    send(res, { errcode: 0, errmsg: "ok", ...next });
    return;
  }

  if (url.pathname === "/cgi-bin/media/get") {
    seen.media_get += 1;
    const mediaId = url.searchParams.get("media_id") || "";
    // 未知 id 一律返回 HTTP 200 + JSON 错误——这正是"假图片"陷阱的来源。
    if (mediaId !== "MID-OK") {
      seen.violations.push(`media/get 收到未知 id：${mediaId}`);
      send(res, { errcode: 40007, errmsg: "invalid media_id" });
      return;
    }
    // 含 0x00 的二进制：任何按 NUL 截断的实现都会在这里露馅
    sendBinary(res, Buffer.from([0xff, 0xd8, 0x00, 0x01, 0x02, 0x00, 0xff, 0xd9]));
    return;
  }

  if (url.pathname === "/cgi-bin/kf/send_msg") {
    seen.send_msg += 1;
    const body = await readBody(req);
    if (!body.touser || !body.open_kfid) {
      seen.violations.push(`send_msg 缺 touser/open_kfid：${JSON.stringify(body)}`);
      send(res, { errcode: 40058, errmsg: "missing touser/open_kfid" });
      return;
    }
    if (body.msgtype !== "text" || typeof body.text?.content !== "string" || !body.text.content.trim()) {
      seen.violations.push(`send_msg 正文形状不对：${JSON.stringify(body)}`);
      send(res, { errcode: 40058, errmsg: "bad text" });
      return;
    }
    seen.sent.push({
      touser: body.touser,
      openKfId: body.open_kfid,
      content: body.text.content,
    });
    send(res, { errcode: 0, errmsg: "ok", msgid: `STUB-OUT-${seen.sent.length}` });
    return;
  }

  if (url.pathname === "/cgi-bin/kf/customer/batchget") {
    seen.customer_batchget += 1;
    const body = await readBody(req);
    const ids = Array.isArray(body.external_userid_list) ? body.external_userid_list : [];
    send(res, {
      errcode: 0,
      errmsg: "ok",
      customer_list: ids.map((id) => ({
        external_userid: id,
        nickname: "王工",
        avatar: "https://example.invalid/a.png",
        gender: 1,
        unionid: "union-" + id,
      })),
      invalid_external_userid: [],
    });
    return;
  }

  send(res, { errcode: 404, errmsg: `no such path ${url.pathname}` });
});

server.listen(0, "127.0.0.1", () => {
  const { port } = server.address();
  process.stdout.write(`${JSON.stringify({ port })}\n`);
});

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => server.close(() => process.exit(0)));
}
