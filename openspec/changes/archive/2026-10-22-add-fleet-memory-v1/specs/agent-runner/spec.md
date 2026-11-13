## ADDED Requirements

### Requirement: 部署 agent 的工作记忆经平台缝代采与挂载

承载部署 agent 的 runner SHALL 在平台缝上接入舰队记忆：回合观测（工具调用、回合边界、会话边界）由 manager 以该部署的记忆令牌投递到舰队记忆 capture API——与 usage 事件同缝、不进 harness adapter 契约、不要求 harness 自带 hooks；部署的运行时组合 SHALL 自动携带舰队记忆的 MCP 挂载（dsh 经 profile patch、ACP 经 session 的 MCP 传递面，令牌解析与既有凭据纪律同源）与 persona 记忆纪律文案（引导 agent 在会话终局写交接）。舰队记忆不可达时 MUST 降级开放：回合照常执行与计费，代采暂停且如实记录，恢复后继续——记忆缺失永不阻断服务。

#### Scenario: dsh 部署产生观测与交接

- **WHEN** 一个 dsh 部署跑了数个回合并经 MCP 写出交接
- **THEN** manager 代采的回合观测与该交接都落在该部署的 `d/` namespace，可检索

#### Scenario: ACP 部署同样接入

- **WHEN** 一个 ACP harness 部署（如 claude-code）跑回合
- **THEN** 其观测同样经 manager 缝落库，其 MCP 组合含舰队记忆条目

#### Scenario: 记忆面停机不阻断回合

- **WHEN** 舰队记忆服务不可达
- **THEN** 部署回合照常执行、计费照常，manager 记录代采缺口并在服务恢复后继续投递
