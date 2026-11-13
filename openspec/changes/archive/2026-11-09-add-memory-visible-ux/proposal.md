# Proposal: add-memory-visible-ux

## Why

A 线（`add-platform-guaranteed-capture`）已让壹座五表面的每回合都有平台担保的 L0 落底，fd-memory 的 digest 也在每回合注入 prompt——但**用户全程看不见**：ChatPage 零记忆痕迹、`/memory` 是功能列表而非第二大脑叙事、智语房间对「这个房间记住了什么」无任何呈现。「越用越懂你」是壹座对用户的核心承诺，承诺必须可见、可校、可纠——记忆不可见=承诺不存在。

## What Changes

- **chat 开场记忆卡（「我记得…」）**：会话打开时，服务端以该 owner 根的 digest（空 query 形态=最近 handoffs+L2+notes）经 WS 事件 `memory_recall` 回显给该 session 的 viewers，ChatPage 在消息流顶部渲染可折叠「开场记忆」卡（行级摘要即 fd-memory 既有预算渲染，不做第二套渲染）；每行带出处（harness 徽标已有语义），卡尾链到 `/memory` 纠错。降级开放：digest 失败/为空=无卡；`CELL_MEMORY_RECALL_UI=0` 全关。注入契约不变：digest 依旧只进 prompt，回显是旁路只读副本
- **`/memory` 第二大脑仪表盘**：面板顶部新增本周节奏条（本周捕获 L0 条数/写 note 数/更正数/待晋升数——counts 走既有 `/api/memory/entries` 聚合，不新造查询语言）+ 时间线视图（按时间倒序的叙述流：回合捕获与 note/L2 混排，harness 徽标区分来源）；既有浏览/筛选/纠错/晋升面零改动
- **智语房间记忆面板（房主可见）**：房间页房主侧新增「这个房间记住了什么」折叠区——房主根 `room-<id>` project 的记忆条目（走既有 entries 代理，`project` 参数化），成员与访客不可见（与捕获的房间域归属一致）
- **Non-goals**：线程 C（状态层合一：会话史→L0、文档→分层知识）另立；per-turn「记忆 +1」徽标（噪音风险，v1 不做）；fd-memory 侧零改动（全部消费既有读面）

## Capabilities

### New Capabilities

- `memory-recall-card`: chat 开场记忆回显——WS `memory_recall` 事件（session open 时 owner 根 digest 空 query 形态）、ChatPage 可折叠卡片（fd-memory 渲染直出+出处徽标+纠错链接）、回滚杆、降级开放（失败=无卡）、注入契约不变（旁路只读副本）

### Modified Capabilities

- `memory-portal-ui`: 面板新增本周节奏条与时间线视图（owner u/ 面的需求扩格）；房间记忆面板（房主可见，room-<id> project 参数化）作为独立需求加入

## Impact

- 代码：`server/ws.js`（session open 处 digest 读+WS 回显，复用 `chatMemoryBlockFor`）；`server/routes/memory.js`（entries 代理 project 参数化）；`web/src/pages/ChatPage.tsx`（开场卡组件）；`web/src/pages/MemoryPage.tsx`（节奏条+时间线）；`web/src/pages/ZhiyuRoomPage.tsx`（房主房间记忆区）；locale 五语
- 依赖：零新增（digest 读走 SDK 既有 `chatMemoryBlockFor`；entries 走既有代理面）
- 风险：session open 多一次 fd-memory 出站读（有界超时+降级=无卡，不阻塞打开）；digest 块直接渲染给用户——fd-memory 渲染已含预算纪律与标题帽，无原始 transcript 泄漏（L0 叙事为过程摘要）
- 测试：WS 回显事件形状/降级/回滚杆；节奏条聚合口径；房间面板 project 参数与权限；ChatPage 渲染冒烟
