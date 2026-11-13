# dsh-contracts 变更（add-harness-adapter）

## ADDED Requirements

### Requirement: ACP adapter 映射面合同（⑰）

The contracts suite SHALL carry a seventeenth contract pinning the ACP adapter's method
mapping against a local fake ACP agent process (no external credentials, no network): the
adapter SHALL complete the initialize handshake, lazily create one session per context with an
absolute cwd, run a prompt to the reported stop reason, surface the assistant text, parse
`usage_update` notifications when the wire carries them, and cancel a parked turn through
`session/cancel`. The contract SHALL also pin the failure families: a binary that cannot start
fails the spawn with the cold-start error family; a turn that ends with no assistant text
settles as the empty-turn error family (same codes the dsh path uses). The fake agent SHALL be
a test-only script driven over stdio; the real second harness (claude-code-acp) is exercised by
production validation, not by this contract.

#### Scenario: 合同⑰捕获映射破坏

- **WHEN** 候选 ACP adapter 改动方法映射（漏掉 session/new 的绝对 cwd、忽略 stopReason、丢失 usage_update）
- **THEN** 合同⑰ SHALL FAIL 并指认具体差异

#### Scenario: 合同⑰捕获错误族漂移

- **WHEN** adapter 把「空回合」或「起不来」的失败改成了与 dsh 路径不同的形状（或吞掉失败）
- **THEN** 合同⑰ SHALL FAIL——计费与计量语义跨 harness 必须同族
