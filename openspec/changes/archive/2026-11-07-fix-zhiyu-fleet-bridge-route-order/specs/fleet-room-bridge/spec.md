## ADDED Requirements

### Requirement: 团队订阅与召唤端点在平台网关完整装配下可达

平台网关 SHALL 保证 `fleet-room-bridge` 的四条端点在**生产装配序列**下可达：`GET /api/zhiyu/rooms/:id/fleet-subscriptions`、`POST /api/zhiyu/rooms/:id/fleet-subscriptions`、`DELETE /api/zhiyu/rooms/:id/fleet-subscriptions/:subId`、`POST /api/zhiyu/rooms/:id/fleet-summon`。这些端点 SHALL NOT 被任何更早注册的 `/api/zhiyu/*` 前缀级兜底路由拦截；对合法主办/成员与自有团队的请求 SHALL 进入桥的既有所有权与成员闸逻辑，而不是返回 404。同时，未被任何 zhiyu 路由匹配的 `/api/zhiyu/*` 请求 SHALL 仍以同形 `404 {"error":"not found"}` 收口，MUST NOT 落到 cell 代理而由同名路由以不同语义应答。

#### Scenario: 按生产顺序装配后订阅端点不再 404

- **WHEN** 网关按「房间内核 → IM 桥 → 团队订阅桥 → 前缀兜底」的顺序完成装配，且一位空间主办对自有现役团队发起订阅
- **THEN** `POST /api/zhiyu/rooms/:id/fleet-subscriptions` 不返回 404，而是按既有所有权闸返回订阅成功（201）或可读的拒绝原因

#### Scenario: 按生产顺序装配后召唤计划可读

- **WHEN** 同一装配下主办对自有现役团队发起 `POST /api/zhiyu/rooms/:id/fleet-summon`（含 dryRun 计划请求）
- **THEN** 响应不返回 404，返回含 `summonable` 与 `cockpitOnly` 的计划或执行结果

#### Scenario: 兜底仍挡住未匹配路径

- **WHEN** 任意客户端请求一个未被任何 zhiyu 路由匹配的 `/api/zhiyu/*` 路径
- **THEN** 响应为 `404 {"error":"not found"}`，且不转发到用户 cell

#### Scenario: 装配顺序回归被测试捕获

- **WHEN** 有人把前缀兜底重新移到团队订阅桥之前注册
- **THEN** 按生产装配顺序编写的集成测试失败，提示桥端点不可达
