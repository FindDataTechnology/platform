# Register the live fleet scheduler control loop as a capability

## Why

体检增量对账（optimize-paas-module-audit N-8）实证：`gateway/fleet-scheduler.js`（257 行，经 `gateway/packs.js:42,1525,2055` 在产）是**唯一没有 spec 在册的活体控制环**——failback-by-repoint、placement hint、desktop 席位豁免、孤儿回收等风险语义只由代码头注与归档 change 自证。冷重建/热会话丢弃、不回搬滞回、桌面席位不可被云调度这些决定直接影响用户 agent 在哪里跑、是否计费，却无行为契约可验收。

现有 `scripts/test-fleet-scheduler.mjs` 12/12 绿，本 change 只把已实现、已测试的行为入册（零代码改动），使下次触碰该域有对账基准。

## What Changes

- 新 capability `fleet-scheduler`：六条 Requirement + 逐条 Scenario，全部来自现网代码与既有测试断言。

## Capabilities

### New Capabilities

- `fleet-scheduler`：控制环契约（ADDED）。

### Modified Capabilities

（无）

## Impact

- 仅新增 spec；代码/测试零改动。
