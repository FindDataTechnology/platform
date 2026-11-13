# Design: add-wanxing-serving-api

## Context

ADR-0014 定案：对外唯一入口是萬星门面（平台自有），调用者凭自有 sub2api key 进门，钱在边界结算。现状可复用资产：

- `lib/sub2api-admin.js`：`probeKeyLiveness`（GET /v1models 零成本跑完整计费门）、`findUserByKey`（key→用户解析）、`adjustBalance`（幂等头余额调整）——验钥与结算零新端点。
- `server/a2a-client.js`：双凭据（registry 服务凭据 X-Authorization + backend token Authorization）转发 `message/send`/`message/stream`——平台部署时即持有两凭据。
- `gateway/packs.js`：部署注册表（SQLite `packs.db`，`deployment_keys`/`sub2api_accounts` 同库）、路由注册模式 `registerPackRoutes(app, ctx)`、registry 条目可见性/paused 状态。
- `agent-runner`：`context_id`↔会话 1:1（`child.js sessionKeyFor`）、child 级 `lastActivityAt`、60s 轮询主循环（`index.js`）。
- fd-prod 为单进程 gateway——facade 进程内单实例即可，分布式锁/多副本一致性不在本变更范围。

## Goals / Non-Goals

**Goals**：A2A 原生对外面（目录/卡片/send/stream）；调用键认证+短缓存；可见性+允许清单准入；幂等去重；并发=1+RPM 限流；门面计量账本+按时长边界结算+欠费停用；runner 外部 context 24h 空闲回收；billing board 调用者维度。

**Non-Goals**：套餐档位表与模型车道（add-serving-plans）；回合预算与硬停（add-serving-budgets）；部署密钥通道（add-deployment-secrets）；agent 通知（add-agent-notifications）；REST 糖面、registry fork 改动（均 ADR-0014 否决）；OpenAI 兼容面（backlog）。

## Decisions

### D1 模块落点

新文件 `gateway/wanxing.js`，导出 `registerWanxingRoutes(app, ctx)`，由 `gateway/index.js` 挂载——与 packs/share/mp-auth 同模式。存储同库 `packs.db`（新表见 D8），复用 `ctx` 里的 sub2api client、registry bridge、a2a 转发器。协议无关内核（认证/准入/限流/幂等/计量/结算）与 A2A 面分层：`gateway/wanxing/core.js`（内核，不含 a2a 词汇）+ `gateway/wanxing/a2a.js`（协议面）。将来 OpenAI 兼容面=再加一个协议文件，内核零改动（ADR-0014 约束）。

### D2 路由与 agent slug

```
GET  /api/wanxing/v1/agents                                  # 公开目录（仅 public agent）
GET  /api/wanxing/v1/a2a/:agentSlug/.well-known/agent-card.json  # 公开卡片
POST /api/wanxing/v1/a2a/:agentSlug                           # JSON-RPC send / stream
```

`agentSlug = lower(`${packId}-${agentId}`)`，点号→dash（dsh presetId 禁点先例；pack id 为大小写混合 base64url）。部署注册表建 slug→(packId, agentId) 索引；条目不存在/已下线→明确 404 结构化错误。

### D3 认证管线（协议无关）

`Authorization: Bearer sk-…` → 内存缓存查 `sha256(key)`（TTL 60s，负结果 TTL 15s）→ miss 时并行 `probeKeyLiveness`（余额/组/配额门）+ `findUserByKey`（身份）→ 调用者记录 `{userId, email}`。挂起状态（D9）优先于探针。无 sub2api admin key（degraded）时整面拒绝服务（fail-closed，与部署计费门同哲学）。key 全程脱敏：日志/账本/错误只留尾四位。

### D4 准入

registry 条目可见性 public→放行；private→查 `wanxing_agent_callers(agent_slug, sub2api_user_id)` 允许清单（部署者在 packs 部署面管理，增删 sub2api 账号邮箱）。paused→映射 registry 的 paused 标记为显式 JSON-RPC 错误（复用 runner「已暂停非超时」语义）。

### D5 转发与会话派生

复用 `server/a2a-client.js`：send 同步透传终态；stream 以 SSE 管道透传，`done`/`error` 事件关闭计量。调用者带 `context_id` 则原样透传；未带则派生 `wx:<idemKeyHash前16>`——`wx:` 前缀即外部命名空间（runner 回收按此识别，D10）。不注入任何协议私货（深度头原样、X-Delegation-Depth 由下游 runner 裁决）。

### D6 幂等

表 `wanxing_requests(idem_key, caller_user_id, agent_slug, state, response_json, created_at)`，作用域 (caller, agent, key)，重放窗 24h。`message/stream` 不参与幂等（流重放无意义，文档声明）。并发同键：单进程内存 single-flight（fd-prod 单进程前提），后到者等待先到者终态后回放同一结果。未带 Idempotency-Key 的 send 照常执行但不重放（协议可选头）。

### D7 限流

内核内存态：`(caller, agent)→inflight` 槽位（占用即拒，`Retry-After` 秒级回传）+ 每 caller 跨 agent 令牌桶 RPM（默认 30/min，env 可调）。无持久化——限流是防滥用兜底，财务硬顶在 sub2api 键窗口。

### D8 计量账本与结算

表 `wanxing_usage(id, caller_user_id, caller_email, agent_slug, idem_key, started_at, ended_at, duration_ms, outcome, minutes_billed, rate_usd, settlement_status, settled_at)`——外部用量 v1 权威账。回合终态即结算：`minutes = ceil(duration_ms/60000)`，`amount = minutes × WANXING_RATE_PER_MIN`（平台级默认价，env；add-serving-plans 到位后换档位表），`adjustBalance({userId, amount, idempotencyKey: usage.id})`。**扣减方向已实测**（2026-10-03，scripts/probe-wanxing-settle.mjs，净零往返）：负数 `add` 被 400 拒（UpdateBalanceRequest 校验），**`operation:"subtract"` 正数即扣减**——结算管线已按此实现。另两项实施期决定：账本落在 **wanxing.db 独立库**（与 packs.db 同目录同隔离规则，避免同库双连接写争用）；**失败回合记账但免计费**（outcome=error → settlement_status='waived'，调用者不为他方故障买单，ledger 仍可查）。stream 回合以 SSE 关闭时刻计时长，同样走结算。

### D9 欠费停用

表 `wanxing_caller_state(user_id, consecutive_failures, suspended_reason, updated_at)`。结算失败退避重试（进程内队列+重启后由 `settlement_status='pending'` 行驱动补结）；连续失败≥阈值或探针报余额不足→挂起，进门即拒（payment-required 结构化错误）；下次探针通过即自动解除并清零。

### D10 runner 外部会话回收

`agent-runner`：child 会话粒度 last-activity 记录（现有 child 级 `lastActivityAt` 细化）+ 60s 主循环里加回收趟：外部命名空间（`wx:` 前缀 context）空闲超 `AGENT_RUNNER_EXTERNAL_CONTEXT_TTL`（默认 24h）即删会话存储；rhythm 日会话与内部会话不扫。删除走 bridge 会话删除 API，无则直删私有 home 下会话存储目录（适配层内操作）。回收后同 context 再来=新会话（既有 fresh-context 语义）。

### D11 运营面

`GET /api/packs/billing/board` 扩展：外部用量按 caller、按 agent 两视图（pending settlement 高亮）；`/api/packs/billing/me` 不动（部署者语义）。

## Risks / Open Items

- **扣减方向实测**（D8）：live fork 上验证负数 add 或补 deduct operation——实施第 1 步先探。
- **SSE 透传时长**：长回合（分钟级）经单进程 gateway 的连接占用；与既有 web-chat SSE 同量级，先不做专门超时，观察后再说（回合预算硬停属 C1）。
- **registry 服务凭据轮换**：facade 依赖平台持有的转发凭据，沿用现有轮换机制（rollout 即修），无新增面。
- **e2e**：staging 先行（现有 probe 脚本模式），覆盖：公开卡/目录、键门拒绝、允许清单、幂等重放、并发拒绝、结算落账、24h 回收（TTL 调短验证）。
