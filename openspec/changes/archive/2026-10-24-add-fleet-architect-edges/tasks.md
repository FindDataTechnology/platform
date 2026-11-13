# Tasks: add-fleet-architect-edges

## 1. draft 校验链与 diff

- [x] 1.1 `validateFleetDraft` 接 orchestration 段:虚拟终态成员集(add 岗分确定性 id `draft-<n>`)上跑 `validateOrchestration`,错误/警告分流进结果;diff 增 orchestration 区块(mode/约束/边逐行,supervisor 隐式许可提示);验证:带边建队/同草稿建岗+引用/环拒/未知引用拒四用例
- [x] 1.2 estimate 联动:工具岗边不影响预估(既有分流已覆盖,断言带边草稿预估不回归);验证:断言一例

## 2. apply 透传

- [x] 2.1 create:orchestration 落库前 `draft-<n>`→实铸 memberId 互换;edit:成员操作后 updateFleet(未带段不动既有段);apply 重校验含边漂移(引用岗消失→未知引用错误);验证:create 落库真 id 两例 + edit 加边/不动两例 + 边漂移拒一例

## 3. 种子与上架

- [x] 3.1 种子 v1.1:persona 补边词汇与两条纪律(删带边岗连带清边须确认/mode 与显式边并用);本地校验+守恒绿;续版上架 `NoBBXkvxZnJNHlCrAwWp-w` v1.1(一次性脚本,台账补记)

## 4. 测试与回归

- [x] 4.1 `test-fleet-architect.mjs` 补边用例全绿(1.x/2.x)
- [x] 4.2 十三套回归零新增红;`openspec validate add-fleet-architect-edges` 通过
- [x] 4.3 出片(与派生顺序修正同车)+ 真机活体验收(对话建 supervisor 两岗舰队→驾驶舱确认边)→ 台账补记
