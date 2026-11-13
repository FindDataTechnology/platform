# release-line-hygiene Specification

## Purpose
发布分支的推送前卫生：让"过不了 lint 的提交"在离开本机之前就被拦住，而不是等到出片 CI 才红——那时的提交已经在共享分支上，只能由别人替它清账。

## Requirements

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

### Requirement: Release-line CI queues runs instead of cancelling them

出片车间的 CI SHALL 对同一 ref 采取**串行排队**，不得用 `cancel-in-progress` 顶掉正在运行的一轮。

判据是这条 CI 的时长结构：单测真跑约 26 分钟，而工作区允许多个会话并行开发、各自出片。在这个组合下"后推顶掉前推"意味着**先开始的那一次几乎必定跑不完**——它不是在节省资源，而是在让出片不可用，并且每次都实烧一轮额度。

- 同一 ref 的多次推送 SHALL 排队，后来的等待前面的结束，而不是取消它。
- 不同 ref 之间 MAY 并行（并发组按 ref 划分）。
- 一次被取消的运行 SHALL NOT 被当作失败计入结论，但**取消本身不得成为常态**：如果同一 ref 上出现连续取消，那是并发策略问题的信号，而不是某次推送的运气不好。
- 排队状态 SHALL 对推送者可见（`queued` 与 `in_progress` 可区分），使"我的片在等"与"我的片在跑"不会混淆。

#### Scenario: a second push waits for the first run

- **WHEN** 同一 ref 上已有一轮出片 CI 在运行，此时又推一次
- **THEN** 新的运行 SHALL 进入 `queued`
- **AND** 正在运行的那一轮 SHALL NOT 被取消
- **AND** 只有它结束后，排在后面的那一轮才开始

#### Scenario: a long unit-test step completes

- **WHEN** 一轮运行进入单测步骤并需要超过 20 分钟
- **THEN** 该步骤 SHALL 跑到结束（通过或失败），不因新推送而中断

#### Scenario: cancellation is treated as a signal, not as noise

- **WHEN** 同一 ref 上出现连续多轮被取消的运行
- **THEN** 这 SHALL 被视为并发策略配置问题（需要排队而非取消），而不是个别推送的失败

### Requirement: A snapshot pushed to the image mirror carries the mirror's publish workflow

The release tooling SHALL provide a step that seeds the workflows the image mirror requires but the public snapshot
deliberately excludes (`.github/workflows/image-publish.yml`) into a generated snapshot tree before that tree is
pushed, and SHALL fail loudly rather than proceed when a required workflow cannot be seeded.

The step SHALL copy each listed workflow from the repository into the snapshot tree, then re-read the destination and
compare it, treating a source that does not exist, an unreadable or unwritable path, or a destination that does not
match afterwards as an error that names the offending path. It SHALL be idempotent: a destination already byte-identical
to the source is left unmodified, so a repeated run produces no diff. It SHALL exit non-zero if any listed workflow is
missing or mismatched, and zero only when every one is present and identical. The snapshot generator's operator-facing
completion hint SHALL name this step, so the documented flow cannot silently omit it.

#### Scenario: A fresh snapshot gains the publish workflow

- **WHEN** the seeding step runs against a snapshot tree that does not contain `image-publish.yml`
- **THEN** the file is copied from the repository into `.github/workflows/` of that tree and the step exits 0

#### Scenario: A second run changes nothing

- **WHEN** the seeding step runs again against the same tree
- **THEN** every destination already matches byte-for-byte, nothing is rewritten, and the step still exits 0

#### Scenario: A missing source is an error, not a skip

- **WHEN** a listed workflow does not exist in the repository
- **THEN** the step names that path and exits non-zero, so the push never proceeds on an incomplete tree

#### Scenario: The completion hint names the step

- **WHEN** the snapshot generator finishes and prints its next steps
- **THEN** the printed flow includes the seeding step before the push to the mirror
