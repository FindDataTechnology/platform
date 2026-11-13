// Unit tests for the chat store's input-request slice (add-input-request-cards,
// task 4.3): `input_request` 收下待答卡（按 requestId 去重、幂等重推），
// `input_request_settled` 摘掉它，会话切换清空，非 pending 的卡不收。
//
// 与 test-chat-store-question.mjs 同一套手法：直接加载真实 store 模块。

import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (err) {
      if (specifier.startsWith(".") && !/\.[cm]?[jt]s$/.test(specifier)) {
        return nextResolve(`${specifier}.ts`, context);
      }
      throw err;
    }
  },
});

const { useChatStore } = await import("../packages/core/src/store/chat-store.ts");

function reset() {
  useChatStore.setState({
    status: "connected",
    sessions: [],
    currentSessionId: null,
    turns: [],
    pendingSession: null,
    pendingNewSession: false,
    optimisticSessions: false,
    sessionSwitchBackup: null,
    sessionCache: new Map(),
    isStreaming: false,
    todos: [],
    todoCounts: { pending: 0, inProgress: 0, completed: 0 },
    pendingQuestion: null,
    pendingInputRequests: {},
    settledInputRequests: {},
    suppressed: false,
  });
}

const apply = (m) => useChatStore.getState().apply(m);
const state = () => useChatStore.getState();

const CARD = {
  type: "form",
  title: "补齐交付信息",
  fields: [{ key: "customer", kind: "text", required: true }],
};

const REQUEST = {
  requestId: "ir_1",
  sessionId: "s-1",
  state: "pending",
  card: CARD,
  expiresAt: Date.now() + 600000,
  createdAt: Date.now(),
};

test("input_request 收下待答卡", () => {
  reset();
  apply({ type: "input_request", request: REQUEST });
  assert.deepEqual(state().pendingInputRequests.ir_1, REQUEST);
});

test("重复推送幂等（重连水合与实时广播同形）", () => {
  reset();
  apply({ type: "input_request", request: REQUEST });
  apply({ type: "input_request", request: { ...REQUEST } });
  assert.equal(Object.keys(state().pendingInputRequests).length, 1);
});

test("落终态后从投影里摘掉", () => {
  reset();
  apply({ type: "input_request", request: REQUEST });
  apply({ type: "input_request_settled", requestId: "ir_1", state: "answered" });
  assert.equal(state().pendingInputRequests.ir_1, undefined);

  // 未知 id 的 settled 不制造空键
  apply({ type: "input_request_settled", requestId: "ir_nope", state: "answered" });
  assert.deepEqual(state().pendingInputRequests, {});
});

test("落终态同时把终态与答案记进 settled 投影（工具可能先返回挂起中）", () => {
  reset();
  apply({ type: "input_request", request: REQUEST });
  // 工具在人填之前就返回了（harness 调用超时），答案之后才到——卡片显示结局
  // 只能靠这条事件。
  apply({
    type: "input_request_settled",
    requestId: "ir_1",
    state: "answered",
    values: { nickname: "冒烟-123" },
  });
  assert.deepEqual(state().settledInputRequests.ir_1, {
    state: "answered",
    values: { nickname: "冒烟-123" },
    // 卡片在工具返回前没有 requestId，靠这条把终态领回去（2026-11-11 e2e 实测）。
    toolCallId: undefined,
  });
  // 会话切换要一并清掉：settled 是「本视图的投影」，不是跨会话的历史。
  reset();
  assert.deepEqual(state().settledInputRequests, {});
});

test("非 pending 的卡不进投影", () => {
  reset();
  apply({ type: "input_request", request: { ...REQUEST, state: "expired" } });
  assert.deepEqual(state().pendingInputRequests, {});
});

test("多张卡并存，各自按 id 收敛", () => {
  reset();
  apply({ type: "input_request", request: REQUEST });
  apply({ type: "input_request", request: { ...REQUEST, requestId: "ir_2", card: { ...CARD, title: "第二张" } } });
  assert.equal(Object.keys(state().pendingInputRequests).length, 2);
  apply({ type: "input_request_settled", requestId: "ir_1", state: "answered" });
  assert.deepEqual(Object.keys(state().pendingInputRequests), ["ir_2"]);
});

test("会话切换清空投影（新会话从服务器水合）", () => {
  reset();
  apply({ type: "input_request", request: REQUEST });
  assert.equal(Object.keys(state().pendingInputRequests).length, 1);
  apply({ type: "session_loaded", id: "s-2", messages: [], totalTurns: 0 });
  assert.deepEqual(state().pendingInputRequests, {});
});

test("同一会话的 session_loaded 不清待答投影（线上：卡退化成只读的真因）", () => {
  // session_loaded 不只在换会话时发：回合起止、断连重同步都会发同一条。原来
  // 无条件清空 → 刚推来的卡被抹掉，卡片退化成只读的「等待填写」（2026-11-11
  // 线上实测：卡片 pending 却没有输入框与提交键）。
  reset();
  // 真实形态：客户端已经在这个会话里（currentSessionId 已指向它），卡是按会话推来的。
  useChatStore.setState({ currentSessionId: "s-1" });
  apply({ type: "input_request", request: REQUEST });
  apply({ type: "session_loaded", id: "s-1", messages: [], totalTurns: 0, running: true });
  assert.deepEqual(Object.keys(state().pendingInputRequests), ["ir_1"], "同会话重同步保留");
  apply({ type: "session_loaded", id: "s-1", messages: [], totalTurns: 0, running: false });
  assert.deepEqual(Object.keys(state().pendingInputRequests), ["ir_1"], "回合结束的重载也保留");
});
