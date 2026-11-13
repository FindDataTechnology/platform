# Proposal: 记忆线收口——智语回合同缝落地 + 成果页手势与降级口径

## Why

`add-unified-memory-and-outputs` 归档时，任务 4.3（facade/智语回合同一 digest 读缝）被标为「受阻于跨仓」，理由是「room 宿主不在本仓」。归档后复核发现这个判断是错的：智语房间宿主就在本仓 `gateway/zhiyu`（`room-router.js` 的 `buildPrompt`/`runTurn`），只有 facade 的 1:1 会话在 fd-wanxing 外仓。同时归档实现里留了两处与已同步需求不完全对齐的地方：

1. `resource-library-ui` 的「三手势」需求写的是「改 tag 的**弹窗**」，实际实现是 `window.prompt`——既不是像样的弹窗，也挡页面、不可 Esc 撤、样式不可控。
2. `memory-portal-ui` 的「无配置优雅降级」要求「修正手势 SHALL 在降级态下不可用并说明原因」，实际实现只有 503 之后的错误 toast，没有降级态。

本变更把这三件事补齐，并把 4.3 的两条车道（智语房间 + facade 1:1）真正接通。

## What Changes

- **智语房间回合接入 digest 读缝**（apply 既有 `chat-memory` 需求，不新增能力）：房间回合 prompt 追加提问者本人的记忆块；`kind=user`（identify 合流后 ref=邮箱）用本人 owner 根，`kind=guest` 恒不注入；与壹座 chat 共用 `CELL_MEMORY_CHAT_DIGEST` 总闸与逐字节相同的块（`chatMemoryBlockFor()`）。
- **改 tag 手势从 `window.prompt` 改为行内编辑面**：卡内输入框自动聚焦、预填现值、`Enter` 存 / `Esc` 撤、显式保存/取消两键，`,/，` 双分隔、上限 5 条。同步修正 `resource-library-ui` 需求措辞（弹窗 → 编辑面）并修掉该需求里两处既有错字。
- **手势降级态**：记忆手势收到 503（`memory_unavailable`）即在 store 记 `memoryOff`，三个手势一起置灰并给出降级说明，任一手势成功即清除；同步在 `memory-portal-ui` 需求里写明这条判据来源。

## Impact

- 受影响能力：`chat-memory`（行为落地，无 spec 变更）、`resource-library-ui`（MODIFIED）、`memory-portal-ui`（MODIFIED）。
- 受影响代码：`server/cluster-memory.js`（阶梯改为返回 block + `chatMemoryBlockFor`）、`gateway/zhiyu/{room-router,index}.js`（memoryBlock 缝与身份门）、`web/src/{pages/ResourcesPage.tsx,hooks/useResourcesStore.ts}`（行内编辑 + 灰态）。
- 兼容性：默认关/开由既有开关决定（`CELL_MEMORY_CHAT_DIGEST`）；未配置记忆服务的部署行为不变（手势仍置灰、回合无注入）。
- 外仓配套：facade 1:1 会话在 fd-wanxing 仓单独立案（`add-facade-chat-memory-seam`），本变更不涉及。
