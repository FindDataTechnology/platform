## 1. 声明与校验

- [x] 1.1 `lib/pack-manifest.js` 接受绑定级 `providerRole`（布尔，可选）：只在为 `true` 时允许 `provider` 是角色名；形状校验拒绝非布尔值与其他位置出现的 `providerRole`。验证：新增用例覆盖「合法 true / 非法字符串 / 缺失即未知字段剔除」，`node --test scripts/test-connector-bindings-manifest.mjs` 全绿。
- [x] 1.2 产出角色声明的机器字段样本 `test/fixtures/connector-bindings/supply-chain-role.json`：由真包 `-after` 派生，把 `wms`/`carrier-portal`/`supplier-portal` 三条标为 `providerRole: true`。**它不代表真包当前声明**——模板仓声明 `providerRole` 属对侧 change；对侧落地后此夹具须重新同步并去掉派生说明。验证：该夹具过 `validatePackManifest` 无错误，且三个角色绑定的 `provider` 仍是角色名。

## 2. 存储与迁移

- [x] 2.1 新迁移建 `connector_role_mappings(email, role, provider, updated_at, PRIMARY KEY(email, role))`，幂等；`connector_binding_ledger` 加可空 `role` 列。验证：迁移在空库与既有 v115 库上各跑一次，二次运行无副作用（schema version 前进一次）。
- [x] 2.2 `db.js` 增映射读写：`getRoleMapping/ setRoleMapping/ deleteRoleMapping/ listRoleMappings`（set 幂等）。验证：单测覆盖写入幂等（两次 set 后 `updated_at` 不变或仅最后一次生效，行数恒为 1）、跨用户隔离、删除后查不到。

## 3. 解析

- [x] 3.1 `BINDING_STATUS` 增 `unmapped`；`resolveBinding` 在 `binding.providerRole` 时先取映射：无映射 → `unmapped`（不查目录）；有映射 → 覆盖 `provider`、候选集只含映射值（忽略 `alternativeProviders`）。验证：新增解析用例按 spec 的五个场景各一条（有映射按映射解析、无映射不查目录、覆盖不足报 unwired 且不回退、映射但无连接报 missing、映射到已下线 provider 报 unwired）。
- [x] 3.2 台账行写入映射后的 provider 与服务名，`role` 列记角色名；声明"变化"的比较对角色绑定按 `(role, 映射值, 操作集)` 判定。验证：改映射后该行令牌被吊销并重建（用例断言 token 变化 + 状态回落），不改映射则二次解析零写入。
- [x] 3.3 `resolvePack` 与既有 `deprecated` 逻辑对角色绑定同样成立（包不再声明该 key → deprecated 且令牌保留）。验证：新增一条用例。

## 4. 注册表与状态面

- [x] 4.1 `grants.grantPack` 的可授予集合排除 `unmapped` 行（不铸、不列）。验证：用例构造「一条已映射 + 一条未映射」，断言只铸一条、返回的 `failed` 不含未映射项。
- [x] 4.2 `server/routes/misc.js:projectBindingLedger` 投影增 `role`/`providerRole`，汇总增 `unmapped` 计数（与 `unwired` 分列）。验证：投影单测断言白名单字段与计数（含"未映射不计入 unwired"与"unmapped 计入 unresolved"两条负向断言）。
- [x] 4.3 新增路由：`GET /api/connector/role-mappings`（每角色：当前 provider + 候选列表）、`PUT /api/connector/role-mappings/:role`、`DELETE` 同路径。候选 = 已配置连接 ∩ 目录覆盖声明操作类，逐个 coverage 判覆盖；不可达按 `undetermined` 语义处理而不是空候选。验证：路由级用例覆盖写/改/清 + 候选过滤（未连通不列、覆盖不足不列且带缺口原因）+ 连接器不可达时的返回形状。
- [x] 4.4 改映射后按角色反查台账、对所属 packId 去重逐个 `refreshPackBindings`，并吊销不再匹配的令牌。验证：用例装两个包同声明一个角色，改映射后两个包的行都被重算（断言两行的 provider 与令牌都变）。

## 5. 界面

- [x] 5.1 连接器卡的绑定视图支持 `unmapped`：显示「选择你的系统」+ 候选（已连通、覆盖所需操作类），选中后立即刷新该包状态。验证：web 构建通过 + 一个组件级用例（或 e2e）覆盖从选择到状态转已接通。
- [x] 5.2 `unwired` 与 `unmapped` 的文案与动作分开：前者给"能力缺口"与"换系统"入口，后者给"选择系统"；`missing`/`stale` 文案不变。验证：三态的呈现断言各一条。

## 6. 收口

- [x] 6.1 全量单测分批跑（`ls scripts/test-*.mjs | sort | split -l 40`）并汇总 `ℹ tests/pass/fail`，0 失败；connections + app-center e2e 全绿。
- [x] 6.2 迁移等价性：用真实存量库副本升级，断言既有台账行状态与令牌不变、`role` 为 NULL。
- [x] 6.3 `openspec validate add-connector-role-mapping --strict` 通过，`openspec archive` 合并 specs；文档补一节「角色绑定怎么用」（面向产品/售前口径：包声明角色、客户选系统、缺口如实报）。

## 落地记

- 6.1 全量单测分批（11 批 × 40）合计 **3879 tests / 3874 pass / 0 fail / 5 skip**；`e2e/connections.spec.js` 8/8（含本轮新增的两条角色用例）、`e2e/app-center*.spec.js` 14/14。
- 6.2 `scripts/test-connector-role-migration.mjs` 2/2：把有数据的库回滚到 v115 之前的形状（删列删表忘版本）再让 `initDb` 重放，断言台账行状态/provider/connection/授权时间与令牌逐字段不变、`role` 为 NULL、映射表为空；再跑一次 `initDb` 为无副作用。
- 3.2 期间发现并修掉两个真缺陷：`getConnectorBindingLedgerRow` 的 SELECT 漏了 `role`（会让每次解析都被判成「声明变了」而吊销令牌），以及三处「从旧行重建」的全行 upsert 没带 `role`（授权/撤销/401 会把角色绑定悄悄降级成固定 provider）。
- 4.3 路由在 `PUT` 上多一道 `role_not_declared` 404：给一个没有任何已装包声明的角色写映射原本会 200 且什么也不改，读起来像成功。

