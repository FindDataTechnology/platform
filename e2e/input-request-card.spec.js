import { test, expect } from "@playwright/test";
import Database from "better-sqlite3";
import { pinLocaleEn, tempStoreDirs } from "./helpers.js";

// ── 结构化输入卡（add-input-request-cards）的线上契约，隔离上游模型运行 ──────
//
// 为什么单独一条：这条链路已经因为四个不同的原因在线上红过，每一次都长得像
// 「前端没渲染」，实际各不相同：
//   ① 聚焦 profile 把 input-request 这个 MCP 桥裁掉了（工具根本不在面上）；
//   ② 工具等人超过 harness 调用超时，被 harness 判成失败；
//   ③ 待答的卡被折进活动组，回合结束后人看不到；
//   ④ 卡片只从工具结果里取 requestId，而工具要等满等待窗口才返回——窗口内
//      卡片只能是只读的「等待填写」（2026-11-11 线上实测）。
// ④ 的修法是服务端在提卡帧上带 toolCallId，卡片据此当场认领。这条 spec 从
// store 接缝把这些形态钉住，不需要 LLM、不需要真的有人答。

let sid = null; // 运行时取自当前真实会话（见 boot）
const CALL = "call_ir_1";
const REQ = "ir_e2e_1";

const CARD = {
  type: "form",
  title: "补齐交付信息",
  detail: null,
  fields: [{ key: "nickname", kind: "text", label: "昵称", required: true }],
  actions: [],
};

const pendingFrame = (overrides = {}) => ({
  type: "input_request",
  sessionId: sid,
  request: {
    requestId: REQ,
    sessionId: sid,
    state: "pending",
    card: CARD,
    policy: { onUnattended: "escalate", ttlSec: 600, answerableBy: "owner" },
    expiresAt: Date.now() + 600_000,
    createdAt: Date.now(),
    values: null,
    answeredBy: null,
    toolCallId: CALL,
    ...overrides,
  },
});

// 回合里正在跑的那次调用：卡片靠 toolCallId 认领它（工具还没返回）。
const toolStart = () => ({
  type: "tool_start",
  toolCallId: CALL,
  name: "mcp__input-request__request_input",
  args: { card: CARD },
  sessionId: sid,
});

// 一个正在跑的助手回合：tool_start 只会往「当前助手回合」里塞块，没有回合时
// 它什么都不产生（客户端形态与在线一致——真实回合总有 agent_start 在前）。
const agentStart = () => ({ type: "agent_start", sessionId: sid });

async function boot(page) {
  await pinLocaleEn(page);
  // 问卷由 beforeAll 的库写入压掉（见上）；这里只等聊天壳就绪。
  await page.goto("/chat");
  await page.waitForFunction(() => {
    const s = window.__chatStore?.getState();
    return s && s.currentSessionId !== null;
  }, null, { timeout: 15_000 });
  await page.waitForTimeout(150);
  // 用**当前真实会话 id**发帧，不伪造会话：伪造 id 会被服务端随后的
  // session_loaded 覆盖回真实会话，而 agent_start/tool_start 是会话作用域事件，
  // 一被覆盖就全部丢弃（实测 sid 已变回 platform-…、turns 只剩 user 那条）。
  sid = await page.evaluate(() => window.__chatStore.getState().currentSessionId);
}

// 收尾的卡（已答/已取消）会被折进活动组——与既有 action-card spec 同一姿态：
// 先展开再断言。待答的卡则必须自己就在外面（groupHasPendingInput）。
async function expandActivities(page) {
  const headers = page.locator('[data-testid="activity-group"] > button');
  for (let i = 0; i < (await headers.count()); i++) {
    const group = page.locator('[data-testid="activity-group"]').nth(i);
    if ((await group.getAttribute("data-open")) !== "true") await headers.nth(i).click().catch(() => {});
  }
}

const apply = (page, msg) => page.evaluate((m) => window.__chatStore.getState().apply(m), msg);

test.beforeAll(() => {
  // 首启意向问卷由服务端判定（needsQuestionnaire = 无存储意图且无环境预设），而
  // e2e 的库每轮都是新的；auth-off 下跳过接口又没有身份（实测报 "No identity on
  // the request"），关不掉，于是问卷盖在聊天上、所有卡片断言都落空。直接把「已
  // 跳过」写进库：intentKeyFor(null) 就是不带邮箱后缀的那个键。
  const now = new Date().toISOString();
  const db = new Database(tempStoreDirs().db);
  db.prepare(
    `INSERT INTO user_preferences (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run("onboarding.intent", JSON.stringify({ roles: [], note: "", skipped: true, answeredAt: now }), now);
  db.close();
});

test.beforeEach(async ({ page }) => {
  await boot(page);
});

test("工具还没返回时卡片就能填：按 toolCallId 认领，且不必展开活动组", async ({ page }) => {
  await apply(page, agentStart());
  await apply(page, toolStart());
  await apply(page, pendingFrame());
  const card = page.getByTestId("input-request-card");
  // 不点任何东西：待答的卡必须自己可见（活动组不许把它折起来）。
  await expect(card).toBeVisible();
  await expect(card).toHaveAttribute("data-state", "pending");
  await expect(card.getByTestId("input-request-input").first()).toBeVisible();
  await expect(card.getByTestId("input-request-submit")).toBeVisible();
  // 活动组确实是展开态（这条同时钉住「不许折」）。
  await expect(page.locator('[data-testid="activity-group"]').first()).toHaveAttribute("data-open", "true");
});

test("工具返回「挂起中」之后仍然是可填的那张卡", async ({ page }) => {
  await apply(page, agentStart());
  await apply(page, toolStart());
  await apply(page, pendingFrame());
  // 等待窗口到点，工具返回 state=pending（shim 的两段式等待）。
  await apply(page, {
    type: "tool_end",
    toolCallId: CALL,
    name: "mcp__input-request__request_input",
    isError: false,
    result: JSON.stringify({ requestId: REQ, state: "pending", values: null, answeredBy: null, awaitingAnswer: true }),
  });
  const card = page.getByTestId("input-request-card");
  await expect(card).toHaveAttribute("data-state", "pending");
  await expect(card.getByTestId("input-request-input").first()).toBeVisible();
  await expect(card.getByTestId("input-request-submit")).toBeVisible();
});

test("必填校验先拦一次，填好提交后收敛成只读摘要并显示答案", async ({ page }) => {
  // 作答是浏览器发的 POST：本 spec 不写库，直接拦住并回 200。
  await page.route("**/api/input-requests/*/answer", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ state: "answered", values: { nickname: "冒烟-1" } }) }),
  );
  await apply(page, agentStart());
  await apply(page, toolStart());
  await apply(page, pendingFrame());
  const card = page.getByTestId("input-request-card");

  // 空提交：本地校验拦住，不发请求。
  await card.getByTestId("input-request-submit").click();
  await expect(card.locator('[role="alert"]')).toBeVisible();

  await card.getByTestId("input-request-input").first().fill("冒烟-1");
  await card.getByTestId("input-request-submit").click();

  // 落终态事件（答案路由作答后广播的那一条）把它收敛成只读摘要。
  await apply(page, {
    type: "input_request_settled",
    sessionId: sid,
    requestId: REQ,
    state: "answered",
    values: { nickname: "冒烟-1" },
  });
  await expect(card).toHaveAttribute("data-state", "answered");
  await expect(card).toContainText("冒烟-1");
  await expect(card.getByTestId("input-request-submit")).toHaveCount(0);
});

test("历史重放：已作答的卡直接是带值的只读摘要，取消的卡说「已取消」", async ({ page }) => {
  const replay = (state, values, id) => ({
    type: "session_loaded",
    id: sid,
    messages: [
      {
        role: "assistant",
        blocks: [
          {
            kind: "tool",
            id: `call_${id}`,
            name: "mcp__input-request__request_input",
            args: { card: CARD },
            result: JSON.stringify({ requestId: id, state, values, answeredBy: "owner@example.com" }),
            state: "done",
          },
        ],
      },
    ],
  });
  await apply(page, replay("answered", { nickname: "重放-答案" }, "ir_replay_1"));
  await expandActivities(page);
  const answered = page.getByTestId("input-request-card").filter({ hasText: "补齐交付信息" }).first();
  await expect(answered).toHaveAttribute("data-state", "answered");
  await expect(answered).toContainText("重放-答案");

  await apply(page, replay("cancelled", null, "ir_replay_2"));
  await expandActivities(page);
  await expect(page.getByTestId("input-request-card").last()).toHaveAttribute("data-state", "cancelled");
});
