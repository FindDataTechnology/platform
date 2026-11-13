# 铸造准入判定收敛为状态表（N-21，纯重构、零契约变化）

## Why

`blueprint-studio` 的铸造准入在两周内挨了五刀，每刀都是同一个失效模型（蓝图指针/报告/包名三者失配 → 蓝图永久卡死）在不同入口各打一块补丁：

| 刀 | 提交 | 加的例外 |
|---|---|---|
| 一 | 77f52badc/8ab6fffa7 | 陈旧指针：旧 packId 404 → 重建并改指针 |
| 二 | d18085a96 | 死锁另一半：坏试跑把报告覆盖成 `Pack not found` 且签字消失 → reseal 永不成立，门口 409 挡死重建 |
| 三 | fbe179d0f | 重建撞同名闸 409 → 以 `_casting.blueprintId` 证明归属后认回同名活包 |
| 四 | e24ebf04c | 真机形态是 409+同名提示而非 404 → 404-only 判据在真机永远进不去 |
| 五 | 05022564e | 首铸 `{{PACK_ID:self}}` 原样封进 v1 → 试跑 target 空，且报告不带 Pack-not-found，前两刀都救不了 |

五条规则全内联在 `server/routes/blueprints.js` 的 if 链与发布重试里，彼此不可见：第六条失效模式来了照样得在同一个 if 链上再插一刀。这是「自愈叠自愈」的结构成因，不是任何单刀写错。

## What Changes

- 新增 `server/blueprint-cast-state.js`：把准入与发版判定变成无 I/O 的判定表——`classifyCastAdmission`（approved / reseal / stale-pointer / self-pending / blocked）、`looksLikeStalePointerError`、`manifestCarriesSelfPlaceholder`、`isStalePointerAnswer`（404 与同名 409 同判）、`sameNameCandidates`、`mayAdoptSameNamePack`（provenance 归属）。
- 路由改为「做副作用 + 问判定」：`getPack` 的前置条件与旧写法逐条相同，其余分支删除。
- 新增 `scripts/test-blueprint-cast-matrix.mjs`：13 行准入矩阵 + 5 组判定件测试，把「status × 签字 × 陈旧错误 × self 占位」的组合网格显式化。

**零契约变化**：响应体、状态码、`cast.rebuilt` / `cast.reclaimedPackId` / `cast.selfPending` 语义、403/409/422 顺序全部不变。故 `skip_specs: true`——`blueprint-studio` spec 无 delta。

## Impact

- `server/routes/blueprints.js`（-45/+22 行）、新增 `server/blueprint-cast-state.js`、新增矩阵测试。
- 回归网：`test-blueprints`（27，含五刀各自的端到端断言）+ `test-blueprint-trial` + `test-blueprint-kind` + 新矩阵（18）= 61/61 绿。
