# Design — fix-member-config-complete

## D1 建岗与改岗共用一套闸，而不是复制一份

`validateConfigDims({effort, contextBudget}, effortUnion)` 是 effort/contextBudget 唯一
形状门（`server/fleet-model.js:140`），PATCH 已在用（`fleets.js:3167`）。POST 直接调同一函数，
不新增平行校验：一旦两处各写一套，"建岗合、改岗拒"这种漂移就会静默长出来。

`carrier` 的枚举门（`CARRIERS.includes`）和 `packId` 的形状门（非空串 ≤64）同理内联复用，
与 PATCH `:3175-3185` 逐条对齐。

**顺序**：四个维度在 `db.createMember(...)` 之前校验完；任一门拒绝即 400，库不动
（与既有 `kpiSlots`/`cadence` 拒绝路径同形）。

**未提交等同于未声明**：`undefined` 不写列（列落 `null`），与 PATCH 的
"`!== undefined` 才更新"语义一致。这样 `{carrier: null}`（显式清）与 `{}`（不涉及）
在建岗面上不产生歧义——建岗时两者等价于同一个落库值 `null`，所以无需区分。

## D2 清档必须落地，判据从"有值"改成"值不同"

现状（`cron-runner.js:476`）：

```js
if (plan.effort && plan.effort !== (ctx.currentEffort ?? null)) { … }
```

`plan.effort` 由 `resolveEffort` 产出，无声明时是 `null`（`fleet-model.js:91,104`）——
真值判断让"清档"这一支永远进不去，运行中档位停在上一岗留下的值。

改为按**目标值**比较：

```js
const desired = plan.effort ?? null;
if (desired !== (ctx.currentEffort ?? null)) { … switchEffortTo(desired) … }
```

`switchEffortTo(null)` 是既有已支持的路径：`switchEffortToInner` 对 `null` 不做档位校验
（"null/'' = back to the provider default, always allowed"，`agent-session.js:230`），
同值短路返回 `{ok:true}`（`:233`），所以无声明且运行中已是全局值时**零成本**。

**权衡（明记）**：这条改动会把"用户在聊天里手工挑的活体档位"在下一回合拉回该岗的声明值；
当岗位无声明时拉回全局默认。这是规格原文要求的语义（"沿用 provider 级全局思考深度"），
也是多岗共享同一 worker 运行时的必然——不重置就会串味。若将来要支持"岗位继承活体值"，
那是新的声明语义，需另立规格。

**降级不变**：切换失败仍只记 `effortNotices` 并放行回合（`cron-runner.js:479-483`），
本变更不动这条。

## D3 不碰 Web 建岗对话框

`MemberComposerDialog` 的 POST 体只有 title/targetKind/targetId/parentId/cadence
（`web/src/pages/FleetsPage.tsx:2064`），配置项一律在检查器抽屉里改（PATCH）。
这是既定的"先建岗、再配置"流程，不是缺陷；本变更把 API 补成对等，让脚本/A2A 侧能一次建全，
但**不改**人机交互面。若要把四个字段搬进建岗对话框，需要单独裁人机流程，不在本变更。

## R1–R4 风险

- **R1 重复写面**：POST 与 PATCH 都能写同一列 → 已由规格收敛为"同闸同值"，测试双向钉住。
- **R2 清档误伤**：`desired !== currentEffort` 会在"多岗共用 worker、档位来回跳"时每回合
  多一次 `model/set` → 只在不同时才发；同值短路已在 `switchEffortToInner:233` 保证。
- **R3 cluster 岗**：cluster 行的 effort 归各成员岗位（既有条款），POST/PATCH 的校验
  仍按 `targetKind` 走 `validateConfigDims`，不新增 cluster 特例。
- **R4 读面**：`memberView` 已回显四列（`fleets.js:3097`），本变更不需要动读面。
