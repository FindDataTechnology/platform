# 一个缺失的旧表不该让整个 cell 库停摆

## Why

cell `2b043ce050ca134c` 的生产库自 2026-10-21 起就是死的。它的 `schema_migrations`
停在 v37（42 张表），而 `db.js` v100 是一句裸的
`ALTER TABLE user_chatwoot_credentials ADD COLUMN chatwoot_user_id INTEGER`——那张表
在这个库里根本不存在（v35 的 `CREATE TABLE` 在账本里记过，表却没了；这是一条被压缩过的
旧谱系）。于是每次启动都是：

```
[db] disabled: could not open/migrate /data/cells/2b…/data/data/app.db: no such table: user_chatwoot_credentials
```

`runMigrations` 抛错 → `initDb` 的 catch 把 `dbReady` 置假，**整格数据库停用**：不只是
Chatwoot，会话、包、台账、凭据全部不可用，连带 `[cron] missed-count failed`。该 cell 里有
一个真实连接器账号（本次修复后回填出 1 行绑定），不是空壳。

## What Changes

- `db.js` v100：由裸 `statements` 改为 `apply`——先 `CREATE TABLE IF NOT EXISTS` 建回 v35
  的形状，再用 `PRAGMA table_info` 判断列是否存在后 `ALTER`。健康库上两步都是空操作；
  缺表库上把表补回来再补列。
- 新 spec 能力 `schema-migrations`：把这条规则写成要求——**迁移不得因为一张缺失的旧表
  而让整个数据库失效**；基础表缺失时应就地重建到其创建迁移的形状，再施加增量。
- `scripts/test-legacy-table-migration.mjs`：两态钉死。A 健康库（表在、列缺、有数据）→
  迁移后原始 token 不丢、列补上；B 旧库（表缺、v100 未记）→ 迁移完成且 `isDbReady()`
  为真。反证：摘掉修复后 B 态转红（正是生产那行 `[db] disabled`）。

非目标：不做 41 处 `ALTER TABLE` 的全面守卫化（本次只修已观测到的失败点）；不改
cell 库压缩/裁剪机制本身（它为什么丢表是另一件事，需先查清裁剪器再定）；不动
`user_chatwoot_credentials` 的语义与读写路径。

## Impact

- 影响面：只有「账本记过 v35、表却缺失」的旧 cell 库——它们从**整库停摆**变成正常启动
  （本次已在生产的库副本上实证：v38→v114 一路干净，并回填 1 行绑定）。
- 健康库：v100 已是 applied，不会重跑；即便重跑，`CREATE IF NOT EXISTS` + 列存在判断
  也不改任何数据。
- 无 API、无 UI、无数据语义变更。
