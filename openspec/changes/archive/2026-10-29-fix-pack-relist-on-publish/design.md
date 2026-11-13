## Context

`gateway/packs.js` 的 `createPackRegistry` 里，pack 级状态与版本级状态是两张表：`packs`（可见类 visibility、卫生旗标 unlisted、策展 category/featured）与 `pack_versions`（不可变版本快照）。三条写路径各有边界：

- `publish` 建新 pack（含同名闸在上游 `facet/publish-gate.js`）；
- `publishVersion` 作者鉴权后追加版本，并已在同一处处理「新版本重声明的 category 覆盖包级策展值，缺省则保留」；
- `setUnlisted` 作者鉴权后**单向**置 `unlisted = 1`。

缺的是反方向。语义真空处不是「要不要做」，而是「走哪条路」：加一个 relist 端点，还是让发版顺带恢复。

## Goals / Non-Goals

**Goals**

- 让「发布新版本即恢复上架」这句话在代码里成立——客户端文案（`facetMine.unpublishNote`，五语）与主 spec 场景（"can be re-listed later"）都已经这么承诺。
- 改动面最小：不改 API 形状、不加端点、不加配置、不动已存数据。
- 复用既有的作者鉴权，不引入新的授权判断。

**Non-Goals**

- 不做独立的 relist / restore 端点，也不给管理面加「一键上架」。卫生动作的价值在于「下架容易、上架需要一次实质发布」——给一条不产生新版本的捷径，等于把卫生闸打回可随手翻转。
- 不让发版改变 visibility（public/private）。这是 pack 级属性，只能通过建新包改变；把两者混在一条写路径上会让「私人包」在下一次发版时意外变公开。
- 不做历史 unlisted 包的批量回填。全仓现有 unlisted 本就是卫生清扫的结果，批量上架是运营决策，不是代码路径。

## Decisions

**D1 — 恢复上架挂在 `publishVersion` 内，不新增端点**

`publishVersion` 已经承担「版本级动作同时更新包级派生状态」这一类职责（category 重声明就是同款），语义上「新版本让包重新可见」与它同类。挂在里面还顺带白拿了两件事：作者鉴权已经在前面（`pack.author_email !== email` → forbidden），以及「必须真发一个版本」这个门槛天然成立。

替代方案（独立 `POST /api/packs/:id/relist`）被否：多加一个端点就多一个授权面、多一处要测的鉴权分支，而它换来的唯一好处是「不产生版本就能上架」——这恰好是我们不想给的。

**D2 — 只清 `unlisted`，不碰 `visibility`**

两条 SQL 分开写、条件判断各自独立：`if (pack.unlisted) UPDATE packs SET unlisted = 0`。`visibility` 无任何写入。这条边界写进 spec 场景（"Publishing never changes visibility class"），因为它是这次改动最容易在后续演进中被顺手扩大的地方。

**D3 — 放在版本插入之前，与 category 更新并列**

顺序上先清旗标再插版本，与同函数里 category 更新的位置一致；即便后续插入抛错，最坏结果是包提前变可见一瞬——但两者都在同一个 better-sqlite3 同步事务语义下（无显式 BEGIN，逐语句提交），这个窗口在单进程单写者模型里不可观测。反过来（先插版本后清旗标）同样可行，但不值得为此引入显式事务——本函数已有的 category 写入也没有，保持一致比理论上的原子性更值。

**D4 — 测试补在 `test-pack-registry.mjs`，不加新文件**

这条行为是 registry 模块的直接语义，既有测试文件已经覆盖了 `publishVersion` 的鉴权/版本号/category，加一个用例即可。测试要钉住四件事：恢复上架生效、非作者被拒且仍 unlisted、private 包发版后仍 private、未下架包发版行为零变化。

## Risks / Trade-offs

- **风险：把「卫生下架」无意中解除。** 若管理员因验收/演示目的手工下架了一个包，作者下次发版就把它带回公开列表。判断：这正是文案与 spec 承诺的语义，且管理员仍有 `setUnlisted` 可再次下架——单向补救成本很低。若日后需要「钉死不可自恢复」的强下架，应新增独立旗标（如 `unlisted_locked`），而不是让本行为含糊。
- **风险：并发发版。** 两个并发 `publishVersion` 会各自读到 `latestVersionRow` 得出同一个 version 号，这是**既有**竞态（本改动不引入也不修复）。恢复上架是幂等写（`= 0` → `= 0`），不放大该竞态。
- **无迁移**：不加列、不加索引，`unlisted` 列早已存在（`INTEGER DEFAULT 0`）。

## Migration Plan

1. 改 `gateway/packs.js`（一行条件更新）。
2. 补 `scripts/test-pack-registry.mjs` 用例，跑 `node --test scripts/test-pack-registry.mjs` 与 `test-facet-publish-gate.mjs`。
3. 随下一次 facet/platform 出片生效；已在生产卡住的 `C8wx14-4h7zJ0N19-J4NwQ` 已在 2026-10-28 由手工改库恢复，无需回填。
4. 回滚：删该条件更新即回到现状，不影响已存数据。

## Open Questions

（无）
