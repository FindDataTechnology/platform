# Tasks — deprecate-uninstalled-bindings

## 1. 代码

- [x] 1.1 `db.js`：新增 `listConnectorBindingLedgerEmails(packId)`（按 pack 跨身份取 email，卸载方没有 owner 名单）
- [x] 1.2 `pack-store.js` `uninstallPack`：`deleteInstalledPack` 之后把该 pack 的全部台账行置 `deprecated`（保留其余字段，只改状态；令牌不动）

## 2. 测试

- [x] 2.1 `scripts/test-uninstall-deprecates-bindings.mjs`：跨两个身份的行都变 `deprecated`；另一个包的行不受影响；`kind='binding'` 槽令牌仍读得到且内容不变
- [x] 2.2 同文件：二次卸载被拒（`Pack not installed`）且 `deprecated` 行状态不变
- [x] 2.3 同文件：按投影的过滤形状（去掉 `deprecated`/`undetermined`）该包活跃行为 0
- [x] 2.4 反证：`git stash` 摘掉修复 → 两条测试全红；恢复后 2/2 绿
- [x] 2.5 真机复现记录：bootstrap 租户装包→授权→卸包，`/api/connections` 报 `{"packs":1,"bindings":1,"unresolved":1}`、`status:"missing"`（演练残留已清）

## 3. spec 与归档

- [x] 3.1 `specs/connector-bindings/spec.md` ADDED「卸载包后其绑定行转为历史」+ 三个场景
- [x] 3.2 `openspec validate deprecate-uninstalled-bindings --strict`
- [x] 3.3 `npm run test:unit` 全量 3884 / pass 3877 / fail 2 / skip 5（比基线 3877/3870 净增 7 条测试、净增 7 绿；两条红仍是 HEAD 既有的 `test-pack-cell` 断言文案与 `test-supply-store-migrate` dual-read，未增加）
- [x] 3.4 已并入出片线 `release/cell-session-persona`，gitee 与 origin 同在 `8080fdec7`（rebased 到并行会话的 `84d6327df fix(db): ADD COLUMN 幂等` 之上——那单正是承接本会话的 `harden-legacy-cell-migrations`）
- [ ] 3.5 `openspec archive deprecate-uninstalled-bindings`

## 4. 遗留

- 4.1 卸载时若用户此刻正在看那张卡片，投影下一次轮询才消失（无推送）——属既有行为，未改
