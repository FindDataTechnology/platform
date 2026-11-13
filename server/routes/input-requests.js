// ── Input-request routes (add-input-request-cards) ──────────────────────────
//
// POST /api/input-requests              — 提卡（loopback 子进程或浏览器）
// GET  /api/input-requests               — 列我的待答（浏览器）
// GET  /api/input-requests/:id           — 取一张（loopback shim 断线重读）
// GET  /api/input-requests/:id/wait      — 长轮询（loopback shim）
// POST /api/input-requests/:id/answer    — 作答（owner-only）
// POST /api/input-requests/:id/cancel    — 取消（owner-only / loopback）
//
// 身份纪律照 routes/actions.js 的先例：loopback 子进程只在「提卡」这一个动词上
// 被信任其自报的 owner（子进程的 per-user profile 注入），其余动词一律按
// 登录身份判定；分享会话与匿名访问没有任何应答能力。

import { randomUUID } from "node:crypto";
import { getDb, getSessionMeta } from "../../db.js";
import * as chatHistory from "../../chat-history.js";
import { getFleetDatabase } from "./fleets-db.js";
import { checkPerTurnQuota, inputPolicyForSession } from "../fleet-input-policy.js";
import {
  InputRequestError,
  answerInputRequest as coreAnswer,
  answerPayload,
  cancelInputRequest as coreCancel,
  createInputRequest,
  expireDueInputRequests,
  getInputRequest,
  listPendingForOwner,
  listPendingForSession,
  waitForInputRequest,
} from "../input-requests.js";

const LONG_POLL_MS = 25_000;
const EXPIRY_TICK_MS = 5_000;

function normEmail(value) {
  return String(value ?? "").trim().toLowerCase();
}

function requestView(request) {
  return {
    requestId: request.id,
    sessionId: request.sessionId,
    state: request.state,
    card: request.card,
    policy: request.policy,
    expiresAt: request.expiresAt,
    createdAt: request.createdAt,
    values: request.values,
    answeredBy: request.answeredBy,
  };
}

/**
 * The escalate writer: `escalate` unattended policy lands the request in the
 * team's decision queue, reusing the lane that already has delegation, routing
 * and delivery. Returns the decision id, or null when this request has no fleet
 * to escalate into (the core then falls back to `expired`).
 */
export function escalateInputRequestToFleet(request) {
  if (!request?.fleetId) return null;
  const fdb = getFleetDatabase();
  const options = (request.card?.fields ?? [])
    .filter((f) => f.kind === "enum")
    .flatMap((f) => (f.options ?? []).map((o) => o.label));
  const id = `d_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  fdb.appendDecision({
    id,
    fleetId: request.fleetId,
    memberId: request.memberId || `${request.fleetId}::input-request`,
    question: request.card?.title || "待补输入",
    options: options.length > 0 ? options : ["已补充", "放弃"],
    severity: "normal",
    recommendation: request.card?.detail ?? null,
    sourceSessionId: request.sessionId ?? null,
    submittedAt: Date.now(),
    itemType: "input-request",
    detail: { inputRequestId: request.id, fields: (request.card?.fields ?? []).map((f) => f.key) },
    route: "owner",
    category: null,
    topicKey: `input-request:${request.id}`,
    domain: null,
  });
  return id;
}

/**
 * 会话归属（2026-11-11 线上补）：stdio 子进程不知道自己属于哪个会话——dsh 的
 * MCP 子进程是「一个 profile 一个进程」，环境里没有 DSH_SESSION_ID（实测只有
 * owner 邮箱）。于是请求落库时 session_id=null，前端拿到的卡不属于任何会话，
 * 只能按「已收尾」渲染（线上形态：卡一出现就是 Cancelled）。
 *
 * 归属由服务端在这唯一的时刻补齐：提卡这行发生在某个回合的**工具调用内**，
 * 而本 cell 里正在跑的那个（或那些）回合就在 turnStateBySession 里。只有一个
 * 候选时就是它；有多个就不猜（并发多会话的 cell），如实留空并在日志里点名，
 * 免得把别人的卡挂到错的会话上。非回环调用方（浏览器/其它服务）一律不推断：
 * 它们能自己报会话，推断只会把身份问题藏起来。
 */
function inferSessionForInternalRequest(ctx) {
  const streaming = [];
  for (const [sid, turn] of ctx.turnStateBySession ?? []) {
    if (sid && turn?.isStreaming === true) streaming.push(sid);
  }
  if (streaming.length === 1) return streaming[0];
  if (streaming.length > 1) {
    console.warn(
      `[input-requests] 提卡未报会话，本 cell 有 ${streaming.length} 个回合在跑，无法唯一归属——留空（卡片仍可在收件箱作答）`,
    );
  }
  return null;
}

/**
 * 「这张卡是哪个工具调用提的」——把卡和正在跑的 request_input 调用绑起来。
 *
 * 为什么需要它（2026-11-11 线上实测）：卡片只在**工具结果**里找得到 requestId，
 * 而工具要等满等待窗口（默认 45s）才返回。这段窗口里 result 还是空的，卡片只能
 * 渲染成只读的「等待填写」——人看着一张填不了的卡。服务端知道此刻哪个
 * request_input 调用正在跑（turn 块里 state 还没落），把它的 callId 带进帧里，
 * 客户端就能当场把卡认领成可填写的那张。
 *
 * 只在「回环子进程 + 已归属会话」时有意义：浏览器自己提的卡本来就带着会话，
 * 不需要猜。
 */
function runningInputRequestCallId(ctx, sessionId) {
  if (!sessionId) return null;
  const turn = ctx.turnStateBySession?.get(sessionId);
  const blocks = turn?.blocks ?? [];
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (!b || b.kind !== "tool") continue;
    // state 只在结束时才写（done/error）；还没写 = 正在跑。
    if (b.state) continue;
    if (String(b.name ?? "").endsWith("__request_input")) return b.id ?? null;
  }
  return null;
}

function sendError(res, err) {
  if (err instanceof InputRequestError) {
    const status =
      err.code === "not_found"
        ? 404
        : err.code === "owner_required" || err.code === "forbidden" || err.code === "policy_refused"
          ? 403
          : err.code === "quota_exceeded"
            ? 429
            : 400;
    return res.status(status).json({ error: err.code, message: err.message, details: err.details });
  }
  console.error("[input-requests] error:", err?.message || err);
  return res.status(500).json({ error: "internal error" });
}

/**
 * 回灌（design D6）：提出请求的回合还在跑时，答案由长轮询交回那个工具调用，
 * 不需要注入；回合已经结束（A2A 超时、用户先走开、后台任务）时才补一条系统
 * 消息开新回合——照拍板送达的既有做法，并带上请求标识，让模型知道这是
 * 「之前问了、现在有答案了」而不是一段无来由的指令。
 *
 * bot 会话不在这里投递：它有自己的一条文本车道（bots.js），重复注入会让
 * 同一个答案在聊天里出现两次。
 */
function deliverAnswerToSession(ctx, request) {
  const sessionId = request.sessionId;
  if (!sessionId || request.state !== "answered") return;
  if (String(sessionId).startsWith("bot-")) return;
  // 回合还开着：工具调用会自己拿到结果。判据必须是「正在推流」，不能是
  // 「表里有没有这个会话」——turnStateBySession 的条目回合结束后**不删**，只把
  // isStreaming 置 false（ws.js 的收尾就这么做），所以按条目存在判会把任何跑过
  // 回合的会话永久判成「还开着」，回灌永远不发生（2026-11-11 实测：答完之后
  // 模型再也不继续，正是这条）。
  const streaming = ctx.isStreamingFor
    ? ctx.isStreamingFor(sessionId)
    : ctx.turnStateBySession?.get(sessionId)?.isStreaming === true;
  if (streaming) return;
  // 会话必须真的存在——否则这段文本会被当成一条用户消息，塞进一个空壳会话里
  // （2026-11-11 实测：授权链路脚本用 `verify-6.2-authz` 这个不存在的 id 提卡，
  // 作答后平台凭空开了一个回合，会话列表里多出「【主人补齐了输入】」）。存在
  // 性只认两处：库里已有镜像行，或它就是当前活跃会话（刚建、还没落第一条
  // 消息）。归属也要对上：别人的会话不接受这张卡的答案。
  const meta = getSessionMeta(sessionId);
  const isLive = sessionId === chatHistory.currentSessionId();
  if (!meta && !isLive) {
    console.log(`[input-requests] 答案不投递：会话 ${sessionId} 不存在（请求 ${request.id}）`);
    return;
  }
  if (meta?.owner && request.ownerEmail && meta.owner !== request.ownerEmail) {
    console.warn(
      `[input-requests] 答案不投递：会话 ${sessionId} 属于 ${meta.owner}，请求属于 ${request.ownerEmail}`,
    );
    return;
  }
  const fields = request.card?.fields ?? [];
  const lines = fields
    .filter((f) => request.values?.[f.key] !== undefined)
    .map((f) => `- ${f.label}：${formatAnswerValue(request.values[f.key], f)}`);
  const prompt = [
    "【主人补齐了输入】你在本会话提出的结构化输入请求已经作答，请据此继续：",
    ...lines,
    `（请求 ${request.id}）`,
  ].join("\n");
  // 注入新回合照 delegation-aggregator 的既有做法：置流式位、记一条用户可见
  // 消息、写会话镜像，再交给 session.prompt。缺任一机械（单测里的最小 ctx）
  // 就安静跳过——工具结果本身已经把答案带回去了。
  const turn = ctx.turnStateFor?.(sessionId);
  if (!turn || !ctx.session?.prompt) return;
  turn.promptStopped = false;
  turn.isStreaming = true;
  turn.startedAt = Date.now();
  turn.origin = { sessionId, user: null };
  ctx.webTurnSessions?.add?.(sessionId);
  ctx.sendToViewers?.(sessionId, { type: "user", text: prompt, taskSummary: true });
  try {
    chatHistory.recordMessage(sessionId, "user", prompt, null);
  } catch (err) {
    console.error("[input-requests] mirror failed:", err?.message || err);
  }
  void ctx.session
    .prompt(prompt, sessionId)
    .catch((err) => {
      console.error("[input-requests] answer delivery failed:", err?.message || err);
      ctx.finishTurn?.(undefined, sessionId);
    });
}

function formatAnswerValue(value, field) {
  if (typeof value === "boolean") return value ? "是" : "否";
  if (field?.kind === "enum") {
    const opt = (field.options ?? []).find((o) => o.value === String(value));
    return opt ? opt.label : String(value);
  }
  return field?.unit ? `${value} ${field.unit}` : String(value);
}

export function registerInputRequestRoutes(ctx) {
  const { app } = ctx;

  app.use((req, _res, next) => {
    req.ctx = ctx;
    next();
  });

  // 断连/换设备/会话同步时的水合读（add-input-request-cards 4.3）：与
  // `questionMessage` 同一条纪律——没有待答就推空数组，客户端据此清卡。
  ctx.inputRequestMessages = (sessionId) => {
    try {
      return listPendingForSession(getDb(), sessionId).map((request) => ({
        type: "input_request",
        request: requestView(request),
        sessionId,
      }));
    } catch (err) {
      console.error("[input-requests] sync read failed:", err?.message || err);
      return [];
    }
  };

  const isInternal = (req) => Boolean(req.user?.internal);

  // ── 提卡 ──────────────────────────────────────────────────────────────────
  app.post("/api/input-requests", (req, res) => {
    try {
      const db = getDb();
      const body = req.body ?? {};
      const internal = isInternal(req);
      const ownerEmail = internal ? normEmail(body.ownerEmail) : normEmail(req.user?.email);
      if (!ownerEmail) {
        throw new InputRequestError("owner_required", "no owner identity for this request");
      }
      const sessionId = body.sessionId ?? (internal ? inferSessionForInternalRequest(ctx) : null);

      // 团队/岗位策略（design D8）：归属由服务端按会话解析，不信子进程自报。
      // 归属不到 = 没有岗位策略 = 走内核默认（与引入本能力前字节一致）。
      const { attribution, policy } = inputPolicyForSession(sessionId);
      const cardType = body.card?.type ?? "form";
      if (policy?.allowedTypes && !policy.allowedTypes.includes(cardType)) {
        throw new InputRequestError(
          "policy_refused",
          `this post may not raise '${cardType}' cards (allowed: ${policy.allowedTypes.join(", ")})`,
          { errors: [{ field: "card.type", message: "not allowed by the post's input policy" }] },
        );
      }
      const turnId = sessionId
        ? (ctx.turnStateBySession?.get(sessionId)?.currentTurnId ?? null)
        : null;
      if (policy?.perTurnQuota) {
        const quota = checkPerTurnQuota(db, { sessionId, turnId, quota: policy.perTurnQuota });
        if (!quota.ok) {
          throw new InputRequestError(
            "quota_exceeded",
            `this turn already raised ${quota.used} input request(s) (limit ${quota.quota})`,
            { quota },
          );
        }
      }

      // 调用方声明的策略优先；没声明的字段由岗位策略补，再没就用内核默认。
      const declared = body.policy && typeof body.policy === "object" ? body.policy : {};
      const effectivePolicy = {
        ...(policy?.onUnattended && declared.onUnattended === undefined
          ? { onUnattended: policy.onUnattended }
          : {}),
        ...(policy?.timeoutSec && declared.ttlSec === undefined ? { ttlSec: policy.timeoutSec } : {}),
        ...(policy?.answerableBy && declared.answerableBy === undefined
          ? { answerableBy: policy.answerableBy }
          : {}),
        ...declared,
      };

      const request = createInputRequest(db, {
        id: `ir_${Date.now()}_${randomUUID().slice(0, 8)}`,
        ownerEmail,
        sessionId,
        fleetId: body.fleetId ?? attribution?.fleetId ?? null,
        memberId: body.memberId ?? attribution?.memberId ?? null,
        turnId,
        card: body.card,
        policy: Object.keys(effectivePolicy).length > 0 ? effectivePolicy : null,
      });
      // 工具调用关联（见 runningInputRequestCallId）：只走帧，不落库——它是
      // 这一次调用的运行时事实，不是请求的属性。
      const toolCallId = internal ? runningInputRequestCallId(ctx, request.sessionId) : null;
      const view = { ...requestView(request), ...(toolCallId ? { toolCallId } : {}) };
      ctx.sendToViewers?.(request.sessionId, { type: "input_request", request: view });
      // bot 聊天没有可渲染的卡片：同一次提卡顺带摊成编号问答（4.5）。没有
      // 对应聊天就什么都不做——行仍然可以在 web 上被答。
      if (request.sessionId) void ctx.deliverInputRequest?.(request.sessionId, view);
      res.status(201).json(view);
    } catch (err) {
      sendError(res, err);
    }
  });

  // ── 列我的待答 ────────────────────────────────────────────────────────────
  app.get("/api/input-requests", (req, res) => {
    try {
      const owner = normEmail(req.user?.email);
      if (!owner) return res.status(403).json({ error: "forbidden" });
      const list = listPendingForOwner(getDb(), owner, {
        sessionId: req.query.sessionId ?? null,
        limit: req.query.limit,
      });
      res.json({ requests: list.map(requestView) });
    } catch (err) {
      sendError(res, err);
    }
  });

  // ── 取一张 / 长轮询 ───────────────────────────────────────────────────────
  app.get("/api/input-requests/:id", (req, res) => {
    try {
      const db = getDb();
      const request = getInputRequest(db, req.params.id);
      if (!request) return res.status(404).json({ error: "not_found" });
      if (!isInternal(req) && normEmail(req.user?.email) !== request.ownerEmail) {
        return res.status(403).json({ error: "forbidden" });
      }
      res.json(requestView(request));
    } catch (err) {
      sendError(res, err);
    }
  });

  app.get("/api/input-requests/:id/wait", async (req, res) => {
    try {
      const db = getDb();
      const current = getInputRequest(db, req.params.id);
      if (!current) return res.status(404).json({ error: "not_found" });
      if (!isInternal(req) && normEmail(req.user?.email) !== current.ownerEmail) {
        return res.status(403).json({ error: "forbidden" });
      }
      const timeout = Math.min(
        LONG_POLL_MS,
        Math.max(1000, Number(req.query.timeoutMs) || LONG_POLL_MS),
      );
      const settled = await waitForInputRequest(db, current.id, { timeoutMs: timeout });
      if (!settled) {
        // 没结果不等于失败：客户端据此续等（design D1 的降级路径）。
        return res.json({ pending: true, nextLongPollAfter: 0, requestId: current.id });
      }
      res.json(answerPayload(settled));
    } catch (err) {
      sendError(res, err);
    }
  });

  // ── 作答 ──────────────────────────────────────────────────────────────────
  app.post("/api/input-requests/:id/answer", (req, res) => {
    try {
      const db = getDb();
      const request = getInputRequest(db, req.params.id);
      if (!request) return res.status(404).json({ error: "not_found" });
      // 分享会话 / 匿名 / 他人一律拒绝：只有本请求的归属用户能答。
      const actor = normEmail(req.user?.email);
      if (!actor || isInternal(req)) return res.status(403).json({ error: "forbidden" });
      if (request.policy?.answerableBy !== "any" && actor !== request.ownerEmail) {
        return res.status(403).json({ error: "forbidden" });
      }
      const { request: updated, changed, reason } = coreAnswer(db, request.id, {
        values: req.body?.values,
        answeredBy: actor,
      });
      if (!changed) {
        return res.status(409).json({ error: reason ?? "already_settled", request: requestView(updated) });
      }
      ctx.sendToViewers?.(updated.sessionId, {
        type: "input_request_settled",
        requestId: updated.id,
        state: updated.state,
        values: updated.values,
      });
      deliverAnswerToSession(ctx, updated);
      res.json(answerPayload(updated));
    } catch (err) {
      sendError(res, err);
    }
  });

  // ── 取消 ──────────────────────────────────────────────────────────────────
  app.post("/api/input-requests/:id/cancel", (req, res) => {
    try {
      const db = getDb();
      const request = getInputRequest(db, req.params.id);
      if (!request) return res.status(404).json({ error: "not_found" });
      if (!isInternal(req) && normEmail(req.user?.email) !== request.ownerEmail) {
        return res.status(403).json({ error: "forbidden" });
      }
      const { request: updated, changed, reason } = coreCancel(db, request.id);
      if (!changed) {
        return res.status(409).json({ error: reason ?? "already_settled", request: requestView(updated) });
      }
      ctx.sendToViewers?.(updated.sessionId, {
        type: "input_request_settled",
        requestId: updated.id,
        state: updated.state,
        values: null,
      });
      res.json(answerPayload(updated));
    } catch (err) {
      sendError(res, err);
    }
  });
}

/**
 * The TTL sweeper. Ten seconds of jitter is enough: a request that expired a few
 * seconds ago is still answerable until this runs, which is the fail-open side
 * we want (a human arriving a moment late still gets to answer).
 */
export function startInputRequestExpiryJob(ctx) {
  const timer = setInterval(() => {
    try {
      const settled = expireDueInputRequests(getDb(), { escalate: escalateInputRequestToFleet });
      for (const request of settled) {
        ctx.sendToViewers?.(request.sessionId, {
          type: "input_request_settled",
          requestId: request.id,
          state: request.state,
          values: request.values,
        });
      }
    } catch (err) {
      console.error("[input-requests] expiry tick failed:", err?.message || err);
    }
  }, EXPIRY_TICK_MS);
  timer.unref?.();
  return timer;
}
