// 舰队 MCP 的拒绝话术（2026-10-29 真机诊断 §15.88）。
//
// 为什么单独一个模块：`server/fleet-mcp.js` 顶层 `await server.connect(...)` 直接
// 占用 stdio，任何测试 import 它都会挂住——拒绝话术这样纯字符串的决定放进独立
// 文件才测得到。
//
// 背景：常务岗三件工具（decision_queue / decision_resolve /
// decision_escalate_to_owner）是**按岗授权**的，服务端 deputyGuard 校验归因岗位
// = 舰队策略的 deputyMemberId；而 MCP 子进程每 cell 一个、工具清单静态，没法只对
// 常务岗露出来。于是非常务岗也会看到并去点。
//
// 真机证据：CEO 岗在**成功**的一轮里连点 decision_queue 三次，每次只拿回一句
// `this post is not the fleet's delegated deputy`——信息量不足以让模型停止，它
// 换个角度再试；失败那轮还白烧 1 步，而那一轮正顶着 10 分钟回合预算。
//
// 所以拒绝要**自带结论和下一步**：告诉它这不是权限抖动、不要换参数重试，以及
// 现在该干什么。只在「非常务岗」这一条错误上做——通用的「别重试」会把真故障
// 也一起噤声。

export const DEPUTY_ONLY_HINT =
  "这是常务岗（决策代理）专用工具；本岗位不是本舰队的常务岗，调不通，也不要换参数重试。" +
  "本轮职责是巡视与报数——直接用 report_status 交数，确需主人定夺的用 escalate。";

// ── 岗位身份的两个通道（fix-report-attribution-concurrency 2.2，2026-11-12 修正）──
//
// 报数归属需要的岗位坐标必须来自**服务端写入**的东西，模型改不了：
//
//   1. `args.__fleetIdentity` —— 共用卫星的现役通道。`fleet` 在
//      SHARED_SATELLITE_SERVERS 里，全 cell 只由 mcp-satellite-host 起一份 stdio
//      子进程、被所有 runtime 共用；client 配置里的 env 没有任何进程会继承
//      （2026-11-12 生产实测：三个 fleet-mcp.js 子进程的 FLEET_MCP_* 全为 0，
//      报数照旧按"唯一在飞回合"归因）。所以身份随成员私有 patch 的 `X-Fleet-*`
//      header 进来，由中继逐请求读出来塞进 tools/call；调用方自带的同名键在中继
//      那边已被剥掉。
//   2. `process.env.FLEET_MCP_*` —— 逐 runtime stdio 的形态（若 fleet 将来按设计
//      "成员级 env 的卫星必须逐 runtime 起"从共享名单里摘出去），以及单测。
//
// 两处都没有 ⇒ 返回 null，调用方整个不自报：服务端按并发规则诚实拒收，而不是拿
// 全局 preset 去猜（那正是本 change 要修的生产事故）。
// 放在这里而不是 fleet-reports.js 的原因同本文件开头：中继与 fleet-mcp 都要用，
// 而这两个模块各自都有启动副作用。
export const FLEET_IDENTITY_ARG = "__fleetIdentity";

export function selfIdentityFrom(args, env = process.env) {
  const injected = args?.[FLEET_IDENTITY_ARG] ?? null;
  const fleetId = injected?.fleetId ?? env.FLEET_MCP_FLEET_ID;
  const memberId = injected?.memberId ?? env.FLEET_MCP_MEMBER_ID;
  const persona = injected?.persona ?? env.FLEET_MCP_PERSONA;
  if (!fleetId || !memberId) return null;
  return { fleetId: String(fleetId), memberId: String(memberId), ...(persona ? { persona: String(persona) } : {}) };
};

/**
 * 把本次调用的岗位身份并进要回服务端的 body（fix-deputy-attribution-self-report 1.1）。
 *
 * 为什么必须是纯函数并住在这里：`server/fleet-mcp.js` 顶层就 `await server.connect(...)`，
 * 单测 import 不进来；而这条规则恰恰是**会被新能力漏掉**的那种——漏了不会报错，
 * 只会在并发时让整条路由 409。2026-11-13 实历：`fix-report-attribution-concurrency`
 * 只接到了 report_status 与 dispatch_post，deputy 三件工具与 auditor/escalate
 * 五条路由一处没接，于是 9 个常务岗在错开的节奏下（同时两轮在飞是常态）**零裁决**。
 *
 * 调用方无法伪造：`__fleetIdentity` 的权威来源只有成员私有 patch 的 header，中继在
 * 转发前已把 arguments 里自带的同名键剥掉（mcp-satellite-host.js）。
 */
export const FLEET_TURN_TOKEN_ARG = "turn_token";
// Runner lane request context (add-fleet-bridge-endpoint-for-agent-runner 2.1).
//
// Why a reserved ARG and not env: `fleet` and `fleet-architect` are in
// SHARED_SATELLITE_SERVERS — one child per cell serves every runtime — so a
// secret in their env would be readable by every member's process in the
// container, and `scripts/test-mcp-satellite-sharing.mjs` fails the build when a
// shareable satellite reads a secret-shaped env at all. The value travels the
// same road as the identity: the satellite host reads it from the caller's
// headers per request and injects it here, stripping anything the model put in
// the same key first.
//
// Cell lane: no such header ⇒ null ⇒ the child keeps using its loopback bridge
// (byte-identical to before). Runner lane: `{ base, token }` where base is the
// full runner-facing mount (e.g. http://platform:3100/api/runner-fleet) and the
// child appends `/fleets/...` or `/architect/...`.
export const FLEET_BRIDGE_ARG = "__fleetBridge";

// The owner coordinate (add-fleet-bridge-endpoint-for-agent-runner 4.4).
//
// Why the owner must ride along and cannot be derived: a cell answers with ITS
// OWN owner's fleets (server/fleet-architect.js resolves `ctx.cellUserEmail`),
// and the gateway fronts many cells — so "which cell" is exactly "which owner".
// `fleet_list`'s inputSchema is an empty object, so there is no per-call token
// to reverse-resolve; the caller has to name it.
//
// Same road as base/token: the runner row carries `x-fleet-bridge-owner` to its
// satellite, the host injects it here per request, and the child forwards it as
// `x-fleet-owner` to the gateway door. A model that puts `__fleetBridge` in its
// own arguments gets it stripped before the host writes the real one back.
export const FLEET_OWNER_HEADER = "x-fleet-owner";

export function fleetBridgeFrom(args) {
  const raw = args?.[FLEET_BRIDGE_ARG];
  if (!raw || typeof raw !== "object") return null;
  const base = typeof raw.base === "string" ? raw.base.trim().replace(/\/+$/, "") : "";
  if (!base) return null;
  const token = typeof raw.token === "string" ? raw.token.trim() : "";
  const owner = typeof raw.owner === "string" ? raw.owner.trim().toLowerCase() : "";
  return { base, token, owner };
}

/** Outbound headers for a bridged call. One place for both children
 *  (fleet-mcp / fleet-architect): a second inlined copy is how "the owner is
 *  sent on one face and forgotten on the other" happens, and that failure looks
 *  exactly like a working install until the read face answers 400. */
export function bridgeHeaders(ctx) {
  if (!ctx) return {};
  return {
    ...(ctx.token ? { authorization: `Bearer ${ctx.token}` } : {}),
    ...(ctx.owner ? { [FLEET_OWNER_HEADER]: ctx.owner } : {}),
  };
}


/**
 * 本轮专属的回合令牌（attribute-turn-by-session）：平台起回合时生成、随该轮身份行
 * `【集群岗位身份】…; turn_token=<nonce>` 只送到该轮运行时，模型把它原样回传。
 *
 * 为什么需要它：worker 车道上没有成员私有 patch（home 按 pack 共享、N 个成员跨舰队），
 * header 与 env 两条身份通道都不可用，并发时服务端只剩「唯一在飞回合」可判 ⇒ 结构性 409。
 * 令牌由服务端写入、只送到一个运行时，强度与 header 同级，且与 carrier 无关。
 * 缺失/改写时只是回落到既有优先级，不会更坏。
 */
export function turnTokenFrom(args) {
  const raw = args?.[FLEET_TURN_TOKEN_ARG];
  return typeof raw === "string" && raw ? raw : null;
}

export function withSelfIdentity(body, args) {
  const base = body && typeof body === "object" ? body : {};
  const selfIdentity = selfIdentityFrom(args);
  const turnToken = turnTokenFrom(args);
  // 无身份时不多出一个 `selfIdentity: undefined` 键：服务端读的是 `?? null`，但
  // 一条空的键会让"这次到底自报了没有"在读日志时分不清。
  return {
    ...base,
    ...(selfIdentity ? { selfIdentity } : {}),
    ...(turnToken ? { turnToken } : {}),
  };
}

/** 「不是本舰队常务岗」这一条错误，带上结论与下一步；其余错误原样返回。 */
export function deputyDeniedText(message) {
  return `${message} — ${DEPUTY_ONLY_HINT}`;
}

/**
 * decision_resolve 的拒绝分三种，下一步完全不同：
 *   - 不是常务岗 → 收手去报数（指它去 decision_escalate_to_owner 等于再烧两步，
 *     因为那个工具它同样调不通）；
 *   - 分诊档条目（triage lane，409 + code）→ 这不是越权，是这类条目本来就不产出裁决；
 *     出口是上报主人，且**不要**再试 approve/reject（fix-triage-lane-has-no-consumer）；
 *   - 常务岗越权（类别/严重度/预算）→ 上升给主人。
 */
export function decisionResolveErrorText(message, status) {
  if (/not the fleet's delegated deputy/i.test(message)) return deputyDeniedText(message);
  if (/triage lane/i.test(message)) {
    return `${message} — do not retry approve/reject on this item; escalate it with decision_escalate_to_owner.`;
  }
  const suffix =
    status === 403 || status === 429
      ? " — this is beyond your delegation mandate: escalate it to the owner (decision_escalate_to_owner) instead of retrying."
      : "";
  return message + suffix;
}

/** 三条 deputy 路由：403 才是「你不是常务岗」，其余状态原样。 */
export function deputyToolErrorText(message, status) {
  return status === 403 ? deputyDeniedText(message) : message;
}

// ── 岗位身份的两个通道（fix-report-attribution-concurrency 2.2，2026-11-12 修正）──
//
// 报数归属需要的岗位坐标必须来自**服务端写入**的东西，模型改不了：
//
//   1. `args.__fleetIdentity` —— 共用卫星的现役通道。`fleet` 在
//      SHARED_SATELLITE_SERVERS 里，全 cell 只由 mcp-satellite-host 起一份 stdio
//      子进程、被所有 runtime 共用；client 配置里的 env 没有任何进程会继承
//      （2026-11-12 生产实测：三个 fleet-mcp.js 子进程的 FLEET_MCP_* 全为 0，
//      报数照旧按"唯一在飞回合"归因）。所以身份随成员私有 patch 的 `X-Fleet-*`
//      header 进来，由中继逐请求读出来塞进 tools/call；调用方自带的同名键在中继
//      那边已被剥掉。
//   2. `process.env.FLEET_MCP_*` —— 逐 runtime stdio 的形态（若 fleet 将来按设计
//      "成员级 env 的卫星必须逐 runtime 起"从共享名单里摘出去），以及单测。
