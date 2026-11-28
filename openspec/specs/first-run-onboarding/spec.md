# first-run-onboarding Specification

## Purpose
壹座首启的单一状态机：把过去分散在客户端 `localStorage` 与服务端布尔里的"引导到哪一步了"收敛成**每用户一份、跨设备一致**的阶段记录，并规定每个阶段**只有一套引导面**可见。它是后续任何装/改引导行为的挂载点。

## Requirements

### Requirement: First-run stage is one server-persisted, per-user record

首启进度 SHALL 以一份按用户的记录持久化在用户自己的 cell store，跟随登录身份跨设备一致，取值为有序阶段之一：`new`、`role_answered`、`provisioned`、`done`。客户端 MUST NOT 自行以浏览器本地存储决定首启阶段；它 SHALL 从服务端读取当前阶段并据此渲染。阶段 SHALL 只前进不后退，除非用户显式重开（帮助中心重放或设置里重选角色）。

#### Scenario: stage follows the user across devices

- **WHEN** a user answers the questionnaire on device A and later opens the app on device B
- **THEN** device B SHALL read stage `provisioned` (or later) and SHALL NOT present the questionnaire again

#### Scenario: stage never regresses on reload

- **WHEN** a user at stage `provisioned` reloads the app
- **THEN** the reported stage SHALL remain `provisioned` and no earlier-stage surface SHALL reappear

### Requirement: Exactly one foreground onboarding surface per stage

任一时刻 SHALL 至多有一个**前景引导面**可见，且与该阶段对应：

- `new`：意图问卷（问角色）；
- `role_answered`：配置确认清单（提交角色后、激活前）；
- `provisioned`：首个成果引导（见 `onboarding-guidance`）；
- `done`：无。

问卷/确认与首个成果引导 MUST NOT 同时可见。造团队门卡片不属于前景引导面：它 SHALL 渲染在建议提问卡**之下**，且 SHALL NOT 在配置确认或首个成果引导可见时出现。

#### Scenario: questionnaire and guidance never co-exist

- **WHEN** a first-run browser reaches the welcome state
- **THEN** the questionnaire and the first-result guidance SHALL NOT both be visible in the same paint

#### Scenario: door never competes with a foreground surface

- **WHEN** the configuration confirmation list or the first-result guidance is visible
- **THEN** the team-building door card SHALL NOT be visible
- **AND** when neither is visible, the door MAY render below the suggested prompts

#### Scenario: no questionnaire surface when no role is recipe-ready

- **WHEN** a user at stage `new` is on a deployment whose ready-role set is empty
- **THEN** no questionnaire SHALL render
- **AND** the stage SHALL advance as if the questionnaire was skipped, without trapping the user

### Requirement: Legacy first-run markers migrate without re-prompting

升级到该状态机时，已有的首启痕迹 SHALL 一次性映射到阶段，且 MUST NOT 让已被用户关闭过引导的人被重新弹出：

- 用户已答问卷（有角色）且本地 tour 完成标记存在 → `done`；否则 → `provisioned`；
- 用户跳过了问卷 → `done`；
- 问卷为空但本地 tour 完成标记存在 → `done`；
- 其余 → `new`。

映射 SHALL 幂等：第二次读取不得改变已得到的阶段，也不得覆盖用户在迁移后产生的新进度。

#### Scenario: dismissed-tour user is not re-nagged

- **WHEN** an existing user had set the client tour-done marker but never answered the questionnaire
- **THEN** the migrated stage SHALL be `done`
- **AND** neither the questionnaire nor the guidance SHALL be presented on next launch

#### Scenario: answered user with no tour proceeds to guidance

- **WHEN** an existing user has recorded roles but had never completed the old tour
- **THEN** the migrated stage SHALL be `provisioned` and the first-result guidance MAY appear once

#### Scenario: migration is idempotent

- **WHEN** the migration runs twice
- **THEN** the stage SHALL be unchanged by the second run

### Requirement: Every stage transition is recorded for measurement

每次阶段迁移 SHALL 记一条可读的持久事件，至少含：前一阶段、新阶段、时间戳、该用户标识，以及迁移来源（问卷、跳过、激活、重放、迁移）。这些事件 SHALL 可被运维读取，用于回答"多少人走到哪个阶段、在哪一步流失"。记录 SHALL 在迁移本身成功之后写入，且记录失败 MUST NOT 回滚或阻断阶段迁移。

#### Scenario: transition is observable

- **WHEN** a user advances from `role_answered` to `provisioned`
- **THEN** exactly one durable event records that transition with its timestamp and source

#### Scenario: telemetry failure does not block onboarding

- **WHEN** writing the transition event fails
- **THEN** the stage SHALL still advance and the user SHALL proceed unimpeded
