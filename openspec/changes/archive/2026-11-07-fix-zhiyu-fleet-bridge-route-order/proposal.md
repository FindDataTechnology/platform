# fix-zhiyu-fleet-bridge-route-order

## Why

`optimize-zhiyu-behavior-walkthrough`（2026-11-06）真机走查抓出 P0：`gateway/fleet-room-bridge.js` 的四条端点在生产**全部不可达**。`gateway/zhiyu/index.js:1236` 在 `registerZhiyuRoutes(app, …)` 内注册了前缀 404 catch-all `app.all(/^\/api\/zhiyu(\/.*)?$/, …)`，而 `registerFleetRoomBridge(app, …)` 在 `gateway/index.js:878` **之后**才把 `/api/zhiyu/rooms/:id/fleet-subscriptions`（GET/POST/DELETE）与 `/api/zhiyu/rooms/:id/fleet-summon`（POST）挂到同一个 `app` 上；Express 按注册顺序匹配，catch-all 先命中，桥路由永远被吞。

后果：`add-zhiyu-team-memory` 刀B（团队订阅桥）自 2026-10-30 归档起在生产从未可用过——`zy_fleet_subs` 恒 0、`fleet|team` 事件行 0，报数摘要 / 待拍板 / 健康迁移三类事件一行都没流进过空间，`fleet-room-bridge` 与 `zhiyu-room` 的既有需求在生产全部落空。13 个 script 套件 + 2 个 e2e 全绿却漏掉，因为 `scripts/test-fleet-room-bridge.mjs` 把桥挂在独立 `express()` 上，绕过了生产装配顺序。四路交叉实证（公网 curl / 浏览器同域 fetch / pod 内 :3100 直连 / 本地最小复现）见 `optimize-zhiyu-behavior-walkthrough/evidence.md` §3.5。

## What Changes

- **把 `/api/zhiyu/*` 的 404 catch-all 从 `registerZhiyuRoutes` 内抽出**，改为由 `gateway/index.js` 在**所有** zhiyu 路由（房间内核 + IM 桥 + 团队订阅桥）注册完成之后挂载，保留「未匹配路径不误代理进 cell」的原意。
- 在 `gateway/index.js` 的装配序列中显式标注「catch-all 必须是最后一个 zhiyu 注册」，并让 `registerZhiyuRoutes` 暴露一个显式收尾函数，避免后续再被 anybody 提前调用。
- **新增按生产装配顺序的集成测试**：在同一 `express()` 上按 `registerZhiyuRoutes` → `registerFleetRoomBridge` → `registerZhiyuNotFound` 的顺序装配，断言四条桥端点返回非 404（含所有权/成员闸的真实语义），且未匹配的 `/api/zhiyu/*` 仍 404、不会落到 cell 代理。
- `scripts/test-fleet-room-bridge.mjs` 保持原有独立-app 单测不变（它测桥的业务逻辑），新测试只负责「装配顺序」这一维。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `fleet-room-bridge`: 新增一条需求——团队订阅/召唤端点 SHALL 在平台网关的完整装配下可达，且未匹配的 `/api/zhiyu/*` 仍 SHALL 以同形 404 收口、不误入 cell 代理。这是可观察的外部行为契约，用于锁住本次回归。

## Impact

- 改动文件：`gateway/zhiyu/index.js`（移除内联 catch-all、导出收尾函数）、`gateway/index.js`（在桥之后调用收尾）、`scripts/` 新增一个装配顺序集成测试。
- 运行时行为：四条桥端点从 404 变为按既有闸逻辑响应；其它 `/api/zhiyu/*` 路由逐字节不变；未匹配路径仍 404 且不被 cell 代理。
- 数据：不改 schema、不做迁移；修复后新建的订阅会开始写入 `zy_fleet_subs`，拉取 tick 会开始产生事件行（属预期行为恢复，非新增写入面）。
- 部署：需滚 platform 镜像（既有出片线）；修复前生产 `zy_fleet_subs` 的 0 行是真实状态，不需回填。
- 验证：`node --test scripts/test-fleet-room-bridge.mjs`（原单测）+ 新增装配测试 + `npm run typecheck` / `npm run lint` 触碰面 + 出片后按 `optimize-zhiyu-behavior-walkthrough` 的 2.4/2.6 判据真机复验。
