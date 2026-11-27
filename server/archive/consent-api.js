// ── 同意状态：官方 HTTP 接口（任务 3.1c）───────────────────────────────────
//
// 会话存档的同意有两级粒度，官方给的是两个不同接口：
//
//   单聊  POST/GET /cgi-bin/msgaudit/check_single_agree  {info:[{userid, exteranalopenid}]}
//   群聊  POST/GET /cgi-bin/msgaudit/check_room_agree    {info:[{roomid, userid, exteranalopenid}]}
//
// 两者都回 `{"errcode":0,"agree_status":"Agree"|"Disagree","status_change_time":N}`。
//
// 三个必须在这里钉住的事：
//
// 1. **判不出该查哪个接口时，不发请求、不猜**。我们库里的 `conversation_id` 有两种形状：
//    群是 `roomid`，单聊是 `dm:<A>:<B>`（两端排序拼接，guarantee 两侧视角同一个键）。
//    官方接口要的是「企业成员 userid + 外部联系人 openid」这一对角色，而 `dm:` 只给了两个值。
//    角色靠 `ARCHIVE_SEAT_SCOPE`（被存档成员）反查；查不出来（两端都不是我方成员、或两端都是）
//    就返回 unknown——`admitByConsent` 会把 unknown 当未同意，等于**少存但不越权**。
//    这里不能"随便挑一个当 userid"：挑错方向官方会回 Disagree，而我们会把它当真的不同意。
//
// 2. **令牌与 secret 不得出现在任何错误正文里**。官方 `errmsg` 会回显请求串，所以擦除
//    是主动动作，不是"应该不会"。
//
// 3. **查询失败不等于不同意**，但结果同样是"不入库"。这个区别必须能被看见，否则
//    "同意接口坏了"会表现为"客户的会话全被丢弃"，而且看起来像客户自己选的。
//    所以 resolver 把失败计数与最后一条错误留在 `stats()` 里，由 CLI/巡检打印。
//
// 与 kf 的 `createKfClient` 不共用：两边的 secret 是**两种不同类型**的凭据（客服应用 vs
// 会话存档），错误码体系也不同；共用会把「哪个 secret 不对」这类问题混在一起。

import { WhiteIpMismatchError } from "./sdk.js";
import { redactSecrets } from "./sdk.js";
import { normalizeAgreeStatus } from "./consent.js";
import { lastConsentEventAt, upsertConversation } from "./store.js";

export const DEFAULT_BASE_URL = "https://qyapi.weixin.qq.com";
export const PATH_SINGLE = "/cgi-bin/msgaudit/check_single_agree";
export const PATH_ROOM = "/cgi-bin/msgaudit/check_room_agree";

const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 10_000;
// 与 kf 那边同一个码：出口 IP 不在「企业可信IP」。消息里点明名字，别让人去查 secret。
const WHITE_IP_CODE = 301042;

export class ConsentApiError extends Error {
  constructor({ errcode, errmsg, op }) {
    super(`${op} 失败：errcode=${errcode} ${errmsg || ""}`.trim());
    this.name = "ConsentApiError";
    this.errcode = Number(errcode);
    this.errmsg = errmsg || "";
    this.op = op;
  }
}

export class ConsentConfigError extends ConsentApiError {
  constructor(args) {
    super(args);
    this.name = "ConsentConfigError";
  }
}

/**
 * 判不出该查哪个接口。**这不是错误，是"我们没有信息"**：不猜、不发请求。
 * 单独成类是为了让 CLI 能把它和"接口坏了"分开报——两者的处置完全不同。
 */
export class ConsentIndeterminateError extends Error {
  constructor(reason, detail = {}) {
    super(`无法确定该查哪种同意（${reason}）`);
    this.name = "ConsentIndeterminateError";
    this.reason = reason;
    this.detail = detail;
  }
}

/**
 * 把 `conversation_id` 翻成官方接口要的参数。
 *
 * @returns {{kind:"room", roomId:string}|{kind:"single", userId:string, openId:string}}
 * @throws {ConsentIndeterminateError}
 */
export function resolveAgreeQuery(conversationId, { seatScope = [] } = {}) {
  const id = String(conversationId ?? "");
  if (!id) throw new ConsentIndeterminateError("empty_conversation_id");

  if (!id.startsWith("dm:")) {
    // 群聊：官方直接按 roomid 查。
    return { kind: "room", roomId: id };
  }

  const parts = id.slice(3).split(":").filter(Boolean);
  if (parts.length !== 2) {
    throw new ConsentIndeterminateError("dm_not_a_pair", { conversationId: id });
  }
  const seats = new Set((seatScope || []).map(String));
  const mine = parts.filter((p) => seats.has(p));
  if (mine.length === 1) {
    return { kind: "single", userId: mine[0], openId: parts.find((p) => p !== mine[0]) };
  }
  // 两端都不是我方成员（可能是内部同事互聊，也可能是席位范围没配全）；
  // 两端都是我方才（内部会话根本不需要外部同意）——两种都不知道该问谁，不猜。
  throw new ConsentIndeterminateError(mine.length === 0 ? "no_seat_in_pair" : "both_sides_are_seats", {
    conversationId: id,
    seatScopeSize: seats.size,
  });
}

/**
 * 客户端。`fetchImpl` 必须可注入：没有真凭据时测试也要能覆盖全部分支。
 */
export function createAgreeClient({
  fetchImpl = globalThis.fetch,
  corpId = "",
  secret = "",
  baseUrl = DEFAULT_BASE_URL,
  now = () => Date.now(),
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (typeof fetchImpl !== "function") throw new Error("createAgreeClient 需要可用的 fetch");

  let cache = { token: "", expiresAt: 0 };
  const secrets = () => [secret, cache.token];

  async function callJson({ op, path, query = {}, body }) {
    const url = new URL(path, baseUrl);
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    }
    const init = { method: "POST", headers: { "content-type": "application/json" } };
    if (body !== undefined) init.body = JSON.stringify(body);
    if (timeoutMs > 0 && typeof AbortSignal?.timeout === "function") {
      init.signal = AbortSignal.timeout(timeoutMs);
    }

    let resp;
    try {
      resp = await fetchImpl(url.toString(), init);
    } catch (err) {
      throw new ConsentApiError({
        errcode: -1,
        errmsg: redactSecrets(`网络失败：${err?.message || err}`, secrets()),
        op,
      });
    }
    if (!resp || typeof resp.json !== "function") {
      throw new ConsentApiError({ errcode: -2, errmsg: "响应不可解析", op });
    }
    let data;
    try {
      data = await resp.json();
    } catch {
      throw new ConsentApiError({
        errcode: -3,
        errmsg: `响应不是 JSON（HTTP ${resp.status ?? "?"}）`,
        op,
      });
    }
    const errcode = Number(data?.errcode ?? 0);
    if (errcode !== 0) {
      const errmsg = redactSecrets(data?.errmsg, secrets());
      if (errcode === WHITE_IP_CODE) throw new WhiteIpMismatchError({ errcode, errmsg, op });
      throw new ConsentApiError({ errcode, errmsg, op });
    }
    return data;
  }

  async function fetchToken() {
    if (!corpId) throw new ConsentConfigError({ errcode: 40013, errmsg: "未配置 corpid", op: "gettoken" });
    if (!secret) throw new ConsentConfigError({ errcode: 40001, errmsg: "未配置 secret", op: "gettoken" });
    const data = await callJson({
      op: "gettoken",
      path: "/cgi-bin/gettoken",
      query: { corpid: corpId, corpsecret: secret },
    });
    const expiresIn = Number(data.expires_in || 7200);
    cache = {
      token: String(data.access_token || ""),
      expiresAt: now() + Math.max(0, expiresIn * 1000 - TOKEN_REFRESH_MARGIN_MS),
    };
    if (!cache.token) {
      throw new ConsentApiError({ errcode: -4, errmsg: "gettoken 未返回 access_token", op: "gettoken" });
    }
    return cache.token;
  }

  async function token({ force = false } = {}) {
    if (!force && cache.token && now() < cache.expiresAt) return cache.token;
    return fetchToken();
  }

  /** 官方两个接口的回包形状一致，归一化收在一处。 */
  function normalizeReply(data, op) {
    const raw = data?.agree_status;
    return {
      status: normalizeAgreeStatus(raw),
      raw: raw === undefined ? null : String(raw),
      // 状态变更时间：官方只在"变过"时给。别拿 now 冒充它——那是我们自己看到的时间。
      statusChangeTime: Number(data?.status_change_time || 0),
      op,
    };
  }

  async function call(op, path, body) {
    const t = await token();
    const data = await callJson({ op, path, query: { access_token: t }, body });
    return normalizeReply(data, op);
  }

  return {
    tokenState() {
      return { cached: Boolean(cache.token) && now() < cache.expiresAt, expiresAt: cache.expiresAt };
    },
    /** 单聊：企业成员 + 外部联系人 openid。 */
    async checkSingleAgree({ userId, openId }) {
      return call("check_single_agree", PATH_SINGLE, {
        info: [{ userid: String(userId ?? ""), exteranalopenid: String(openId ?? "") }],
      });
    },
    /** 群聊：只要 roomid（官方允许附带 userid/openid，这里不带，免得造成"按成员判"的误解）。 */
    async checkRoomAgree({ roomId }) {
      return call("check_room_agree", PATH_ROOM, { info: [{ roomid: String(roomId ?? "") }] });
    },
    async agreeOf(query) {
      if (query?.kind === "room") return this.checkRoomAgree({ roomId: query.roomId });
      if (query?.kind === "single") {
        return this.checkSingleAgree({ userId: query.userId, openId: query.openId });
      }
      throw new ConsentIndeterminateError(query?.kind ? `unknown_kind_${query.kind}` : "no_query");
    },
  };
}

/**
 * 把客户端接成 `runPullCycle` 要的 `queryConsent(conversationId) => Promise<string>`。
 *
 * 两条取舍：
 *   - 查询失败返回 `"unknown"`（→ 不入库），**不抛**。抛出去会让整轮拉取挂在这个
 *     会话上，一条坏会话挡住所有会话；但失败会计数并留最后一条错误，供巡检看。
 *   - 明确状态才落库。`agree_state` 是"官方结论"，不是我们的观测结果。
 */
export function createConsentResolver({
  client,
  db,
  cache = null,
  seatScope = [],
  now = () => Date.now(),
} = {}) {
  if (!client) throw new Error("createConsentResolver 需要 client");
  const stats = {
    checks: 0,
    cached: 0,
    unknown: 0,
    errors: 0,
    indeterminate: 0,
    persisted: 0,
    lastError: null,
  };

  async function query(conversationId) {
    // 缓存命中前先看"有没有比缓存更新的同意变更"。回调通常落在另一个进程里
    // （网关），它清不到我们的内存缓存，只能留一条水位；这里必须比一次，
    // 否则"客户已撤回同意、我们还在写"会一直持续到 TTL 过期。
    const entry = cache?.getEntry
      ? cache.getEntry(conversationId)
      : cache?.get
        ? (() => {
            const status = cache.get(conversationId);
            return status ? { status, at: Number.POSITIVE_INFINITY } : null;
          })()
        : null;
    if (entry) {
      const eventAt = db ? lastConsentEventAt(db, conversationId) : 0;
      if (entry.at >= eventAt) {
        stats.cached += 1;
        return entry.status;
      }
      cache.invalidate?.(conversationId);
    }

    let q;
    try {
      q = resolveAgreeQuery(conversationId, { seatScope });
    } catch (err) {
      // 判不出问谁：不猜，按未同意处理，但要能看见。
      stats.indeterminate += 1;
      stats.lastError = { conversationId, name: err?.name, message: err?.message };
      return "unknown";
    }

    stats.checks += 1;
    let res;
    try {
      res = await client.agreeOf(q);
    } catch (err) {
      stats.errors += 1;
      stats.lastError = { conversationId, name: err?.name, message: err?.message };
      return "unknown";
    }

    if (res.status === "unknown") {
      stats.unknown += 1;
      return "unknown";
    }

    cache?.set(conversationId, res.status);
    if (db) {
      upsertConversation(db, {
        conversationId,
        kind: q.kind === "room" ? "group" : "single",
        agreeState: res.status,
        agreeAt: res.statusChangeTime || now(),
        updatedAt: now(),
      });
      stats.persisted += 1;
    }
    return res.status;
  }

  return {
    query,
    stats: () => ({ ...stats }),
    resetStats() {
      for (const k of Object.keys(stats)) {
        if (k === "lastError") stats[k] = null;
        else stats[k] = 0;
      }
    },
  };
}
