// ── WeCom archive SDK binding ───────────────────────────────────────────────
//
// 官方只提供 C++ 的 libWeWorkFinanceSdk_C.so / .dll 与 Java JNI 包，没有 Node 绑定。
// Node 不能 dlopen 一个 C 库（node-ffi 早已停更），所以这里不做"直接在 Node 里调 .so"
// 这种在实现阶段一定会翻车的事，而是把 SDK 放到一个**独立 helper 进程**后面，用
// 按行分隔的 JSON 通信：
//
//     node  ──{"op":"getChatData","seq":0,"limit":1000}──▶  helper(Go/Python+CGO/ctypes)
//           ◀──{"ok":true,"messages":[...],"seq":1000}────
//
// 这样做换来三件事：
//   • 绑定层用哪门语言写不影响 Node 侧，helper 可单独测、单独换；
//   • SDK 的 .so 与 RSA 私钥都只出现在 helper 的进程环境里，Node 侧拿不到；
//   • 测试可以用 stub driver 跑全部逻辑，不需要真 SDK、真席位。
//
// 三条硬约束（都有官方依据，见 design.md D1/D2/D5）：
//   • limit > 1000 官方直接报错 → 这里在发请求前就拒，且**不推进游标**；
//   • limit 超限不是"空结果"，必须是失败；
//   • 拉取失败不得把 seq 往前推。

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export const MAX_LIMIT = 1000;

/** helper 协议错误：不是"上游无数据"，是我们自己的调用形状错了。 */
export class SdkProtocolError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = "SdkProtocolError";
    this.detail = detail;
  }
}

/** 未就绪：缺私钥 / 缺 secret / 出口不在白名单。不是"没有新消息"。 */
export class ArchiveNotReadyError extends Error {
  constructor(reason, detail = {}) {
    super(reason);
    this.name = "ArchiveNotReadyError";
    this.detail = detail;
  }
}

/**
 * 校验挂载进来的 SDK 文件。
 *
 * 为什么必须校验而不是"能加载就行"：SDK 由客户自行下载放进挂载点，我们的产物里没有它。
 * 这意味着一个被替换过的 `.so` 与正版在行为上无法区分——而它跑在客户生产环境里、
 * 能读到用客户私钥解出的明文。sha256 钉住是最便宜的防线。
 *
 * 四种结果分开返回，因为它们要四种不同的处置：
 *   - `missing`    文件不在 → 未配置（部署没做），不是故障
 *   - `unreadable` 存在但读不了 → 权限/挂载问题
 *   - `mismatch`   哈希不符 → **拒绝启动**，且不自动回退
 *   - `unpinned`   没配期望值 → 允许运行但明确告知"未固定"，不假装校验过
 */
export function verifySdkFile({ path, expectedSha256 = "", readFile = null } = {}) {
  const want = String(expectedSha256 || "").trim().toLowerCase();
  if (!path) return { ok: false, state: "missing", actual: null, expected: want || null };

  let hash;
  try {
    const buf = readFile ? readFile(path) : readFileSync(path);
    hash = createHash("sha256").update(buf).digest("hex");
  } catch (err) {
    if (err?.code === "ENOENT") {
      return { ok: false, state: "missing", actual: null, expected: want || null, path };
    }
    return {
      ok: false,
      state: "unreadable",
      actual: null,
      expected: want || null,
      path,
      message: err?.message || String(err),
    };
  }

  if (!want) return { ok: true, state: "unpinned", actual: hash, expected: null, path };

  const ok = hash === want;
  return {
    ok,
    state: ok ? "ok" : "mismatch",
    actual: hash,
    expected: want,
    path,
    ...(ok ? {} : { message: `sha256 不符：期望 ${want}，实际 ${hash}` }),
  };
}

/**
 * 出口 IP 不在可信列表。
 *
 * 两个码都要认，因为它们来自两个不同的面：
 *   - `10009` —— **会话存档 C SDK** 的返回码（官方头文件注释：「ip非法」）。真机走 SDK 时看到的是它。
 *   - `301042` —— 企业微信 HTTP 接口面的同义码（后台可信 IP 未覆盖）。
 *
 * 早先只写了 301042：真 SDK 报 10009 时会被归成通用协议错误，现场就去查 SDK/网络，
 * 而真正要做的只是把出口 IP 加进后台白名单。
 */
export class WhiteIpMismatchError extends Error {
  constructor(detail = {}) {
    const code = Number(detail?.errCode ?? detail?.errcode ?? 0) || null;
    super(
      `出口 IP 不在企业微信「会话内容存档」的可信列表里${code ? `（errcode=${code}）` : ""}；` +
        "去后台把该 IP 加进可信 IP，不是换 SDK、也不是改 secret",
    );
    this.name = "WhiteIpMismatchError";
    this.detail = detail;
  }
}

const WHITE_IP_CODES = new Set([10009, 301042]);

/**
 * 私钥版本不对。官方 10007：「找不到消息加密版本的私钥，需要重新传入私钥对」。
 *
 * 这是**多密钥版本**企业的常见情形：后台轮换过密钥，历史消息用旧版本加密，而我们只挂了一把。
 * 与"私钥文件缺失"（9005）和"私钥解不开"（9006）都不同——修法是补齐对应版本的私钥。
 */
export class PrivateKeyVersionMismatchError extends Error {
  constructor(detail = {}) {
    super("找不到该消息加密版本的私钥（errcode=10007）：后台可能轮换过密钥，需要补齐对应版本的私钥");
    this.name = "PrivateKeyVersionMismatchError";
    this.detail = detail;
  }
}

/** 10006 解密失败 / 10008 解析 encrypt_key 出错：密钥与密文对不上。 */
export class SdkDecryptError extends Error {
  constructor(message, detail = {}) {
    super(message || "会话存档解密失败（密钥与密文对不上）");
    this.name = "SdkDecryptError";
    this.detail = detail;
  }
}

/**
 * 10010 数据过期。官方只保留 3 天，这条永远不可补——必须与"网络抖动"分开，
 * 否则现场会以为重试几次就能补回来。
 */
export class DataExpiredError extends Error {
  constructor(detail = {}) {
    super("会话存档数据已过期（errcode=10010，官方只保留 3 天），这段缺口不可补");
    this.name = "DataExpiredError";
    this.detail = detail;
  }
}

/** 10000 参数错误：我们自己把调用形状写错了，与上游无关。 */
export class SdkRequestError extends Error {
  constructor(message, detail = {}) {
    super(message || "会话存档 SDK 参数错误（errcode=10000）");
    this.name = "SdkRequestError";
    this.detail = detail;
  }
}

/** helper 侧的两个 RSA 相关错误码（见 archive_helper.py 的常量表）。 */
export const KEY_MISSING_CODE = 9005;
export const RSA_DECRYPT_CODE = 9006;

/**
 * 私钥没配。这是"还没准备好"，不是"数据坏了"——所以单独一个类型：
 * 现场看到 key-not-configured 应该去挂私钥，而不是查网络或换 SDK。
 */
export class PrivateKeyNotConfiguredError extends Error {
  constructor(detail = {}) {
    super("未配置私钥（ARCHIVE_PRIVATE_KEY），无法解 encrypt_random_key");
    this.name = "PrivateKeyNotConfiguredError";
    this.detail = detail;
  }
}

/**
 * 私钥在但解不开这串密文：最常见是公钥/私钥不配对，或密文被截断。
 * 与"未配置"分开，因为修法完全不同（换钥匙 vs 换文件）。
 */
export class RsaDecryptError extends Error {
  constructor(message, detail = {}) {
    super(message || "encrypt_random_key RSA 解密失败");
    this.name = "RsaDecryptError";
    this.detail = detail;
  }
}

/**
 * 从任意字符串里擦掉本次凭据。
 *
 * 为什么需要：helper 是独立进程，它回传的 `message` 原样变成我们的异常正文。
 * 上游（或我们自己的 helper）只要在报错里回显一次请求内容，secret 就会进
 * 日志、进告警、进用户贴出来的截图。这不是"应该不会"，是必须主动擦。
 *
 * 短于 6 字符的值不擦：那种长度擦下去只会把正常文本打碎，副作用大于收益。
 */
export function redactSecrets(text, secrets = []) {
  let out = String(text ?? "");
  for (const s of secrets) {
    const v = String(s ?? "");
    if (v.length < 6) continue;
    out = out.split(v).join("***");
  }
  return out;
}

/** 调用点统一走这里：driver 上没有脱敏函数时退化为原文，绝不因缺件而崩。 */
function redactVia(driver, text) {
  return typeof driver?.redact === "function" ? driver.redact(text) : text;
}

/**
 * 把 helper 返回的错误码翻成带名字的异常。
 *
 * 这张表是"先给失败起名字"的落地：301042 与其它错误混在一个 catch 里，
 * 现场只会报"拉取失败"，然后有人去查网络。
 */
export function classify(errCode, message, detail = {}) {
  const code = Number(errCode);
  if (WHITE_IP_CODES.has(code)) return new WhiteIpMismatchError({ errCode: code, ...detail });
  if (code === KEY_MISSING_CODE) return new PrivateKeyNotConfiguredError({ errCode: code, ...detail });
  if (code === RSA_DECRYPT_CODE) return new RsaDecryptError(message, { errCode: code, ...detail });
  // 官方头文件错误码表（10000–10011）。只给"处置不同"的那几个起名字。
  if (code === 10007) return new PrivateKeyVersionMismatchError({ errCode: code, ...detail });
  if (code === 10006 || code === 10008) {
    return new SdkDecryptError(message, { errCode: code, ...detail });
  }
  if (code === 10010) return new DataExpiredError({ errCode: code, ...detail });
  if (code === 10000) return new SdkRequestError(message, { errCode: code, ...detail });
  return new SdkProtocolError(message || `SDK 返回错误码 ${errCode}`, {
    errCode,
    ...detail,
  });
}

/**
 * 拉一批。driver 只负责"发请求、收结果"，游标语义在这一层之外。
 *
 * @param {{call: (payload: object) => Promise<object>}} driver
 * @param {{seq: number, limit?: number, timeoutMs?: number}} opts
 * @returns {Promise<{messages: object[], seq: number, raw: object}>}
 */
export async function getChatData(driver, opts) {
  const seq = Number(opts?.seq ?? 0);
  const limit = Number(opts?.limit ?? MAX_LIMIT);

  if (!Number.isInteger(seq) || seq < 0) {
    throw new SdkProtocolError(`seq 必须是非负整数，收到 ${opts?.seq}`);
  }
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new SdkProtocolError(`limit 必须是正整数，收到 ${opts?.limit}`);
  }
  // 官方：超过 1000 条会返回错误。发之前就拒，避免"服务端报错但我们当成空结果"。
  if (limit > MAX_LIMIT) {
    throw new SdkProtocolError(
      `limit=${limit} 超过官方上限 ${MAX_LIMIT}；这是调用形状错误，不是"没有新消息"`,
      { limit, max: MAX_LIMIT },
    );
  }

  const reply = await driver.call({
    op: "getChatData",
    seq,
    limit,
    timeoutMs: Number(opts?.timeoutMs ?? 30_000),
  });

  if (!reply || typeof reply !== "object") {
    throw new SdkProtocolError("helper 返回了非对象结果");
  }
  // 显式失败（ok:false）与隐式失败（只给了非 0 的 errCode、没给 ok）都要认。
  // 只认 ok:false 的话，helper 换个写法就会掉进下面的「缺少 messages 数组」，
  // 上游原话被丢掉、现场被引去查协议形状——那是最难查的一类误导。
  const explicitFail = reply.ok === false;
  const implicitFail =
    reply.ok === undefined && reply.errCode !== undefined && Number(reply.errCode) !== 0;
  if (explicitFail || implicitFail) {
    throw classify(reply.errCode, redactVia(driver, reply.message), { seq, limit });
  }
  if (!Array.isArray(reply.messages)) {
    throw new SdkProtocolError("helper 结果缺少 messages 数组", { keys: Object.keys(reply) });
  }
  return { messages: reply.messages, seq: Number(reply.seq ?? seq), raw: reply };
}

/**
 * 解一条消息的随机密钥再解正文。
 *
 * 官方 SDK 里没有私钥参数——`encrypt_random_key` 是 RSA/PKCS#1 v1.5 密文，
 * 由企业自己解。这一步失败 MUST NOT 退化成"消息丢弃"，否则会静默少消息。
 */
export async function decryptMessage(driver, { encryptRandomKey, encryptChatMsg, seq }) {
  if (!encryptRandomKey || !encryptChatMsg) {
    throw new SdkProtocolError("缺少 encrypt_random_key 或 encrypt_chat_msg", { seq });
  }
  const reply = await driver.call({
    op: "decryptData",
    encryptRandomKey,
    encryptChatMsg,
  });
  if (reply?.ok === false) {
    throw classify(reply.errCode, redactVia(driver, reply.message), { seq });
  }
  if (typeof reply?.plain !== "string") {
    throw new SdkProtocolError("解密结果不是字符串", { seq });
  }
  return reply.plain;
}

/**
 * 媒体分块拉取。512 KB/次是官方口径；`is_finish` 表示这一块的 indexbuf 还能不能再往下读。
 */
export const MEDIA_CHUNK_BYTES = 512 * 1024;

export async function getMediaData(driver, { sdkFileId, indexBuf = "", timeoutMs = 30_000 }) {
  if (!sdkFileId) {
    throw new SdkProtocolError("缺少 sdkfileid");
  }
  const reply = await driver.call({
    op: "getMediaData",
    sdkFileId,
    indexBuf,
    timeoutMs,
  });
  if (reply?.ok === false) {
    throw classify(reply.errCode, redactVia(driver, reply.message), { sdkFileId });
  }
  const chunk = Buffer.from(reply?.chunkBase64 || "", "base64");
  return {
    chunk,
    outIndexBuf: reply?.outIndexBuf || "",
    // 严格按官方标志位判完成。早先这里写的是 `Boolean(isFinish) || !outIndexBuf`，
    // 把"没给 outIndexBuf"也当成"拉完了"——文件被截断却标 done，且不报错。
    // 调用方必须显式处理"既未完成、也没有下一块"这种矛盾状态（media.js 会抛）。
    isFinish: Boolean(reply?.isFinish),
  };
}

/**
 * 就绪探测：五项激活清单里的"私钥可用 / secret 类型正确 / 出口在白名单"。
 *
 * 返回结构化结论而不是布尔——"未就绪"必须能指出是缺哪一项，否则现场只会得到
 * "拉不到数据"。
 */
export async function probeReadiness(driver, cfg = {}) {
  const checks = {
    sdkPresent: null,
    privateKeyPresent: null,
    secretShape: null,
    egressIp: cfg.expectedEgressIp || "",
  };

  checks.privateKeyPresent = Boolean(cfg.privateKeyPath);
  // 会话存档 secret 与普通应用 secret 不是同一个：官方从「管理工具 → 聊天内容存档」单独生成。
  const secret = String(cfg.secret || "");
  if (!secret) checks.secretShape = "missing";
  else if (secret.length < 32) checks.secretShape = "too_short";
  else checks.secretShape = "ok";

  let ping = null;
  try {
    ping = await driver.call({ op: "ping" });
  } catch (err) {
    ping = { ok: false, message: err?.message || String(err) };
  }
  checks.sdkPresent = Boolean(ping?.ok);
  if (ping?.egressIp) checks.actualEgressIp = ping.egressIp;
  if (WHITE_IP_CODES.has(Number(ping?.errCode))) {
    checks.egressIpMatch = false;
  } else if (checks.actualEgressIp && checks.egressIp) {
    checks.egressIpMatch = checks.actualEgressIp === checks.egressIp;
  }

  const missing = [];
  if (!checks.sdkPresent) missing.push("sdk");
  if (!checks.privateKeyPresent) missing.push("private_key");
  if (checks.secretShape !== "ok") missing.push("secret");
  if (checks.egressIpMatch === false) missing.push("egress_ip");

  return {
    ready: missing.length === 0,
    missing,
    checks,
    ping,
  };
}

/**
 * Stdio driver：spawn 一个 helper 进程，按行发 JSON、按行收 JSON。
 *
 * 故意不在此处解析 SDK 语义——driver 只搬字节。语义全在上面的纯函数里，
 * 这样测试不需要进程。
 */
export function createStdioDriver({ command, args = [], env = {}, spawnImpl, secrets = [] } = {}) {
  if (!command) throw new ArchiveNotReadyError("未配置 archive SDK helper 命令");
  const spawn = spawnImpl;
  if (typeof spawn !== "function") {
    throw new ArchiveNotReadyError("缺少 spawn 实现（不要在模块顶层 import child_process 之外的形态）");
  }
  // 这个驱动对外产出的文本（异常正文）都要先擦一遍：helper 的 message 是外部
  // 字符串，直接当异常正文用，等于把凭据交到任何读日志/看截图的人手里。
  const redact = (text) => redactSecrets(text, secrets);
  const child = spawn(command, args, { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
  let buffer = "";
  const waiters = [];
  const pending = [];

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    for (;;) {
      const idx = buffer.indexOf("\n");
      if (idx < 0) break;
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      const waiter = waiters.shift();
      if (waiter) waiter.resolve(msg);
      else pending.push(msg);
    }
  });

  child.on("exit", (code, signal) => {
    while (waiters.length) {
      waiters.shift().reject(
        new ArchiveNotReadyError(`helper 已退出（code=${code} signal=${signal}），拉取中断`),
      );
    }
  });

  return {
    /** 供调用方复用：把外部文本（helper message / 上游报错）擦干净再当正文用。 */
    redact,
    async call(payload) {
      const reply = pending.shift();
      if (reply) return reply;
      const promise = new Promise((resolve, reject) => waiters.push({ resolve, reject }));
      child.stdin.write(`${JSON.stringify(payload)}\n`);
      return promise;
    },
    close() {
      try {
        child.stdin.end();
      } catch {
        /* 已关闭 */
      }
    },
    get pid() {
      return child.pid;
    },
  };
}

/** Stub driver：测试与干跑用。`reply(op, payload)` 返回一次应答。 */
export function createStubDriver(reply) {
  const calls = [];
  return {
    calls,
    async call(payload) {
      calls.push(payload);
      return await reply(payload);
    },
    close() {},
  };
}
