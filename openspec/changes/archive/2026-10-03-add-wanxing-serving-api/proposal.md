# Proposal: add-wanxing-serving-api

## Why

首个对外产品案例（finddata 爬虫自愈 agent，外部账号按需调用已部署 Agent 服务）需要一条对外服务通道；现状唯一入口是 registry 网关双凭据（registry 凭据 + 全部署共享的 backend token）——共享密钥不可外发、无按调用者计量，ADR-0011 的 day-one「部署者全包」无法对外售卖。ADR-0014 已定案：对外唯一入口是平台自有的萬星门面，调用者凭自有 sub2api key（调用键）进门，钱在边界结算。

## What Changes

- 新增**萬星门面**（paas gateway 进程内），对外唯一入口，registry 零参与：
  - **A2A 原生协议面（v1 唯一线协议）**：`GET /api/wanxing/v1/agents` 公开目录；`GET /api/wanxing/v1/a2a/{agentId}/.well-known/agent-card.json` 公开卡片；`POST /api/wanxing/v1/a2a/{agentId}/` 接 JSON-RPC `message/send`（同步）与 `message/stream`（SSE 透传）。
  - **协议无关内核**：调用键认证（`Authorization: Bearer sk-…`，复用零成本探针跑完整计费门 + findUserByKey 解身份 + 短缓存；调用键止步门面）；agent 准入（复用部署可见性 public/private，private 增每 agent 调用者允许清单，部署者在 packs 界面管理）；限流（每（调用者, agent）并发回合 = 1，外加 RPM 兜底）；幂等（`Idempotency-Key` 头，协议无关）。
  - **边界结算**：agent 始终跑部署键；门面按（调用者, agent, 请求, 时长）计量，回合结束即时向调用键结算（分钟向上取整 × 平台侧单价；v1 经 adjustBalance+幂等头扣减，门面计量表为权威账本；结算失败重试，连续失败/余额击穿即欠费停用——下回合进门即拒）。
  - **外部会话生命周期**：外部调用每请求独立 context（facade 从幂等键/请求派生），runner 侧 24h 空闲回收；agent 跨请求状态一律走其自有文件（inbox 模式，pack 作者范式）。
  - **运营面**：billing board 增调用者维度视图。
- 内部调用者（网页聊天、委派）走 registry 原路，**双轨不动**：同一 agent 内部=部署者全包、外部=按量结算。

**非目标**：套餐档位表/模型车道（后续 add-serving-plans）；回合预算与硬停（add-serving-budgets）；部署密钥通道（add-deployment-secrets）；agent 通知（add-agent-notifications）；爬虫自愈 pack 本体（spider-heal-pack）；REST 糖面（ADR-0014 已否决）；registry fork 任何改动（ADR-0014 已否决）。

**记录的假设**：v1 结算单价为平台级默认配置值（部署级可覆盖），add-serving-plans 引入 plan 表后取代；`agentId` 取部署条目的稳定 slug（packId-agentId 规范化）。

## Capabilities

### New Capabilities

- `wanxing-facade`: 萬星对外服务门面——调用键认证、agent 准入（可见性+允许清单）、限流与并发、幂等、A2A 协议面、调用者计量与边界结算、公开发现（目录/卡片）。

### Modified Capabilities

- `platform-billing`: 新增调用者结算语义——边界结算、门面计量账本（v1 权威）、欠费停用；与既有部署者键流（粘贴/校验/绑定/计量）并存成双轨。
- `agent-runner`: 新增外部会话生命周期要求——facade 派生的外部 context 24h 空闲回收，不触碰 rhythm 日会话与内部会话。

## Impact

- **代码**：gateway 新增 wanxing 路由模块（目录/卡片/a2a 转发/认证/限流/幂等/计量/结算）；转发复用 `server/a2a-client.js`（平台已持 registry 服务凭据+backend token）；agent-runner 会话回收小改；ops billing board 扩展。
- **存储**：新增调用者计量/结算表与每 agent 允许清单存储（与 deployment_keys 同库）。
- **依赖**：sub2api 既有 admin API（probeKeyLiveness/findUserByKey/adjustBalance）零新端点即可运行；虚拟用量端点为后续替换项，非阻塞。
- **契约**：finddata 对接面 = a2a JSON-RPC + `Idempotency-Key`；ADR-0014 首次落地。
- **安全**：调用键全程脱敏（日志/审计至多尾四位）；新路由面有意对公网可达，凭调用键认证+限流守门。
