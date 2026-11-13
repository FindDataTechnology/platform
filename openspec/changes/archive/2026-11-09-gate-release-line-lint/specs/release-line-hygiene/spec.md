## Purpose

发布分支的推送前卫生：让"过不了 lint 的提交"在离开本机之前就被拦住，而不是等到出片 CI 才红——那时的提交已经在共享分支上，只能由别人替它清账。

## ADDED Requirements

### Requirement: Push-time lint gate over the pushed range

推送前 SHALL 对**本次推送涉及的文件**跑一次 lint，而不是对全仓跑：判据是「本次推送改了哪些文件」，因为这些才是推送者能负责的范围，历史欠账不属于本次推送。

- 范围取 `git diff --name-only <远端>..HEAD`（远端不可判定时退化为 `HEAD~1..HEAD`），只保留代码文件（`web/src`、`packages`、`server`、`scripts`、`e2e`、`test` 下的 `.ts/.tsx/.js/.mjs`）。
- 判定工具 SHALL 与出片 CI 用同一个（Biome），并且同一份改动在本地与 CI 上给出同一结论——两套判据必然漂移。
- 通过时静默放行（不打印噪音）；失败时拒绝推送，并 MUST 同时给出：违规文件与位置、每条规则的一句话修法、以及"这是本次推送引入的"这一范围的说明。
- 本次推送没有任何代码文件时 SHALL 直接放行（空推送不得误报）。

#### Scenario: a pushed range with a lint violation is refused

- **WHEN** 本次推送包含一处会让 `biome check` 报错的改动
- **THEN** 推送 SHALL 被拒绝，退出码非零
- **AND** 输出 SHALL 指名违规文件、位置与修法
- **AND** 远端分支 SHALL 保持不变

#### Scenario: pre-existing debt in untouched files does not block

- **WHEN** 本次推送只改 A 文件，而 B 文件里存在历史 lint 违规
- **THEN** 推送 SHALL 放行（判据只覆盖本次改动的文件）

#### Scenario: an empty or docs-only push passes

- **WHEN** 本次推送没有代码文件改动
- **THEN** 闸 SHALL 直接放行，不产生任何检查输出

### Requirement: The gate has a documented escape hatch

闸 SHALL 支持一个显式逃生阀（环境变量），用于紧急回滚等必须推送的情形；使用时 MUST 打印一行警告说明风险，且该逃生阀 SHALL 不影响 CI 侧的同款检查（CI 仍然会红，只是不挡推送）。

#### Scenario: escape hatch bypasses locally but not in CI

- **WHEN** 推送者带逃生阀推送一处违规
- **THEN** 本地闸 SHALL 放行并打印警告
- **AND** CI 的同款检查 SHALL 仍然报红并指名文件

### Requirement: One implementation for both entry points

本地钩子与 CI SHALL 调用同一个检查实现（一个脚本/模块），不得各写一套。判据、文件过滤与输出格式 SHALL 由该实现单点决定；两个入口只负责"取范围"和"退出码"。

#### Scenario: the same change yields the same verdict

- **WHEN** 同一份改动经本地钩子与经 CI 各判一次
- **THEN** 两次结论 SHALL 一致（同样放行或同样拒绝），且指名的文件相同
