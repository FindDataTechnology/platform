#!/usr/bin/env node
// ── 按请求换票并转发（change gateway-line-key-exchange 任务 2.2–2.5 / 3.1–3.2）──
//
// 这一层证的是「一把词元钥真能打到一条网关托管线」，而不是"模块能跑"。所以每条用例
// 都对着**可观测后果**：
//
//   1. 关闭 / 名单空 ⇒ 一条路由都不挂（未开通的线打到同一路径是网关身份兜底 401，
//      不是本车道任何原因码）；
//   2. 已持合法线票 ⇒ 直通（不再换票）；**跨线票必拒**且不退回换票（否则一枚别线的
//      合法票会被当 sk- 去问计费面，得出"钥匙无效"的错答案）；
//   3. `sk-` ⇒ 换票后转发；**上游只看到线票**（客户钥匙不出边缘）；
//   4. 缺上游地址 ⇒ 503 `upstream_unresolved`，且**上游零请求**（fail closed，不猜）；
//   5. SSE（text/event-stream）逐块透传，不是缓冲后一次性返回；
//   6. 上游超时 ⇒ 504 且带 `x-fd-line`；计费面降级 ⇒ 503（不是 401——别让客户以为
//      钥匙坏了去重贴）；
//   7. 日志里不出现 `sk-`；`X-Authorization` 不被写入（那是共享网关的调用方身份通道，
//      非 IdP 不透明令牌进去会被判 401）。
//
//   node --test --test-concurrency=1 scripts/test-line-proxy.mjs

import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";

import express from "express";

import { generateTestKeyPair, mintLineToken } from "../gateway/line-token-exchange.js";
import { manifestUpstreamResolver, registerLineProxy, resolveLineCredential } from "../gateway/line-proxy.js";

const wireKeys = generateTestKeyPair();
const lexKeys = generateTestKeyPair();

/** 一份"开着的"环境：wire 与 lex 各一把钥，facet 不在名单里。 */
const ON = {
  LINE_EXCHANGE_ENABLED: "1",
  LINE_EXCHANGE_LINES: "wire,lex",
  LINE_EXCHANGE_KEY_WIRE: wireKeys.privateKeyPem,
  LINE_EXCHANGE_KID_WIRE: "wire-1",
  LINE_EXCHANGE_KEY_LEX: lexKeys.privateKeyPem,
  LINE_EXCHANGE_KID_LEX: "lex-9",
};

const ISSUER = "https://platform.finddatatech.cloud";

const verifyOk = async (key) =>
  key === "sk-good" ? { ok: true, userId: 42, email: "c@example.com" } : { ok: false, reason: "invalid_key" };
const verifyDegraded = async () => ({ ok: false, status: 503 });

function mintFor(line, { sub = "caller-1", ttl = 120 } = {}) {
  const keys = line === "wire" ? wireKeys : lexKeys;
  return mintLineToken({
    line,
    subject: sub,
    email: "c@example.com",
    scope: "line:read",
    kid: line === "wire" ? "wire-1" : "lex-9",
    privateKey: keys.privateKeyPem,
    ttlSeconds: ttl,
    now: Date.now(),
    issuer: ISSUER,
  });
}

// ── 1. 挂载面（任务 2.2）───────────────────────────────────────────────────

function fakeApp() {
  const mounts = [];
  return { mounts, use: (pathname) => mounts.push(pathname), all: () => assert.fail("应使用 app.use") };
}

test("默认关闭 / 名单为空：一条路由都不挂", () => {
  for (const env of [{}, { ...ON, LINE_EXCHANGE_ENABLED: "false" }, { ...ON, LINE_EXCHANGE_LINES: "" }]) {
    const app = fakeApp();
    assert.equal(registerLineProxy(app, { verifyCaller: verifyOk, resolveUpstream: () => "http://x", env }), 0);
    assert.deepEqual(app.mounts, [], JSON.stringify(env.LINE_EXCHANGE_LINES));
  }
});

test("只给名单里的线挂，且是 /api/lines/<line>/proxy（不是 /token、不是别的线）", () => {
  const app = fakeApp();
  assert.equal(registerLineProxy(app, { verifyCaller: verifyOk, resolveUpstream: () => "http://x", env: ON }), 2);
  assert.deepEqual(app.mounts.sort(), ["/api/lines/lex/proxy", "/api/lines/wire/proxy"]);
});

test("配了名单但没有该线签发钥：那条线不挂（开不了就不能挂）", () => {
  const app = fakeApp();
  const env = { ...ON, LINE_EXCHANGE_KEY_LEX: "" };
  assert.equal(registerLineProxy(app, { verifyCaller: verifyOk, resolveUpstream: () => "http://x", env }), 1);
  assert.deepEqual(app.mounts, ["/api/lines/wire/proxy"]);
});

// ── 2. 凭据判定（任务 2.3 / 3.1）───────────────────────────────────────────

test("无凭据 401 missing_credential", async () => {
  const r = await resolveLineCredential({ line: "wire", authorization: "", env: ON, verifyCaller: verifyOk });
  assert.equal(r.status, 401);
  assert.equal(r.error, "missing_credential");
});

test("已持本线合法线票：直通，不再换票", async () => {
  const token = mintFor("wire");
  let called = 0;
  const r = await resolveLineCredential({
    line: "wire",
    authorization: `Bearer ${token}`,
    env: ON,
    verifyCaller: async () => {
      called += 1;
      return { ok: true, userId: 1 };
    },
  });
  assert.equal(r.ok, true);
  assert.equal(r.via, "line-token");
  assert.equal(r.token, token, "直通必须原样转发，不重新签发");
  assert.equal(called, 0, "已持票时不该再问计费面");
});

test("跨线票必拒，且不退回换票（否则会拿别线的票去问计费面）", async () => {
  const lexToken = mintFor("lex");
  let called = 0;
  const r = await resolveLineCredential({
    line: "wire",
    authorization: `Bearer ${lexToken}`,
    env: ON,
    verifyCaller: async () => {
      called += 1;
      return { ok: true, userId: 1 };
    },
  });
  assert.equal(r.ok, false);
  assert.equal(r.status, 401);
  assert.ok(["wrong_audience", "wrong_source", "bad_signature"].includes(r.error), r.error);
  assert.equal(called, 0, "三段 JWT 验不过就该直接拒");
});

test("sk- 换票：签发新票，aud/source = 目标线，且不再是原本那把 sk-", async () => {
  const r = await resolveLineCredential({ line: "wire", authorization: "Bearer sk-good", env: ON, verifyCaller: verifyOk });
  assert.equal(r.ok, true);
  assert.equal(r.via, "exchanged");
  assert.notEqual(r.token, "sk-good");
  assert.equal(r.claims.aud, "wire");
  assert.equal(r.claims.source, "wire");
  assert.ok(r.claims.exp - r.claims.iat <= 600);
});

test("坏钥匙 401、计费面降级 503（两者不能同形）", async () => {
  const bad = await resolveLineCredential({ line: "wire", authorization: "Bearer sk-bad", env: ON, verifyCaller: verifyOk });
  assert.equal(bad.status, 401);
  const degraded = await resolveLineCredential({ line: "wire", authorization: "Bearer sk-good", env: ON, verifyCaller: verifyDegraded });
  assert.equal(degraded.status, 503, "计费面不可达必须是 503：401 会让客户以为钥匙坏了去重贴");
  assert.notEqual(degraded.error, bad.error);
});

test("名单里但没有签发钥：503 line_signing_key_missing（配置缺失，不是调用方的错）", async () => {
  const env = { ...ON, LINE_EXCHANGE_KEY_WIRE: "" };
  const r = await resolveLineCredential({ line: "wire", authorization: "Bearer sk-good", env, verifyCaller: verifyOk });
  assert.equal(r.status, 503);
  assert.equal(r.error, "line_signing_key_missing");
});

// ── 3. 端到端：真实 express + 假上游（任务 2.4 / 2.5）─────────────────────

/** 起一个假上游，记录收到的请求；handler 决定怎么答。 */
async function withUpstream(handler, fn) {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, headers: req.headers });
    handler(req, res);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn(base, seen);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

/** 起平台侧车道（真实 express，不启服务器：用 listen(0) 拿端口）。 */
async function withLane({ env = ON, resolveUpstream, verifyCaller = verifyOk, log, timeouts = {} }, fn) {
  const app = express();
  const mounted = registerLineProxy(app, { verifyCaller, resolveUpstream, env, log, ...timeouts });
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn(base, mounted);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test("端到端：sk- 调通，上游只看到线票（客户钥匙不出边缘）", async () => {
  await withUpstream(
    (_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true }));
    },
    async (upstream) => {
      const lines = [];
      await withLane(
        { resolveUpstream: () => upstream, log: (e) => lines.push(e) },
        async (base, mounted) => {
          assert.equal(mounted, 2);
          const res = await fetch(`${base}/api/lines/wire/proxy/mcp`, {
            method: "POST",
            headers: { authorization: "Bearer sk-good", "content-type": "application/json" },
            body: "{}",
          });
          assert.equal(res.status, 200);
          assert.equal(res.headers.get("x-fd-line"), "wire");
          assert.deepEqual(await res.json(), { ok: true });
          const hit = lines.at(-1);
          assert.equal(hit.outcome, "ok");
          assert.equal(hit.via, "exchanged");
          assert.ok(!JSON.stringify(lines).includes("sk-good"), "日志里不能出现客户钥匙");
        },
      );
    },
  );
});

test("端到端：上游拿到的 Authorization 是线票而不是 sk-，且没有 X-Authorization", async () => {
  await withUpstream(
    (_req, res) => res.end("{}"),
    async (upstream, seen) => {
      await withLane({ resolveUpstream: () => upstream }, async (base) => {
        const res = await fetch(`${base}/api/lines/wire/proxy/mcp`, {
          method: "POST",
          headers: { authorization: "Bearer sk-good", "content-type": "application/json" },
          body: "{}",
        });
        assert.equal(res.status, 200);
      });
      const auth = seen[0].headers.authorization ?? "";
      assert.ok(auth.startsWith("Bearer ey"), "上游应收到线票（JWT），实际：" + auth.slice(0, 18));
      assert.ok(!auth.includes("sk-good"), "客户钥匙不得出现在上游请求头");
      assert.equal(seen[0].headers["x-authorization"], undefined, "不得借用 X-Authorization（那是调用方身份通道）");
    },
  );
});

test("端到端：缺上游地址 ⇒ 503 upstream_unresolved，上游零请求", async () => {
  await withUpstream(
    (_req, res) => res.end("{}"),
    async (_upstream, seen) => {
      await withLane({ resolveUpstream: () => null }, async (base) => {
        const res = await fetch(`${base}/api/lines/wire/proxy/mcp`, {
          method: "POST",
          headers: { authorization: "Bearer sk-good", "content-type": "application/json" },
          body: "{}",
        });
        assert.equal(res.status, 503);
        assert.deepEqual(await res.json(), { error: "upstream_unresolved" });
      });
      assert.equal(seen.length, 0, "缺地址时一个请求都不该打到上游");
    },
  );
});

test("端到端：未开通的线走不到车道（落到 app 兜底，不是本车道原因码）", async () => {
  const app = express();
  registerLineProxy(app, { verifyCaller: verifyOk, resolveUpstream: () => "http://127.0.0.1:1", env: ON });
  app.use((_req, res) => res.status(401).json({ error: "Authentication required" }));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await fetch(`${base}/api/lines/facet/proxy/mcp`, {
      method: "POST",
      headers: { authorization: "Bearer sk-good" },
    });
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: "Authentication required" });
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test("端到端：SSE 逐块透传，不是缓冲后一次性返回", async () => {
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  await withUpstream(
    async (_req, res) => {
      res.setHeader("content-type", "text/event-stream");
      res.write("data: first\n\n");
      await gate; // 卡住第二块，直到客户端收到第一块
      res.write("data: second\n\n");
      res.end();
    },
    async (upstream) => {
      await withLane({ resolveUpstream: () => upstream }, async (base) => {
        const res = await fetch(`${base}/api/lines/wire/proxy/mcp`, {
          method: "POST",
          headers: { authorization: "Bearer sk-good" },
          body: "{}",
        });
        assert.equal(res.status, 200);
        assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
        const reader = res.body.getReader();
        const first = await reader.read();
        const text1 = Buffer.from(first.value ?? []).toString();
        assert.match(text1, /data: first/, "第一块必须在第二块产生之前就到达（流式）");
        release();
        let rest = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          rest += Buffer.from(value).toString();
        }
        assert.match(rest, /data: second/);
      });
    },
  );
});

// ── 3b. MCP 会话协议头（任务 3.1 / 3.2）───────────────────────────────────
//
// 这两条是 2026-11-15 线上缺陷的回归锚点：车道在上行与下行两个方向都丢了
// `mcp-session-id`，而车道自己照样 `200 + x-fd-line`、`x-init` 也正常回，
// 读起来完全健康——客户端的形状却是「initialize 200，之后每个请求 400
// Missing session ID」。所以断言必须落在「头真的过来了」上，不能落在状态码上。

test("端到端：下行回抄 mcp-session-id / 协议版本，但不回抄未列名的头", async () => {
  await withUpstream(
    (_req, res) => {
      res.setHeader("content-type", "application/json");
      res.setHeader("mcp-session-id", "sess-abc123");
      res.setHeader("mcp-protocol-version", "2025-06-18");
      res.setHeader("set-cookie", "upstream=hidden; Path=/");
      res.end(JSON.stringify({ ok: true }));
    },
    async (upstream) => {
      await withLane({ resolveUpstream: () => upstream }, async (base) => {
        const res = await fetch(`${base}/api/lines/wire/proxy/mcp`, {
          method: "POST",
          headers: { authorization: "Bearer sk-good", "content-type": "application/json" },
          body: "{}",
        });
        assert.equal(res.status, 200);
        assert.equal(
          res.headers.get("mcp-session-id"),
          "sess-abc123",
          "会话 id 必须回到调用方，否则第二个请求起全 400",
        );
        assert.equal(res.headers.get("mcp-protocol-version"), "2025-06-18");
        assert.equal(res.headers.get("x-fd-line"), "wire", "协议头不能挤掉车道自己的标记");
        assert.equal(res.headers.get("set-cookie"), null, "未列名的头不得回抄（白名单不是透传）");
      });
    },
  );
});

test("端到端：上行转发会话头，但 cookie / x-forwarded-email 到不了上游", async () => {
  await withUpstream(
    (_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end("{}");
    },
    async (upstream, seen) => {
      await withLane({ resolveUpstream: () => upstream }, async (base) => {
        const res = await fetch(`${base}/api/lines/wire/proxy/mcp`, {
          method: "POST",
          headers: {
            authorization: "Bearer sk-good",
            "content-type": "application/json",
            "mcp-session-id": "sess-abc123",
            "mcp-protocol-version": "2025-06-18",
            "last-event-id": "evt-7",
            cookie: "platform=secret",
            "x-forwarded-email": "someone@example.com",
          },
          body: "{}",
        });
        assert.equal(res.status, 200);
      });
      const h = seen[0].headers;
      assert.equal(h["mcp-session-id"], "sess-abc123", "后续请求的会话 id 必须到上游，否则上游只会 400");
      assert.equal(h["mcp-protocol-version"], "2025-06-18");
      assert.equal(h["last-event-id"], "evt-7", "SSE 断点续传要靠它");
      assert.equal(h.cookie, undefined, "调用方 Cookie 不得带到上游");
      assert.equal(h["x-forwarded-email"], undefined, "网关身份头不得带到上游");
      assert.ok((h.authorization ?? "").startsWith("Bearer ey"), "上游只该看到线票，不是客户 sk-");
    },
  );
});

test("端到端：SSE 也在推流前下发会话头，且流式分支留 ok 日志", async () => {
  await withUpstream(
    (_req, res) => {
      res.setHeader("content-type", "text/event-stream");
      res.setHeader("mcp-session-id", "sess-sse");
      res.write("data: hello\n\n");
      setTimeout(() => res.end(), 20);
    },
    async (upstream) => {
      const lines = [];
      await withLane({ resolveUpstream: () => upstream, log: (e) => lines.push(e) }, async (base) => {
        const res = await fetch(`${base}/api/lines/wire/proxy/mcp`, {
          method: "POST",
          headers: { authorization: "Bearer sk-good", accept: "text/event-stream" },
          body: "{}",
        });
        assert.equal(res.status, 200);
        assert.equal(
          res.headers.get("mcp-session-id"),
          "sess-sse",
          "会话头必须在事件体开始推送前就下发，否则首帧到达时客户端还不知道该带哪个 session",
        );
        assert.match(await res.text(), /data: hello/);
      });
      await new Promise((r) => setTimeout(r, 20)); // 等 finally 里的日志落地
      const hit = lines.at(-1);
      assert.equal(hit?.outcome, "ok", "流式分支也要留成功行，否则「流跑完」与「请求没进来」在日志里同形");
      assert.equal(hit?.sse, true);
    },
  );
});

test("端到端：上游超时 ⇒ 504 且带 x-fd-line", async () => {
  await withUpstream(
    () => {}, // 永不响应
    async (upstream) => {
      await withLane({ resolveUpstream: () => upstream, timeouts: { firstByteTimeoutMs: 120 } }, async (base) => {
        const res = await fetch(`${base}/api/lines/wire/proxy/mcp`, {
          method: "POST",
          headers: { authorization: "Bearer sk-good" },
          body: "{}",
        });
        assert.equal(res.status, 504);
        assert.equal(res.headers.get("x-fd-line"), "wire");
        assert.deepEqual(await res.json(), { error: "upstream_timeout" });
      });
    },
  );
});

test("端到端：坏钥匙 401 且上游零请求（失败不落到上游身上）", async () => {
  await withUpstream(
    (_req, res) => res.end("{}"),
    async (upstream, seen) => {
      await withLane({ resolveUpstream: () => upstream }, async (base) => {
        const res = await fetch(`${base}/api/lines/wire/proxy/mcp`, {
          method: "POST",
          headers: { authorization: "Bearer sk-bad" },
          body: "{}",
        });
        assert.equal(res.status, 401);
        assert.deepEqual(await res.json(), { error: "invalid_key" });
      });
      assert.equal(seen.length, 0);
    },
  );
});

// ── 4. 上游地址只从清单读（任务 2.4 / 接线不靠猜）────────────────────────────

test("清单解析：地址按线取，短名归一化，没声明的线是 null（不是空串、不是抛错）", () => {
  const loadManifests = () => ({
    lines: new Map([
      ["wire", { line: "wire", internalBaseUrl: "http://wire-build.fd-prod.svc:8080" }],
      ["lex", { line: "lex", internalBaseUrl: null }],
    ]),
    unreadable: [],
  });
  const resolve = manifestUpstreamResolver({ rootDir: "/x", loadManifests });
  assert.equal(resolve("wire"), "http://wire-build.fd-prod.svc:8080");
  assert.equal(resolve("WIRE"), "http://wire-build.fd-prod.svc:8080", "线名大小写不该改变结论");
  assert.equal(resolve("lex"), null, "声明了但没有地址 ⇒ null（不是空串）");
  assert.equal(resolve("erp"), null, "清单里没有这条线 ⇒ null");
});

test("清单解析：TTL 内不重复扫目录，过期后重读（热挂载要能被看见）", () => {
  let scans = 0;
  let wireBase = "http://a";
  const loadManifests = () => {
    scans += 1;
    return { lines: new Map([["wire", { line: "wire", internalBaseUrl: wireBase }]]), unreadable: [] };
  };
  let clock = 1_000_000;
  const resolve = manifestUpstreamResolver({ rootDir: "/x", loadManifests, ttlMs: 60_000, now: () => clock });

  assert.equal(resolve("wire"), "http://a");
  assert.equal(scans, 1);
  resolve("wire");
  resolve("wire");
  assert.equal(scans, 1, "TTL 内不该重复扫");

  // 清单改了（ConfigMap 热替换），但没到 TTL ⇒ 仍是旧值；过 TTL 才换。
  wireBase = "http://b";
  clock += 30_000;
  assert.equal(resolve("wire"), "http://a");
  clock += 31_000;
  assert.equal(resolve("wire"), "http://b", "过了 TTL 必须读到新地址，否则热挂载白挂");
  assert.equal(scans, 2);
});

test("清单解析：读不出来 ⇒ null，且下一个 tick 就重试（别把一次读失败冻住一分钟）", () => {
  let calls = 0;
  let broken = true;
  const loadManifests = () => {
    calls += 1;
    if (broken) throw new Error("EIO");
    return { lines: new Map([["wire", { line: "wire", internalBaseUrl: "http://ok" }]]), unreadable: [] };
  };
  let clock = 0;
  const resolve = manifestUpstreamResolver({ rootDir: "/x", loadManifests, ttlMs: 60_000, now: () => clock });
  assert.equal(resolve("wire"), null, "读失败必须是 null（fail closed 到 503），不是抛错");
  broken = false;
  clock += 2_000;
  assert.equal(resolve("wire"), "http://ok", "读失败后应尽早重试，而不是等满一个 TTL");
  assert.equal(calls, 2);
});

// ── 5. 两条入口共用同一份判定（任务 2.1 的接线断言）──────────────────────────

test("接线：换票路由与转发车道传的是同一个 verifyCaller（不许各写一份）", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../gateway/index.js", import.meta.url), "utf8");

  // ① 只有一处 createSub2apiClient() 承载线钥匙判定（第二处=两套解析已经开始漂）。
  const clients = src.match(/createSub2apiClient\(\)/g) ?? [];
  assert.equal(clients.length, 1, `gateway/index.js 里 createSub2apiClient() 应只出现 1 次，实际 ${clients.length}`);

  // ② 两处接线写的是同一个具名函数，而不是各自一个内联箭头函数。
  assert.match(src, /registerLineExchange\(app,\s*\{\s*verifyCaller:\s*verifyLineCaller\s*\}\)/);
  assert.match(src, /registerLineProxy\(app,\s*\{[^}]*verifyCaller:\s*verifyLineCaller/);

  // ③ 车道在 dispatchToCell 兜底之前挂上（兜底要会话身份，车道恰恰没有）。
  //    锚点取**调用点**而不是函数定义（`async function dispatchToCell(...)` 在更上面，
  //    拿名字做锚会把定义当成挂载点，断言就永远为假——第一版就是这么红的）。
  const proxyAt = src.indexOf("registerLineProxy(app");
  const fallbackAt = src.indexOf("if (!user) return rejectUnauthenticated(req, res);\n  dispatchToCell(req, res, user);");
  assert.ok(proxyAt > 0, "找不到车道挂载点");
  assert.ok(fallbackAt > 0, "找不到 dispatchToCell 兜底挂载点");
  assert.ok(proxyAt < fallbackAt, "车道必须挂在兜底之前");
});

test("计费面不可达不得改动凭据状态：验证路径里没有任何写操作（任务 3.2）", async () => {
  // 原文写的是"不得触发 markInvalid"，而这个客户端**根本没有** markInvalid
  // （lib/sub2api-admin.js 只有 probeKeyLiveness / findUserByKey / adjustBalance…），
  // 照原文写断言就是断言一个不存在的对象——永远绿，等于没验。
  //
  // 可判的形态：把 `verifyLineCaller` 的函数体切出来，断言里面**没有任何写**。
  // 客户端确实有写面（`adjustBalance` 是 POST），所以这条是实打实能红的：
  // 谁哪天在验证路径里加一句"顺手扣一下余额/标一下失效"，这里立刻红。
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../gateway/index.js", import.meta.url), "utf8");
  const start = src.indexOf("const verifyLineCaller = async (key) => {");
  const end = src.indexOf("registerLineExchange(app, { verifyCaller: verifyLineCaller })");
  assert.ok(start > 0 && end > start, "切不出 verifyLineCaller 的函数体");
  const body = src.slice(start, end);

  for (const forbidden of ["adjustBalance", "markInvalid", "method: \"POST\"", "method: 'POST'"]) {
    assert.ok(!body.includes(forbidden), `验证路径里出现了写操作：${forbidden}`);
  }
  // 正面判据：它确实调了那两份只读解析（否则上面那几条会因函数体为空而空转）。
  assert.match(body, /probeKeyLiveness\(/, "验证路径应做探活");
  assert.match(body, /findUserByKey\(/, "验证路径应解析钥匙归属");
});
