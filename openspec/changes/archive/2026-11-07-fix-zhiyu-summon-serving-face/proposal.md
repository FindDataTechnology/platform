# Proposal: fix-zhiyu-summon-serving-face

## Why

一键召唤的「可召唤」半边在生产是哑的：`fleet-room-bridge.js:171` 对 `sampleFleets()` 返回的 HTTP JSON 调用 `.servingMembers?.(fleetId)`——JSON 上不存在函数，`serving` 恒 `[]`；全仓该名字零生产者，桥测试只对「降级态」断言（stub 对 serving 路径返回 null），正路径零覆盖——与 O0（路由序）同款的「测试绿、生产不可达」。生产库实况：4 个 cell 共 10 支 a2a 部署岗（万星机群席、取证-远端哨兵、源岗、外联岗），任何人对这些团队执行召唤，dryRun 如实报 `summonable=[]`，永远召不到 spec 定义本体的「有 serving 部署的成员」。

## What Changes

- **cell 侧一行增量**：`/api/fleets/overview` 的 `formation.members` 对 a2a 岗补两个只读字段——`targetId`（目录引用）与 `servingPath`（从 entry.url 解析出的 registry agent path，如 `/packs/<packId>/<agentId><suffix>`；url 非 `${REGISTRY_URL}/agent<path>/` 形态时为 null——外部 a2a 服务不参与召唤，如实排除）。
- **桥的 summon plan 换真源**：`gateway/fleet-room-bridge.js` 删除对不存在函数的寻址；改为「overview `formation.members` 过滤 `targetKind==="a2a"` 且 `servingPath` 非空 → 与 packs internal deployments（`packsInternalBase`+`packsInternalToken` 接缝，agent-lane 同款）按 `servingPath === agentPath` 全等对齐 → 得出 `summonable`（seat ref=`${packId}:${agentId}`、`onBehalfOf=deployedBy`）」。cell 无 a2a 岗或 deployments 面不可达时诚实降级为空（现行为保留为降级分支）。
- **gateway 装配传缝**：`gateway/index.js` 给 `registerFleetRoomBridge` 传一个窄缝 `servingDeployments: async () => rows`（内部 deployments API 拉取，与 zhiyu agent-lane 共用同一凭据与超时纪律），桥内不做 HTTP。
- **测试补正路径**：`test-fleet-room-bridge.mjs` 的 summon 用例从「只测降级」扩为「正路径 + 降级」双断言：含 a2a 成员+deployment 行的队 plan.summonable 非空且逐成员带 ref；无 serving 面/无 deployment 行时仍诚实为空；`test-zhiyu-route-assembly.mjs` 加装配级正路径。cell overview 侧加 formation.members 字段断言。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `fleet-room-bridge`：召唤「可召唤面」的取数语义从「不存在的 servingMembers 函数寻址」改为「overview a2a 岗 × deployments 按 servingPath 全等」；补「cell 上报 servingPath 而 deployments 无对齐行时如实排除」与「deployments 面不可达时诚实降级为空」两个场景。既有「如实呈现可召唤/仅驾驶舱」需求的语义不变——本案是让它首次真正可达。

## Impact

- `server/routes/fleets.js`（overview formation.members +字段，只增不改）；
- `gateway/fleet-room-bridge.js`（summon plan 取数重写，执行段零改动——invite 仍走既有握手）；
- `gateway/index.js`（装配传缝一处）；
- `scripts/test-fleet-room-bridge.mjs`、`scripts/test-zhiyu-route-assembly.mjs`（正路径覆盖）；
- 无 schema/迁移；`pack_deployments` 表只读；formation.members 新字段对既有消费者（编队画布）零影响（不读未知字段）。
