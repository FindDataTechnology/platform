// ── 按请求换票并转发（change gateway-line-key-exchange）
//
// 要解决的问题：19 条产品线里只有 4 条有自己的公开域名，另外 15 条只挂在共享 MCP
// 网关路径（`mcp.finddatatech.cloud/<prefix>`）下，而那道网关**按设计剥掉调用方
// Authorization**、用注册表里的凭据覆盖。于是客户手里那把词元 `sk-` 对这 15 条线
// 买不到任何东西：他能换到线票，却没有一条通路把线票送到线上去。
//
// 既有那条"把调用方凭据送到上游"的中继车道装不下短命票，两个原因都不是配置问题：
//   ① `X-Authorization` 在 mcpgw 的 `/validate` 里是**调用方身份**通道，非 IdP 签发的
//      不透明令牌进去直接 401（`mcp-gateway-shared-token-relay` 已明文禁止）；
//   ② 平台侧放进 `X-Authorization` 的是用户库里那份凭据**本身**，写 profile 时就固定，
//      而线票 ≤600 秒——静态 profile 装不下会过期的票。
//
// 所以这条车道放在**我们自己的**平台网关里：钥匙、签发私钥、线侧信任关系都在这一套栈，
// 不需要让第三方相信我们签的票；路径 `/api/lines/<line>/*` 与共享网关的
// `/<prefix>` 不重叠，老消费方零影响。
//
// 四条刻意的选择：
//   1. **关闭 = 路由不存在**（与 7.1 同一口径）：只为 `LINE_EXCHANGE_LINES` 里的线挂
//      路由；未开通的线打同一路径会落到网关的身份兜底（未登录 401
//      `Authentication required`），而不是本车道的任何原因码。
//   2. **判定复用 `decideLineExchange()`**，不另写一套"验钥匙"。同一把钥匙在同一平台
//      有两条入口，判定必须同源——分开写迟早出现"换票说无效、转发说有效"。
//   3. **目标地址只从 manifest 读**（注入 `resolveUpstream`），网关里没有 线→地址 的表；
//      缺地址 = 503 `upstream_unresolved`（fail closed，绝不猜）。
//   4. **钥匙不出边缘**：上游只看到刚签的线票；`sk-` 不进任何上游请求头、不进日志、
//      不进响应。已持有合法线票（`aud`/`source` = 目标线）的调用方**直通**，不再换票
//      ——既省一次计费面往返，也让"先换票再调"与"一次调用"两种用法都成立。
//
// 有意不做：不缓存钥匙、不缓存自己签出的票（缓存钥匙=多一个泄漏面；缓存票会让
// "短命"变成一句空话）；不做跨线聚合。

import { createPublicKey } from "node:crypto";
import { decideLineExchange, enabledLines, lineSigningKey, verifyLineToken, LINE_EXCHANGE_PATH_PREFIX } from "./line-token-exchange.js";

/** 车道的子路径前缀：线自己的 `/mcp`（或任意路径）拼在这后面。 */
export const LINE_PROXY_SUFFIX = "/proxy";

//: MCP streamable-http 的会话握手头，**双向都要过**。缺任何一个方向，客户端的形状就是
//: 「initialize 200、之后每个请求 400 Missing session ID」——而车道自己看起来一切正常
//: （200 + x-fd-line + 完整 initialize 结果），所以这条缺陷一直是静默的。
//: 2026-11-15 实证：同一枚票直连 wire ClusterIP 的 initialize 带 `mcp-session-id`，
//: 经车道就没了；`tools/call` 随即 400。
//:
//: 刻意是**白名单**而不是整体透传：调用方的 `cookie`、`x-forwarded-*`、网关身份头都不能
//: 被带到上游（上游只该看到「这条线的票 + 这条请求的正文」）。协议头是自描述的短字符串
//: （session id / 协议版本 / 事件 id），不含凭据，且不认它们的上游会直接忽略。
export const LINE_PROXY_REQUEST_HEADERS = ["mcp-session-id", "mcp-protocol-version", "last-event-id"];
export const LINE_PROXY_RESPONSE_HEADERS = ["mcp-session-id", "mcp-protocol-version"];

//: 单次上游调用的两段超时。学 `lib/http.js` 的 `guardBodyDeadline` 那条教训：
//: 只在"拿到响应头"时清超时，会让半开的响应体永久挂住——所以首字节与空闲分开算。
const DEFAULT_FIRST_BYTE_TIMEOUT_MS = 15_000;
const DEFAULT_IDLE_TIMEOUT_MS = 60_000;

//: kid → 公钥 KeyObject。`lineSigningKey()` 只回私钥，验线票需要公钥；每请求派生一次
//: 是多余的 EC 标量乘，故按 kid 缓存（键不含私钥明文，值只在进程内存里）。
const publicKeyCache = new Map();

function publicKeyFor(line, env) {
  const material = lineSigningKey(line, env);
  if (!material?.privateKey) return null;
  const cacheKey = `${line}:${material.kid}:${material.privateKey.length}`;
  if (publicKeyCache.has(cacheKey)) return publicKeyCache.get(cacheKey);
  let key = null;
  try {
    key = createPublicKey(material.privateKey);
  } catch {
    key = null;
  }
  publicKeyCache.set(cacheKey, key);
  return key;
}

function bearerOf(value) {
  return String(value ?? "").replace(/^Bearer\s+/i, "").trim();
}

/**
 * 判定一枚调用方凭据能不能用在这条线上：先当线票试（离线验签、零网络），再当
 * `sk-` 换票。返回 `{ ok, token }` 或 `{ ok:false, status, error }`。
 *
 * 顺序刻意如此：线票验签是纯本地运算，比问计费面便宜三个数量级；而"客户已经换过票
 * 再来调"是最常见的一种用法。
 */
export async function resolveLineCredential({
  line,
  authorization,
  env = process.env,
  verifyCaller,
  now = Date.now(),
} = {}) {
  const name = String(line ?? "").trim().toLowerCase();
  const presented = bearerOf(authorization);
  if (!presented) return { ok: false, status: 401, error: "missing_credential" };

  // ① 已经是本线的线票？直通（跨线票会在这里被 verifyLineToken 按 aud/source 拒掉）。
  const material = lineSigningKey(name, env);
  const publicKey = material ? publicKeyFor(name, env) : null;
  if (publicKey) {
    const verdict = verifyLineToken(presented, { publicKey, line: name, now });
    if (verdict.ok) return { ok: true, token: presented, via: "line-token" };
    // 长得像 JWT（三段）却验不过：直接拒，别退回换票——否则一枚别线的合法票会被
    // 拿去当 `sk-` 问计费面，得到一个"钥匙无效"的错答案。
    if (presented.split(".").length === 3) {
      return { ok: false, status: 401, error: verdict.reason || "invalid_credential" };
    }
  } else if (!material) {
    // 没配签发钥 = 这条线开不了（配置缺失，运维可修），与 7.1 同一档。
    return { ok: false, status: 503, error: "line_signing_key_missing" };
  }

  // ② 当 `sk-` 换一张新票：复用换票路由的同一份判定（含三态：503 计费面不可达 /
  //    401 钥匙无效 / 404 未开通）。
  const verdict = await decideLineExchange({
    line: name,
    authorization: `Bearer ${presented}`,
    env,
    verifyCaller,
    now,
  });
  if (verdict.status !== 200) return { ok: false, status: verdict.status, error: verdict.error };
  return { ok: true, token: verdict.token, claims: verdict.claims, via: "exchanged" };
}

/**
 * 「线 → 内部上游基址」的解析器：目标地址只从 manifest 投影读。
 *
 * 为什么不放在 `registerLineProxy` 里：那样拍进去的就只能是"已经解析好的地址表"，
 * 而地址是**会变的**（清单热挂载 ≤60s 生效），且"读不到清单"必须与"清单里没有这条
 * 线"同样落到 503 而不是抛异常。所以做成一个带 TTL 的 getter，注入进去。
 *
 * @param {object} opts
 * @param {string|null} opts.rootDir   manifest 目录（`LINE_MANIFEST_DIR`）
 * @param {Function} opts.loadManifests  (dir) => {lines: Map, unreadable: []}
 * @param {number} [opts.ttlMs]  缓存时长，默认 60s（与 ConfigMap 热替换同量级）
 * @param {Function} [opts.now]
 * @returns {(line: string) => string|null}
 */
export function manifestUpstreamResolver({
  rootDir = null,
  loadManifests,
  ttlMs = 60_000,
  now = () => Date.now(),
} = {}) {
  let loadedAt = Number.NEGATIVE_INFINITY;
  let lines = new Map();
  return (line) => {
    const name = String(line ?? "").trim().toLowerCase();
    if (now() - loadedAt >= ttlMs) {
      loadedAt = now();
      try {
        lines = loadManifests?.(rootDir)?.lines ?? new Map();
      } catch {
        // 读不到 ≠ 清单里没有：两种都在网关侧落 503，但别让一次读失败把缓存冻住到
        // 下一个 TTL 之后——这里只缩短本次结果的生命周期（下一个 tick 重试）。
        lines = new Map();
        loadedAt = now() - ttlMs + 1_000;
      }
    }
    return lines.get(name)?.internalBaseUrl ?? null;
  };
}

/**
 * 接线：为每条已开通的线挂一个 `/api/lines/<line>/proxy/*` 的转发口。
 *
 * @param {import("express").Express} app
 * @param {object} opts
 * @param {Function} opts.verifyCaller  async (key) => {ok, userId, email, reason, status}
 * @param {Function} opts.resolveUpstream (line) => string|null   内部上游基址（来自 manifest 投影）
 * @param {object} [opts.env]
 * @param {Function} [opts.now]
 * @param {Function} [opts.fetchImpl]
 * @returns {number} 挂上的路由数（0 = 完全没有新出口）
 */
export function registerLineProxy(
  app,
  {
    verifyCaller,
    resolveUpstream,
    env = process.env,
    now = () => Date.now(),
    fetchImpl = globalThis.fetch,
    firstByteTimeoutMs = DEFAULT_FIRST_BYTE_TIMEOUT_MS,
    idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
    log = () => {},
  } = {},
) {
  // 名单与换票路由**同源**：直接调 7.1 的 `enabledLines()`（它同时管着
  // `LINE_EXCHANGE_ENABLED` 总开关），不在这里再解析一遍 env。少写一处解析就少一处
  // "开了换票却没开转发"的可能。
  const enabled = enabledLines(env).filter((line) => lineSigningKey(line, env));
  if (!enabled.length) return 0;

  let mounted = 0;
  for (const line of enabled) {
    const base = `${LINE_EXCHANGE_PATH_PREFIX}/${line}/proxy`;
    // 用 app.use 而不是 app.all(`${base}/*`)：前者同时覆盖 `/proxy`（无子路径，转上游根）
    // 与 `/proxy/mcp`，且按路径段边界匹配（`/proxyX` 不会误命中）；后者在 express 4 上
    // 漏掉裸路径那一档。每线只挂一条，挂载数才好数。
    app.use(base, async (req, res) => {
      const started = Date.now();
      const credential = await resolveLineCredential({
        line,
        authorization: req.headers?.authorization,
        env,
        verifyCaller,
        now: now(),
      });
      if (!credential.ok) {
        // 失败不落到上游身上：这里直接结束，并把原因码原样给出（三态彼此不同形）。
        log({ line, outcome: credential.error, status: credential.status, ms: Date.now() - started });
        return res.status(credential.status).json({ error: credential.error });
      }

      const upstream = resolveUpstream?.(line) ?? null;
      if (!upstream) {
        // 缺地址 = 清单没声明（或声明坏了）。fail closed，绝不回落到猜出来的地址。
        log({ line, outcome: "upstream_unresolved", status: 503, ms: Date.now() - started });
        return res.status(503).json({ error: "upstream_unresolved" });
      }

      const target = `${upstream}${req.originalUrl.slice(base.length) || "/"}`;
      const controller = new AbortController();
      const firstByte = setTimeout(() => controller.abort(), firstByteTimeoutMs);
      // 协议头按白名单透传（会话握手靠它们）；其余调用方头一律不带。
      const protocolHeaders = {};
      for (const name of LINE_PROXY_REQUEST_HEADERS) {
        const value = req.headers?.[name];
        if (value) protocolHeaders[name] = value;
      }
      try {
        const upstreamRes = await fetchImpl(target, {
          method: req.method,
          headers: {
            // 只钉这几个头：把调用方的头整体透传会把 Cookie/网关身份一起带到上游。
            "content-type": req.headers?.["content-type"] ?? "application/json",
            accept: req.headers?.accept ?? "application/json, text/event-stream",
            authorization: `Bearer ${credential.token}`,
            ...protocolHeaders,
          },
          body: ["GET", "HEAD"].includes(req.method) ? undefined : await readBody(req),
          signal: controller.signal,
          // 直连内部地址：不经代理（否则会绕回出口代理）。
          redirect: "manual",
        });
        clearTimeout(firstByte);

        res.status(upstreamRes.status);
        res.setHeader("x-fd-line", line);
        const ctype = upstreamRes.headers.get("content-type") ?? "application/json";
        res.setHeader("content-type", ctype);
        // 会话头必须在开始推事件体之前下发，否则客户端拿到第一帧时还不知道该带哪个 session。
        for (const name of LINE_PROXY_RESPONSE_HEADERS) {
          const value = upstreamRes.headers.get(name);
          if (value) res.setHeader(name, value);
        }

        // SSE / 流式：直接管道，绝不缓冲（MCP 的 streamable http 会挂长连接）。
        if (!upstreamRes.body || /text\/event-stream/i.test(ctype)) {
          if (upstreamRes.body) {
            const reader = upstreamRes.body.getReader();
            const pump = async () => {
              let idle = setTimeout(() => controller.abort(), idleTimeoutMs);
              try {
                for (;;) {
                  const { done, value } = await reader.read();
                  if (done) break;
                  clearTimeout(idle);
                  idle = setTimeout(() => controller.abort(), idleTimeoutMs);
                  res.write(Buffer.from(value));
                }
              } finally {
                clearTimeout(idle);
                res.end();
                // 流式也要留成功行：否则「流跑完了」与「请求压根没进来」在日志里同形。
                log({ line, outcome: "ok", status: upstreamRes.status, via: credential.via, sse: true, ms: Date.now() - started });
              }
            };
            return await pump();
          }
          return res.end();
        }
        const text = await upstreamRes.text();
        log({ line, outcome: "ok", status: upstreamRes.status, via: credential.via, ms: Date.now() - started });
        return res.send(text);
      } catch (err) {
        const aborted = err?.name === "AbortError";
        log({ line, outcome: aborted ? "upstream_timeout" : "upstream_error", ms: Date.now() - started });
        if (!res.headersSent) {
          res.setHeader("x-fd-line", line);
          return res.status(aborted ? 504 : 502).json({ error: aborted ? "upstream_timeout" : "upstream_error" });
        }
        return res.end();
      } finally {
        clearTimeout(firstByte);
      }
    });
    mounted += 1;
  }
  return mounted;
}

/** 读请求体（限 8 MB：MCP 的 JSON-RPC 报文没有这么大的）。 */
function readBody(req, limitBytes = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(Object.assign(new Error("request body too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
