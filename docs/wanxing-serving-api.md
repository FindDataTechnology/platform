# 萬星对外服务 API — finddata 对接一页纸

> 对应 openspec change `add-wanxing-serving-api`；ADR-0014（萬星门面 / 调用键即 API key / 边界结算）。
> 面向以外部账号调用已部署 Agent 服务的集成方（首个客户：finddata 爬虫自愈）。

## 速览

| 项 | 值 |
|---|---|
| 协议 | A2A 原生（JSON-RPC 2.0 over HTTP，`message/send` 同步 / `message/stream` SSE） |
| 鉴权 | `Authorization: Bearer <你的 sub2api key>`（sk-…，面板自铸） |
| 幂等 | `Idempotency-Key` 请求头（仅 `message/send`；24h 重放窗） |
| 计费 | 按时长，分钟向上取整 × 档位单价；回合结束即时结算到你的 key |
| 限流 | 每（调用者, agent）并发回合=1（超发返回 409+`Retry-After`）；调用者级 RPM |
| 会话 | 不带 `context_id` 时每请求独立（外部会话 24h 空闲回收）；跨请求状态请走 agent 自有文件（工单 inbox 约定） |

## 路由

```
GET  {BASE}/api/wanxing/v1/agents                                  # 公开目录（仅 public agent）
GET  {BASE}/api/wanxing/v1/a2a/{agentSlug}/.well-known/agent-card.json   # 公开 AgentCard
POST {BASE}/api/wanxing/v1/a2a/{agentSlug}                          # A2A 回合（需鉴权）
```

`{BASE}` 为平台部署域名（fd 环境即 `https://platform.finddatatech.cloud` 类）。`agentSlug` 见目录返回（形如 `packs-<packId>-<agentId>`，全小写）。

## 调用示例（message/send）

```bash
curl -X POST "$BASE/api/wanxing/v1/a2a/packs-XXXX-heal" \
  -H "Authorization: Bearer sk-xxxx" \
  -H "Idempotency-Key: fd-20261003-001" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0", "id": 1,
    "method": "message/send",
    "params": { "message": {
      "role": "user",
      "parts": [{ "kind": "text", "text": "SUBMIT fd-industry-data reports/health-tickets/2026-10-03-x.yaml" }]
    }}
  }'
```

同步返回的是**回执**（agent 的即时答复，如 `queued`），不是工单结果——长活发生在 agent 的回合里。查询状态=再发一条消息：`STATUS fd-20261003-001`（工单型 agent 的约定动词，见其 AgentCard/skill 文档；这是 agent 级约定，不是平台协议）。

`message/stream` 请求体同形，响应为 SSE（`delta`/`message`/`done`/`error` 事件透传）。

## 错误码

| HTTP | code | 含义 |
|---|---|---|
| 401 | `INVALID_KEY` / `UNRESOLVED_KEY` | 键形状错 / 键无法解析到账号 |
| 402 | `INSUFFICIENT_BALANCE` | 键余额/窗口不足（sub2api 计费门拒绝） |
| 402 | `CALLER_SUSPENDED` | 结算连续失败被挂起；充值恢复后自动解除 |
| 403 | `CALLER_NOT_AUTHORIZED` | 私有 agent 且你不在其允许清单 |
| 404 | `AGENT_NOT_FOUND` | 无此部署条目 |
| 409 | `TURN_IN_FLIGHT` | 该（调用者,agent）已有回合在跑；按 `Retry-After` 重试 |
| 423 | `AGENT_PAUSED` | agent 已暂停（显式状态，非超时） |
| 429 | `RATE_LIMITED` | 超过调用者 RPM |
| 503 | `WANXING_BILLING_UNAVAILABLE` | 平台计费面未配置（fail-closed） |

JSON-RPC 层错误（请求已是合法 JSON 时）走 `-32600`（非法请求）/`-32601`（方法不存在）/`-32604`（空消息）/`-32032`（上游回合失败）。

## 幂等与去重语义

- `Idempotency-Key` 作用域=（调用者, agent, key），24h 重放窗：同键重放返回**首次的完整应答**，不跑第二个回合、不产生第二条计费。
- 并发同键：只有一个回合执行，两个请求拿到同一结果。
- 工单去重的第二层在 agent 侧（inbox 里已见工单路径→只回执不重复入队）——两层各管各的，platform 不理解工单。

## 计费说明（重要）

- agent 回合实际消耗由部署者承担，平台按「时长×单价」向**你的键**结算——与 token 用量无关，单价见套餐（v1 为平台默认价）。
- 失败回合（平台侧/上游错误）**不计费**，但会记账（ledger 可查）。
- 每（调用者,agent）并发=1 + RPM 之外，财务硬顶=你的 key 自身的 sub2api 消费窗与余额。

## 运营接口（平台侧）

- 允许清单：`GET/POST/DELETE /api/packs/{packId}/deployments/{agentId}/callers`（部署者/创作者权限，加邮箱）。
- 用量视图：`GET /api/wanxing/v1/ops/usage`（admin 或 runner 服务凭据）——按调用者/按 agent 两维，pending settlement 高亮。

## 部署/升级/回滚

Agent 的部署面不变：`POST /api/packs/:id/versions/:version/deploy`（幂等，per (pack,agent) upsert）；升级=同接口重部署（runner 原地 drain）；回滚=部署旧版本号。暂停/恢复：`POST .../deployments/:agentId/pause|resume`。
