# Proposal: add-model-session-boundary-apply

## Why

ADR-0019 把模型变更走排水重生（identity drain + child 重生），当时是对的；但两个后续事实改写了代价账：① pod 共宿（add-dsh-pod-adapter）后**任一成员的 identity 变更排干整个 pod**，数百 agents 密度目标下模型变更是 churn 平方项；② `preset/set + model/set` 的**会话边界热切机制已在活体内运行**（pod 成员会话首用时逐成员停车预设+模型，`harness/dsh.js` add-dsh-pod-adapter 既有件），热切通道其实早就造好了，只是 ADR-0019 说「不引入第三种重启通道」时它还不存在。

## What Changes

- **模型变更脱离 identity drain**：`#identityOf` 拆两类——组合级（packVersion/persona/skills/mcp/mcpTools/name/budget/secretRefs/billingKeyRef/notify/workspace，维持排水重生）与会话级（**model**）；模型变更改走会话边界热切。
- **runner 停车图热更新**：solo 与 pod 统一——运行时收到新 effective_model 后更新成员模型停车图；**新会话取新模型、在途会话保持旧模型**（与 pod 成员首用停车同构，组合身份不漂移）；solo child 单成员同构。
- **ADR-0019 修订**：两档生效语义改为三通道——descriptor 无感 / **模型会话边界** / 组合级排水重生；「不引入第三种重启通道」约束按新机制改写（热切不是重启通道，是无感的第四格……不，是会话边界格）。
- 非目标：不动 pod 爆炸半径的重审（组合级变更仍排干全 pod，密度信号到了另立）；不动 persona/skills 等组合级字段；不动结算/计费键语义（模型车道授权仍在写时校验）。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `agent-service-config`: 「两档生效语义」requirement 修改——模型变更从排水重生改为会话边界热切（新会话新模型、在途会话旧模型到结束），生效窗内新旧并存为**设计语义**而非不一致；组合级字段维持排水重生。

## Impact

- 代码：`paas/agent-runner/manager.js`（reconcile identity 拆分 + 模型变更热更新路径）、`paas/agent-runner/harness/dsh.js`（成员模型停车图的运行时更新入口；pod 与 solo 同构）。
- 测试：manager reconcile 拆分后既有测试全绿；新增模型热切用例（新会话新模型/在途旧模型/pod 成员级/solo 级/组合级变更仍排干）。
- ADR：`docs/adr/0019` 追加修订段（不重写历史，2026-11-05 修订注记）。
- 兼容：deploy API/服务配置面零变化（部署者无感）；计费车道授权语义零变化。
