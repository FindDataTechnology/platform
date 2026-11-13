# dsh-contracts 变更（add-dsh-pod-adapter）

## ADDED Requirements

### Requirement: pod 形状合同（⑯）

The contracts suite SHALL carry a sixteenth contract pinning the pod co-hosting shape against a real matrix tree: one dsh process hosting two member agents with distinct persona presets and distinct models. The contract SHALL assert, per member session: the session header names that member's preset (`preset/set` parked semantics — the parked selection, not the initialize-time default, composes the session); the member's model selection follows that member's `model/set` (parked or live) and never bleeds into the other member's requests; and each member's conversation history stays within its own session (no cross-member content). The contract SHALL also assert the refused shape: `preset/set` on a live session fails with an explicit error, and an unresolvable parked preset fails the session's creation before any agent publishes. The contract runs in the candidate-mode runner alongside ①-⑮ and reports per-contract pass/fail.

#### Scenario: 合同⑯捕获共宿 persona 串扰

- **WHEN** 候选 dsh 树上双成员共宿、各自 preset/set+model/set 后各跑一回合
- **THEN** 两回合的 system prompt 各含各自成员的 persona 标记、模型请求各走各自成员的模型；一旦 preset 泊靠或会话头记名被上游破坏，合同⑯红

#### Scenario: 合同⑯捕获活会话改 preset 的静默接受

- **WHEN** 对已创建的活会话调用 preset/set
- **THEN** 候选树须以显式错误拒绝；静默接受或静默忽略都判红
