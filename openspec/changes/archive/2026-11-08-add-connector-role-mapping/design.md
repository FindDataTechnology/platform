## Context

现状（`connector-bindings.js`、`openspec/specs/connector-bindings/spec.md`）：

- 解析只认一条路：`providerCandidates(binding)`（`provider` + `alternativeProviders`）逐个问连接器 `GET /api/tenant/catalog-coverage?provider=&operations=`，再问 `GET /api/tenant/connections` 找同 service 的连接。角色名在这条路上必然得到 `unknown_provider` → `unwired`。
- 台账 `connector_binding_ledger` 存 `(email, packId, bindingKey)` 行；声明变化（provider 或操作集变了）会吊销令牌重建行；`deprecated` 保留令牌。
- 连接面的读投影在 `server/routes/misc.js:projectBindingLedger`，汇总 `{packs, bindings, unresolved, unwired}`。
- 授权/注入走 `server/routes/connector-bindings.js` + `grants.*`；注入行名 `connector:<packId>:<bindingKey>`。

约束（已实测，不是推测）：

- 连接器租户侧只有两个自省面（`catalog-coverage`、`connections`）；`/api/providers` 需要租户鉴权和全量 payload（1570 家），**不适合**当候选源。→ 候选必须来自用户自己的连接。
- 台账唯一键是 `(email, packId, bindingKey)`；角色映射是 `(email, role)`，两者粒度不同。

## Goals / Non-Goals

**Goals:**

- 角色绑定能闭环：未选系统 → 选定 → 解析 → 授权 → 注入，全链走既有授权与注入机制，不新增令牌种类。
- 状态面能区分「你还没选」和「目录不支持」，且两种计数分开。
- 改映射要能收敛到"该重算的包都重算、该作废的令牌作废"，不留下用旧系统范围的会话。

**Non-Goals:**

- 不做全目录选型/搜索（连接器侧不提供，产品上也不该给）。
- 不做「一个角色映射到多个 provider」（一对多）+ 负载均衡：那是另一套语义，先按单值收敛。
- 不改连接器仓；不改注入行命名与令牌种类。
- 不在本 change 改模板仓声明（角色绑定的声明与是否恢复非 optional 走对侧 change）。

## Decisions

**D1 声明形态用 `providerRole: true` 布尔标记，而不是把 `provider` 改成对象**

保留 `provider` 恒为字符串：既有校验（`lib/pack-manifest.js`）、台账列、投影、测试夹具都不用变形；角色态只多一个布尔位。替代方案 `provider: {role: "wms"}` 会让所有既有读取点都要分支，且旧包校验路径更难保持"看不懂就拒"。

代价：`providerRole` 与实际目录 id 的冲突无法在 paas 侧判定（它读不到目录），由模板仓的机器门兜（见 Impact）。

**D2 映射存 `(email, role)` 一行，不存到台账行上**

角色的语义是「客户的这个系统是哪个」，跨包共享；存到 `(email, packId, bindingKey)` 上会让两个包问两次、还可能答出两个不同系统。
新表 `connector_role_mappings(email, role, provider, updated_at)`，主键 `(email, role)`；与既有 `user_connector_credentials` 的 `(email, kind, slot)` 风格一致。

**D3 候选 = 已连通连接 ∩ 目录覆盖所需操作类**

复用两个自省面：`connections()` 给已配置的 service 集，逐个 `catalog-coverage(service, classes)` 判覆盖。payload 小（用户连接数是十级）、无需新端点、不泄漏目录规模。
替代方案（新增连接器租户端点做候选检索）被否：跨仓依赖 + 反正是"你有账号的系统"才可接。

**D4 新状态 `unmapped` 进台账闭集，且不退化**

写进 `BINDING_STATUS`；`unresolved` 计数含它，汇总另加 `unmapped` 一项（与 `unwired` 并列而非合并）。理由同 spec：三种状态三种修法。
风险点是 UI 只有 `unwired` 卡片文案，需同步加分支（见 tasks）。

**D5 解析顺序：先取映射，再走既有 provider 路径；映射后不回退 alternatives**

`resolveBinding` 开头：若 `binding.providerRole` → 查映射；无映射直接返 `unmapped`（**不查目录**）；有映射 → 用映射值覆盖 `provider` 且令候选集只含它（忽略 `alternativeProviders`）。
替代方案（映射值不通再试 alternatives）被否：那会替用户改选，状态面显示的系统与用户选的不一致，排障时会误导。

**D6 改映射的重算范围按角色反查，不按包**

`PUT/DELETE /api/connector/role-mappings/:role` 落库后：列出该用户台账中所有 `providerRole` 且 `provider=role` 的绑定行 → 对其所属 packId 去重 → 逐个 `refreshPackBindings`。声明变化检测沿用既有逻辑（provider 变了即吊销令牌），无需新机制。
替代方案（只在当前包内重算）被否：同角色跨包共享映射，只算一个包会让另一个包停在旧 provider 上继续注入。

**D7 未映射不进授权弹窗的可授予集合**

`grantPack` 现在按台账可解析行铸令牌；`unmapped` 行没有目标 provider，既不铸也不在弹窗列出（列为待连接项 + "选择系统"入口）。这是 spec 里「未映射不进入授予集合」的直接实现点。

**D8 路由形状沿用 connector-bindings 现有风格**

`GET /api/connector/role-mappings` → `{ mappings: [{role, provider, updatedAt, candidates: [...]}] }`；`PUT /api/connector/role-mappings/:role` body `{provider}`；`DELETE /api/connector/role-mappings/:role`。写端点做 provider 形状校验（非空、长度上限），**不**替用户校验目录存在性（那是解析的事，且要如实报「未知 provider」而不是 400）。

## Risks / Trade-offs

- [角色名与真实 service id 撞名（如角色叫 `kingdee`）] → 声明侧 `providerRole: true` 是显式开关，撞名不影响判定；模板仓机器门禁止把真实 service id 标成角色（task 里加负向用例）。
- [用户映射到一个目录里后来下线的 provider] → `unwired` + 改选入口（spec 已定义），不是静默回退。
- [改映射把正在跑会话的令牌吊销] → 这是有意的：令牌的范围属于旧系统。缓解：吊销后下一次写入 profile 才生效，不主动中断会话，状态面提示需重新授权（与既有 `stale` 行为一致）。
- [`unmapped` 进入 `unresolved` 可能让已装包突然变"待连接"] → 只影响声明了 `providerRole` 的包；本次变更前这类包本就是永久 `unwired`（同样是未解决），不会把已绿的包变红。需在 4.x 用例里固定这条。
- [候选接口要 N 次 coverage 调用] → 按用户连接数线性，且只在状态面读取时按需计算；可在投影层缓存单次请求内的结果（不做跨请求缓存，避免与连接器状态分叉）。
- [台账里角色的 provider 列存的是角色名还是映射值] → 存映射后的 provider（与服务面语义一致），角色名记在新列 `role`；迁移只加列、不回填（历史行 `role` 为空）。

## Migration Plan

1. 迁移：建 `connector_role_mappings`；`connector_binding_ledger` 加 `role` 列（可空，默认 NULL）。
2. 部署后旧行为不变：没有 `providerRole` 声明就没有映射查询。
3. 回滚：删除映射表与新列不影响既有解析；停用该能力只需模板侧不再声明 `providerRole`（包回到 `unwired` 语义）。
4. 真机验收：装一个含角色绑定的包 → 状态面显示"选择系统" → 选一个已连通且覆盖所需操作类的 provider → 包转已接通 → 注入行走该 provider 的连接。
