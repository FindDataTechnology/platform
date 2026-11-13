# Tasks — add-memory-visible-ux

> 执行约定：2/3/4 三块可并行子代理（互不写同一文件）；1 是 2 的前置；5 收口归主代理。

## 1. 回显通道（服务端）

- [x] 1.1 `server/ws.js` 会话打开路径接 `chatMemoryBlockFor(ownerEmail, "", env)`（空 query digest）+ `sendToViewers(sid, {type:"memory_recall", sessionId, block})`；`CELL_MEMORY_RECALL_UI=0` 或空块跳过；fire-and-forget 不阻塞打开
- [x] 1.2 测试：有记忆回显事件形状（block 原文直出）；无记忆/不可达无事件；回滚杆零读零事件；session viewers 定向（他 session 不收）

## 2. ChatPage 开场卡

- [x] 2.1 WS `memory_recall` 事件接入 + `MemoryRecallCard` 组件（默认折叠首行摘要、展开直出 block、`（来自 xxx）` 保留、卡尾 /memory 链接、旧会话零渲染）
- [x] 2.2 测试：卡片渲染/折叠/入口；无事件旧会话不渲染；prompt 组装零改动断言（tap 开关对照由 1.2 覆盖）
- [x] 2.3 locale 五语：卡标题/折叠摘要/纠错入口文案

## 3. /memory 仪表盘升级

- [x] 3.1 本周节奏条：entries 本周窗聚合四计数（L0/note/更正/待晋升），可点入落预置筛选；失效走解释性降级
- [x] 3.2 时间线视图：Tabs 切换（分层浏览/时间线），倒序混排 + harness 徽标，分页沿用
- [x] 3.3 测试：聚合口径（mock entries 四计数）、混排与徽标、切换共享筛选
- [x] 3.4 locale 五语

## 4. 智语房间记忆面板

- [x] 4.1 `server/routes/memory.js` entries 代理增加可选 `project` 透传（校验=非空字符串，缺省行为不变）
- [x] 4.2 `ZhiyuRoomPage` 房主态折叠区「这个房间记住了什么」（room-<id> project，lane=zhiyu 徽标沿用）；非房主/访客零渲染；空态说明
- [x] 4.3 测试：代理 project 透传；房主渲染/非房主不渲染；空态
- [x] 4.4 locale 五语

## 5. 收口（主代理）

- [x] 5.1 定向回归：observe-tap 四件 + 四记忆重指向件 + ChatPage/网页面既有件全绿；`npm run check:locales` + typecheck
- [x] 5.2 `openspec validate add-memory-visible-ux --strict` 绿
- [x] 5.3 prompt 字节不变终验：回显开/关对照断言
