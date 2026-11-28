// ── 微信客服 API 客户端 ─────────────────────────────────────────────────────
//
// 三个"看起来该重试、其实重试更糟"的地方，先在这里一次处理掉：
//
// 1. **令牌只缓存、不落盘**。`access_token` 是 7200s 的短期凭据，写进 DB 就会进备份、
//    进日志、进导出，等于把企业级权限换个地方明文存着。
// 2. **刷新只做一次**。访问令牌失效（42001/40014/41001）刷新一次再试一次就够；
//    外层再套一层重试会把 1 次调用放大成 N 次，而每次都要先取一次令牌。
// 3. **凭据错误不重试**。`40001`/`40013`/`40056` 是 secret/corpid 不对，
//    重试一百次还是同一个结果，只会把错误信息里的时间戳搅乱。
//
// 另一个必须钉住的：**错误信息里不得出现 `access_token` 或 `secret`**。
// 官方 `errmsg` 有时会回显请求串，所以这里是主动擦除，不是"应该不会"。

export const DEFAULT_BASE_URL = "https://qyapi.weixin.qq.com";
export const MAX_SYNC_LIMIT = 1000;
export const MAX_CUSTOMER_BATCH = 100; // 官方 batchget 单次上限
export const MAX_TEXT_BYTES = 2048; // 官方 text.content 上限（按 UTF-8 字节）
// 运维护栏，不是官方上限：单个媒体超过它就有理由怀疑不是一份"客户发来的附件"。
export const MAX_MEDIA_BYTES = 64 * 1024 * 1024;

// ── 上行（发文件）的官方口径 ────────────────────────────────────────────────
// 出处：企业微信文档「微信客服 → 发送消息」(path/94677) 与「素材管理 → 上传临时素材」
// (path/90389)，2026-11-13 核对原文：
//   · 上传：POST /cgi-bin/media/upload?access_token=&type=file，multipart 字段名 `media`
//   · 返回 media_id **3 天内有效**；普通文件 ≤ 20MB；所有文件必须 > 5 字节
//   · 发送：POST /cgi-bin/kf/send_msg，`{touser, open_kfid, msgtype:"file", file:{media_id}}`
//   · 同一页还写明两件事，实现时必须记住（见下方常量与 reply.js 注释）：
//       ① 客户主动发消息后 48 小时内，企业最多可发 5 条；
//       ② 「接口返回成功不代表消息最终发送成功」——要另看发送失败事件回调。
export const UPLOAD_MAX_BYTES = 20 * 1024 * 1024;
export const UPLOAD_MIN_BYTES = 6; // 官方：必须大于 5 个字节
export const MEDIA_ID_TTL_MS = 3 * 24 * 60 * 60 * 1000; // 官方：media_id 3 天内有效
// 客户主动发言后 48 小时内最多可发 5 条（同页原文）。v1 只在结果里回报"本窗口已发 N 条"，
// 不在本地硬拦：官方是否会因第 6 条直接拒，需要用真凭据打一次才敢写死。
export const WINDOW_MAX_SENDS = 5;

const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 10_000;

const TOKEN_ERRCODES = new Set([42001, 40014, 41001]);
const CONFIG_ERRCODES = new Set([40001, 40013, 40056]);
// 60020 = 调用方出口 IP 不在「企业可信IP」里。真机实测（2026-11-12）：gettoken 不受此限，
// 所以"取到票"之后才撞上它。不单独命名就会被当成 secret 填错，改一晚上凭据。
export const IP_ERRCODE = 60020;

export class KfApiError extends Error {
  constructor({ errcode, errmsg, op }) {
    super(`${op} 失败：errcode=${errcode} ${errmsg || ""}`.trim());
    this.name = "KfApiError";
    this.errcode = Number(errcode);
    this.errmsg = errmsg || "";
    this.op = op;
  }
}

export class KfConfigError extends KfApiError {
  constructor(args) {
    super(args);
    this.name = "KfConfigError";
  }
}

export class KfTokenError extends KfApiError {
  constructor(args) {
    super(args);
    this.name = "KfTokenError";
  }
}

/**
 * 出口 IP 未被信任。官方 errmsg 里带着调用方 IP（`from ip: 1.2.3.4`），
 * 把它挖出来当字段：运维要拿这个值去后台加白名单，而不是去猜。
 */
export class KfIpNotTrustedError extends KfApiError {
  constructor(args) {
    super(args);
    this.name = "KfIpNotTrustedError";
    const m = /from ip:\s*([0-9a-fA-F.:]+)/.exec(String(args?.errmsg || ""));
    this.ip = m ? m[1] : "";
  }
}

/** 失败分类只命名确定的四种；其余原样保留 errcode，不猜含义。 */
export function classifyKfError({ errcode, errmsg, op }) {
  const code = Number(errcode);
  if (code === IP_ERRCODE) return new KfIpNotTrustedError({ errcode: code, errmsg, op });
  if (CONFIG_ERRCODES.has(code)) return new KfConfigError({ errcode: code, errmsg, op });
  if (TOKEN_ERRCODES.has(code)) return new KfTokenError({ errcode: code, errmsg, op });
  return new KfApiError({ errcode: code, errmsg, op });
}

/** 从任意字符串里擦掉本次凭据。导出是为了让测试能直接断言。 */
export function redact(text, secrets = []) {
  let out = String(text ?? "");
  for (const s of secrets) {
    if (!s) continue;
    const v = String(s);
    if (v.length < 6) continue;
    out = out.split(v).join("***");
  }
  return out;
}

/**
 * 创建客户端。`fetchImpl` 必须可注入——没有真凭据时测试也要能覆盖全部分支。
 */
export function createKfClient({
  fetchImpl = globalThis.fetch,
  corpId = "",
  secret = "",
  baseUrl = DEFAULT_BASE_URL,
  now = () => Date.now(),
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (typeof fetchImpl !== "function") throw new Error("createKfClient 需要可用的 fetch");

  let cache = { token: "", expiresAt: 0 };
  // 擦除用：任何时候错误信息里出现这两个值都要抹掉
  const secrets = () => [secret, cache.token];

  async function callJson({ op, path, method = "POST", query = {}, body }) {
    const url = new URL(path, baseUrl);
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    }
    const init = { method, headers: { "content-type": "application/json" } };
    if (body !== undefined) init.body = JSON.stringify(body);
    if (timeoutMs > 0 && typeof AbortSignal?.timeout === "function") {
      init.signal = AbortSignal.timeout(timeoutMs);
    }

    let resp;
    try {
      resp = await fetchImpl(url.toString(), init);
    } catch (err) {
      throw new KfApiError({
        errcode: -1,
        errmsg: redact(`网络失败：${err?.message || err}`, secrets()),
        op,
      });
    }
    if (!resp || typeof resp.json !== "function") {
      throw new KfApiError({ errcode: -2, errmsg: "响应不可解析", op });
    }
    let data;
    try {
      data = await resp.json();
    } catch {
      throw new KfApiError({
        errcode: -3,
        errmsg: `响应不是 JSON（HTTP ${resp.status ?? "?"}）`,
        op,
      });
    }
    const errcode = Number(data?.errcode ?? 0);
    if (errcode !== 0) {
      throw classifyKfError({ errcode, errmsg: redact(data?.errmsg, secrets()), op });
    }
    return data;
  }

  async function fetchToken() {
    if (!corpId) throw new KfConfigError({ errcode: 40013, errmsg: "未配置 corpid", op: "gettoken" });
    if (!secret) throw new KfConfigError({ errcode: 40001, errmsg: "未配置 secret", op: "gettoken" });
    const data = await callJson({
      op: "gettoken",
      path: "/cgi-bin/gettoken",
      method: "GET",
      query: { corpid: corpId, corpsecret: secret },
    });
    const expiresIn = Number(data.expires_in || 7200);
    cache = {
      token: String(data.access_token || ""),
      // 提前 5 分钟失效：卡在最后一秒取票，失败一次就是一个批次的空洞。
      expiresAt: now() + Math.max(0, expiresIn * 1000 - TOKEN_REFRESH_MARGIN_MS),
    };
    if (!cache.token) {
      throw new KfApiError({ errcode: -4, errmsg: "gettoken 未返回 access_token", op: "gettoken" });
    }
    return cache.token;
  }

  async function token({ force = false } = {}) {
    if (!force && cache.token && now() < cache.expiresAt) return cache.token;
    return fetchToken();
  }

  /** 带令牌的调用：令牌失效时刷新一次并重试一次，仅此而已。 */
  async function callWithToken(args, { retried = false } = {}) {
    const t = await token({ force: retried });
    try {
      return await callJson({
        ...args,
        query: { ...args.query, access_token: t },
      });
    } catch (err) {
      if (err instanceof KfTokenError && !retried) {
        cache = { token: "", expiresAt: 0 };
        return callWithToken(args, { retried: true });
      }
      throw err;
    }
  }

  /**
   * 带令牌的 multipart 调用（上传临时素材）。与 `callJson` 的唯一差别是请求体，
   * 但也正因为这个差别，它**不能**复用 callJson：手写 content-type 会把 fetch 生成的
   * multipart boundary 覆盖掉，服务端读不到字段，表现为"上传了但没 media_id"。
   */
  async function callForm({ op, path, query = {}, form, retried = false }) {
    const t = await token({ force: retried });
    const url = new URL(path, baseUrl);
    for (const [k, v] of Object.entries({ ...query, access_token: t })) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    }
    // 不设 content-type：multipart 的 boundary 必须由 fetch 自己生成。
    const init = { method: "POST", body: form };
    if (timeoutMs > 0 && typeof AbortSignal?.timeout === "function") {
      init.signal = AbortSignal.timeout(timeoutMs);
    }

    let resp;
    try {
      resp = await fetchImpl(url.toString(), init);
    } catch (err) {
      throw new KfApiError({
        errcode: -1,
        errmsg: redact(`网络失败：${err?.message || err}`, secrets()),
        op,
      });
    }
    let data;
    try {
      data = await resp.json();
    } catch {
      throw new KfApiError({
        errcode: -3,
        errmsg: `响应不是 JSON（HTTP ${resp.status ?? "?"}）`,
        op,
      });
    }
    const errcode = Number(data?.errcode ?? 0);
    if (errcode !== 0) {
      const err = classifyKfError({ errcode, errmsg: redact(data?.errmsg, secrets()), op });
      // 与 callWithToken 同一条纪律：票失效只重试一次。
      if (err instanceof KfTokenError && !retried) {
        cache = { token: "", expiresAt: 0 };
        return callForm({ op, path, query, form, retried: true });
      }
      throw err;
    }
    return data;
  }

  /**
   * 取二进制。与 `callJson` 的关键差别：**响应可能是 JSON 错误也可能是一段文件**，
   * 只能靠 content-type 分辨。把 JSON 当文件写下去，会得到一个 200 字节的"假图片"，
   * 而且状态是 done——所以这里对 JSON 一律当失败。
   */
  async function callRaw({ op, path, query = {}, retried = false }) {
    const t = await token({ force: retried });
    const url = new URL(path, baseUrl);
    for (const [k, v] of Object.entries({ ...query, access_token: t })) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    }
    const init = { method: "GET" };
    if (timeoutMs > 0 && typeof AbortSignal?.timeout === "function") {
      init.signal = AbortSignal.timeout(Math.max(timeoutMs, 30_000));
    }

    let resp;
    try {
      resp = await fetchImpl(url.toString(), init);
    } catch (err) {
      throw new KfApiError({
        errcode: -1,
        errmsg: redact(`网络失败：${err?.message || err}`, secrets()),
        op,
      });
    }
    const contentType = String(resp?.headers?.get?.("content-type") || "");

    if (contentType.includes("application/json")) {
      let data = null;
      try {
        data = await resp.json();
      } catch {
        throw new KfApiError({ errcode: -3, errmsg: "响应声明是 JSON 但解析失败", op });
      }
      const errcode = Number(data?.errcode ?? 0);
      if (errcode !== 0) {
        const err = classifyKfError({ errcode, errmsg: redact(data?.errmsg, secrets()), op });
        if (err instanceof KfTokenError && !retried) {
          cache = { token: "", expiresAt: 0 };
          return callRaw({ op, path, query, retried: true });
        }
        throw err;
      }
      // 200 + JSON + errcode=0 却要一个文件：这是协议矛盾，不能当成功
      throw new KfApiError({ errcode: -5, errmsg: "接口返回 JSON 而不是媒体内容", op });
    }

    if (typeof resp?.arrayBuffer !== "function") {
      throw new KfApiError({ errcode: -2, errmsg: "响应不可读取", op });
    }
    const buffer = Buffer.from(await resp.arrayBuffer());
    if (buffer.length > MAX_MEDIA_BYTES) {
      throw new KfApiError({
        errcode: -6,
        errmsg: `媒体 ${buffer.length} 字节，超过运维护栏 ${MAX_MEDIA_BYTES}`,
        op,
      });
    }
    const disposition = String(resp?.headers?.get?.("content-disposition") || "");
    const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition);
    return { buffer, contentType, filename: match ? decodeURIComponent(match[1]) : "" };
  }

  return {
    /** 只用于诊断：不暴露令牌本身。 */
    tokenState() {
      return { cached: Boolean(cache.token) && now() < cache.expiresAt, expiresAt: cache.expiresAt };
    },

    async getToken() {
      return token();
    },

    /**
     * 拉取一批消息。
     *
     * 注意 `token` 入参：官方 `sync_msg` 有一个同名的事件令牌，只在处理回调事件时有意义，
     * 一次性。轮询模式**不传**——持久化它会让下一次请求从旧位置开始，表现为
     * "有数据、无报错、永不前进"。
     */
    /**
     * 拉取一批消息。
     *
     * 两个入参的语义必须分清（官方文档 94670）：
     *   - `open_kfid` 是**必填**：只能按客服账号拉，文档没有"不填则拉全部"这种行为。
     *     早先我把它当可选，是让用户少填一项，但那是在臆造上游行为——已改回必填。
     *   - `token` 是回调事件令牌、10 分钟有效、一次性。轮询模式**不传**；
     *     持久化它会让下一次请求从旧位置开始，表现为"有数据、无报错、永不前进"。
     *
     * 不填 `cursor` 时官方从 3 天内最早的消息开始，正好对应首轮同步。
     */
    async syncMsg({ cursor = "", openKfId = "", limit = MAX_SYNC_LIMIT, voiceFormat = 0 } = {}) {
      if (!openKfId) {
        throw new KfApiError({
          errcode: -15,
          errmsg: "缺少 open_kfid：sync_msg 必须指定客服账号（文档标为必填）",
          op: "sync_msg",
        });
      }
      const size = Math.max(1, Math.min(MAX_SYNC_LIMIT, Number(limit) || MAX_SYNC_LIMIT));
      const data = await callWithToken({
        op: "sync_msg",
        path: "/cgi-bin/kf/sync_msg",
        body: {
          ...(cursor ? { cursor: String(cursor) } : {}),
          limit: size,
          voice_format: Number(voiceFormat) || 0,
          open_kfid: String(openKfId),
        },
      });
      return {
        nextCursor: String(data.next_cursor ?? ""),
        hasMore: Number(data.has_more || 0) === 1,
        messages: Array.isArray(data.msg_list) ? data.msg_list : [],
      };
    },

    /**
     * 自动决定用哪个客服账号：只配了一个就直接用，多个则报错让人选。
     *
     * 这样既不必让用户去后台翻 id，也不假装"不填就拉全部"。
     */
    async resolveOpenKfId(explicit = "") {
      if (explicit) return { openKfId: String(explicit), source: "config" };
      const accounts = await this.listAccounts();
      const ids = accounts.map((a) => String(a.open_kfid || "")).filter(Boolean);
      if (ids.length === 1) return { openKfId: ids[0], source: "auto", accounts };
      return {
        openKfId: "",
        source: ids.length ? "ambiguous" : "none",
        accounts,
        reason: ids.length
          ? `本企业有 ${ids.length} 个客服账号，请用 KF_OPEN_KFID 指定：${ids.join(", ")}`
          : "本企业没有客服账号：先在微信客服创建，并把接待人员加入应用可见范围",
      };
    },

    /** 批量补客户资料。自动按官方单次 100 上限分片。 */
    async getCustomers(externalUserIds = []) {
      const ids = [...new Set((externalUserIds || []).filter(Boolean).map(String))];
      const customers = [];
      const invalid = [];
      for (let i = 0; i < ids.length; i += MAX_CUSTOMER_BATCH) {
        const chunk = ids.slice(i, i + MAX_CUSTOMER_BATCH);
        const data = await callWithToken({
          op: "customer_batchget",
          path: "/cgi-bin/kf/customer/batchget",
          body: { external_userid_list: chunk, need_enter_session_context: 0 },
        });
        for (const c of data.customer_list || []) customers.push(c);
        for (const id of data.invalid_external_userid || []) invalid.push(String(id));
      }
      return { customers, invalid };
    },

    /** 客服账号列表。诊断用它确认「kf 接口权限真的开了」。 */
    async listAccounts({ offset = 0, limit = 100 } = {}) {
      const data = await callWithToken({
        op: "account_list",
        path: "/cgi-bin/kf/account/list",
        body: { offset: Number(offset) || 0, limit: Number(limit) || 100 },
      });
      return Array.isArray(data.account_list) ? data.account_list : [];
    },

    /**
     * 下载一条媒体（图片 / 语音 / 视频 / 文件）。
     *
     * kf 的媒体是整包返回，没有分块协议。`voice_format` 只对语音有意义
     * （0=amr 1=silk 2=mp3），其它类型传了会被忽略。
     */
    async getMedia({ mediaId, voiceFormat = 0 } = {}) {
      const id = String(mediaId || "").trim();
      if (!id) throw new KfApiError({ errcode: -14, errmsg: "缺少 media_id", op: "media_get" });
      return callRaw({
        op: "media_get",
        path: "/cgi-bin/media/get",
        query: { media_id: id, voice_format: Number(voiceFormat) || 0 },
      });
    },

    /**
     * 发送文本。**这是对外动作**，只在调用方明确指定目标时发生；
     * 摄取循环永远不会调它。
     *
     * 校验放在本地：空正文、超长正文（官方 text 上限 2048 字节）、
     * 缺 `touser`/`open_kfid` 都在发请求之前拒掉——发给真实客户的消息
     * 不该靠"发出去看看报什么错"来验证。
     */
    async sendText({ externalUserId, openKfId, content }) {
      const touser = String(externalUserId || "").trim();
      const kfid = String(openKfId || "").trim();
      const body = String(content ?? "");
      if (!touser) throw new KfApiError({ errcode: -10, errmsg: "缺少 external_userid", op: "send_msg" });
      if (!kfid) throw new KfApiError({ errcode: -11, errmsg: "缺少 open_kfid", op: "send_msg" });
      if (!body.trim()) throw new KfApiError({ errcode: -12, errmsg: "正文为空", op: "send_msg" });
      const bytes = Buffer.byteLength(body, "utf8");
      if (bytes > MAX_TEXT_BYTES) {
        throw new KfApiError({
          errcode: -13,
          errmsg: `正文 ${bytes} 字节，超过上限 ${MAX_TEXT_BYTES}`,
          op: "send_msg",
        });
      }
      const data = await callWithToken({
        op: "send_msg",
        path: "/cgi-bin/kf/send_msg",
        body: { touser, open_kfid: kfid, msgtype: "text", text: { content: body } },
      });
      return { msgId: String(data.msgid || "") };
    },

    /**
     * 上传临时素材，拿到 `media_id`。
     *
     * 与发送**分开**是刻意的：上传失败要重传，发送失败只要重发——合成一个方法就分不清。
     * 上传本身是对外副作用（腾讯侧产生对象、占配额），所以体积闸必须在发请求之前。
     *
     * 返回 `{ mediaId, createdAt }`；`mediaId` 3 天内有效（官方口径见文件头常量注释）。
     */
    async uploadMedia({ mediaType = "file", fileName = "", buffer } = {}) {
      const type = String(mediaType || "file").trim() || "file";
      const bytes = buffer?.length ?? 0;
      if (!bytes) {
        throw new KfApiError({ errcode: -20, errmsg: "文件为空", op: "upload_media" });
      }
      // 官方两条硬线：> 5 字节，普通文件 ≤ 20MB。在本地拒绝，免得把一个"必然被拒"
      // 的请求打出去，让排查的人去查凭据和网络。
      if (bytes < UPLOAD_MIN_BYTES) {
        throw new KfApiError({
          errcode: -21,
          errmsg: `文件 ${bytes} 字节，小于官方最小 ${UPLOAD_MIN_BYTES} 字节`,
          op: "upload_media",
        });
      }
      if (type === "file" && bytes > UPLOAD_MAX_BYTES) {
        throw new KfApiError({
          errcode: -22,
          errmsg: `文件 ${bytes} 字节，超过官方上限 ${UPLOAD_MAX_BYTES}`,
          op: "upload_media",
        });
      }

      const name = String(fileName || "").trim() || `upload.${type}`;
      const form = new FormData();
      form.append("media", new Blob([buffer]), name);

      let data = await callForm({ op: "upload_media", path: "/cgi-bin/media/upload", query: { type }, form });
      if (!data?.media_id) {
        throw new KfApiError({ errcode: -23, errmsg: "上传未返回 media_id", op: "upload_media" });
      }
      return { mediaId: String(data.media_id), createdAt: Number(data.created_at || 0) };
    },

    /** 以已上传的 `media_id` 发送文件。字段形状见文件头常量注释（path/94677）。 */
    async sendFile({ externalUserId, openKfId, mediaId }) {
      const touser = String(externalUserId || "").trim();
      const kfid = String(openKfId || "").trim();
      const id = String(mediaId || "").trim();
      if (!touser) throw new KfApiError({ errcode: -30, errmsg: "缺少 external_userid", op: "send_msg" });
      if (!kfid) throw new KfApiError({ errcode: -31, errmsg: "缺少 open_kfid", op: "send_msg" });
      if (!id) throw new KfApiError({ errcode: -32, errmsg: "缺少 media_id", op: "send_msg" });
      const data = await callWithToken({
        op: "send_msg",
        path: "/cgi-bin/kf/send_msg",
        body: { touser, open_kfid: kfid, msgtype: "file", file: { media_id: id } },
      });
      return { msgId: String(data.msgid || "") };
    },
  };
}
