## Why

作者主动下架（unpublish）后，**没有任何路径能恢复上架**：`setUnlisted` 只写 `unlisted = 1`，全仓没有反向写入点，管理面也没有 relist 端点。而客户端的下架说明一直写着「恢复上架不可用（发布新版本即恢复）」（`facetMine.unpublishNote`，五语齐平），主 spec 的卫生基线场景也写着「the pack can be re-listed later」——**界面与 spec 都承诺了这条路，代码没实现**。2026-10-28 实测撞上：包 `C8wx14-4h7zJ0N19-J4NwQ`（跨境电商政策盯梢集群模板）从 v2 到 v3 两次发版始终 unlisted，只能手工改库才回到公开列表。

## What Changes

- `publishVersion` 在追加新版本时，若该 pack 当前 `unlisted = 1`，同事务内把它置回 `unlisted = 0`——**发布新版本即恢复上架**，与该 pack 的下架说明文案、主 spec 场景一字不差。
- 显式边界：可见性（public/private）仍不可由发版翻转；这条只清 `unlisted` 这一个卫生旗标。已发布版本与订阅者快照照旧不动（unlisting 从不删版本）。
- 补测试：`publishVersion` 恢复上架 + 他人不可借此翻转 + 未下架的包行为零变化。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `pack-marketplace`: 「Marketplace hygiene baseline」需求补一条机制——unlisted 包发布新版本即恢复上架（此前只声明「can be re-listed later」，未说路径）。

## Impact

- `gateway/packs.js`：`publishVersion` 内一行条件更新（`unlisted = 1` → `0`）。
- `scripts/test-pack-registry.mjs`：新增恢复上架用例。
- 无 API 形状变化、无迁移、无配置项；客户端文案与 spec 已就位，本次是把代码补到承诺上。
- 回滚：删掉该条件更新即回到「只能手工改库」的现状，不动已存数据。
