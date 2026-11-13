# Tasks — harden-legacy-cell-migrations

## 1. 代码

- [x] 1.1 `db.js` v100：`statements` 裸 ALTER → `apply`：`CREATE TABLE IF NOT EXISTS`（v35 形状）+ `PRAGMA table_info` 判断后 ALTER
- [x] 1.2 注释写明为何要守卫（cell 2b043ce050ca134c 的账本记过 v35 但表缺失，裸 ALTER 导致整库停用）

## 2. 测试

- [x] 2.1 `scripts/test-legacy-table-migration.mjs` A 态：表在、列缺、有 token 行 → 迁移后 token 不变 + 列补上
- [x] 2.2 同文件 B 态：表缺、v100 未记 → 迁移完成且 `isDbReady()` 为真、表重建、列存在
- [x] 2.3 反证：摘掉修复（`git stash`）后 B 态转红，恢复后 2/2 绿
- [x] 2.4 生产库副本实证：把 cell `2b043ce050ca134c` 的 app.db 复制到 `/data/tmp-cell26.db`，在 pod 内用新代码跑 `initDb()` → `schema v114` 且回填 1 行绑定（真实数据集，非构造）

## 3. spec 与归档

- [x] 3.1 `specs/schema-migrations/spec.md` ADDED「迁移不得因缺失的旧表停掉整个数据库」+ 两个场景
- [x] 3.2 `openspec validate harden-legacy-cell-migrations --strict` → valid
- [x] 3.3 `npm run test:unit` 全量 3877 / pass 3870 / fail 2 / skip 5；两条红为 HEAD 既有（摘掉本改动 stash 后同样红）：`scripts/test-pack-cell.mjs` 断言文案（要求 `not a registry server`，代码已改说 `not a market server`）、`scripts/test-supply-store-migrate.mjs` dual-read 漂移；本改动净增 2 条绿（两条都被 `test:unit` 的 `scripts/test-*.mjs` glob 收进）
- [x] 3.4 落点校正：paas 的出片线是 `release/cell-session-persona`（快照脚本 `--ref HEAD`，主工作区就 checkout 在它上面），不是 `main`/`gitee/main`。本修复 cherry-pick 到该线之上（含 v115），`test-legacy-table-migration` 2/2 + `validate --strict` valid，已 fast-forward 并入 `gitee` 与 `origin` 的 `release/cell-session-persona`（`b2e390d10`）。谁下一个出片就带上了；另一会话的主工作区 checkout 落后 3 个提交、`db.js` 有未提交改动，拉取前需 stash
- [x] 3.5 `openspec archive harden-legacy-cell-migrations`

## 4. 遗留（非本次范围）

- 4.1 41 处 `ALTER TABLE` 的全面守卫化：本次只修已观测到的失败点，其余同类风险未逐一实证
- 4.2 谁把 v35 记成 applied 却让表消失 —— **已查清**：不是裁剪器删表，是**版本号相撞**。cell 账本自带压缩过的历史（`db.js` v100 注释原话：「old cells sat at 60+」），老谱系里 `35` 这个号说的是另一件事；v35 的 `CREATE TABLE user_chatwoot_credentials` 在这格从来没跑过，账本却已有 `35`。所以「账本有 N ⇒ N 的结构在」这个假设在 cell 上不成立，唯一稳妥的写法就是本 change 的守卫式迁移（v100/101+ 选高位号只避开了「永不重跑」，避不开「重跑时基础结构不在」）。
- 4.2.1 现役 26 个 cell 已逐个核对版本与表集：只有 `2b043ce050ca134c` 一处「账本记过、表缺失」。其余缺口都是「创建该表的迁移还没跑」，会按序补上，不是同一类风险。
