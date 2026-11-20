# agent-builder-workspace Specification

## Purpose
壹座智能体构建器工作区：把智能体文档与团队文档的创作收敛为「一个文档、一条生命周期、一次到运行的闭环」——三栏（文档库 / 画布 / 上下文跟随检查器）的统一创作面，并经既有闸位与发行通道闭环到运行中的团队。

## Requirements

### Requirement: 铸造到运行的闭环与回链

铸成功的文档 SHALL 提供「部署团队」动作：动作自供给域 Studio 发起，经深链进入壹座承接（装机 `reused` 幂等短路 + from-template 通道出生 paused 带待启动横幅）并落该团队运行面；进入壹座承接 SHALL 需要壹座会话，无会话时如实引导登录/注册（发布不需要、运行需要）。团队详情 SHALL 在产物携带铸造追溯（`_casting.blueprintId`）时呈现「来源蓝图」芯片，链接到供给域 Studio 对应文档（跨域回链）。

#### Scenario: 铸→部署→团队页

- **WHEN** 持壹座会话的创作者在供给域 Studio 完成铸造并点「部署团队」
- **THEN** 深链进入壹座完成装机与 from-template，新团队出生为 paused 且界面落在该团队运行面

#### Scenario: 团队回链来源文档

- **WHEN** 打开一支由蓝图铸造而来的团队详情
- **THEN** 来源芯片可见，点击直达供给域 Studio 对应文档

### Requirement: 岗位编制在画布内可编辑

工作区 SHALL 让 team kind 文档的岗位编制（`content.fleet.members`）在画布内可完整编辑，使一份**空白团队文档**能只经 GUI 走到校验全绿。

- 岗位的新增与删除 SHALL 在画布内可达；新增岗位 SHALL 同时在三桶段拥有一个可写 persona 的对应智能体条目，删除岗位 SHALL 一致地清理其对应条目，两个列表 SHALL NOT 出现指向关系断裂（成员指向的 `presetId` 必须命中同文档的 `content.agents[].id`）。
- 单个岗位的以下字段 SHALL 可编辑：岗位标题、目标（target）、上级岗位（`parentRef`）、节奏（被动 / 每小时 / 每天 / 自定义 cron）、节奏提示词（`promptTemplate`）、KPI 槽位（键、标签、单位、目标值）。
- 节奏的语法糖（被动 / 每小时 / 每天 / 自定义）SHALL 复用活舰队建岗面同一套换算，SHALL NOT 在工作区另写第二套 cron 生成逻辑。
- 编辑 SHALL 走文档既有的自动保存通道（`PUT /api/blueprints/:id`），SHALL NOT 引入新的文档写端点。
- 画布上的岗位节点 SHALL 呈现其声明的节奏与 KPI 槽位，SHALL NOT 恒以「无节奏、无槽位」的空态呈现已声明字段。

#### Scenario: 空白团队经 GUI 达校验绿

- **WHEN** 主人新建一份空白团队文档，经画布新增两个岗位并各自填写标题、目标与节奏
- **THEN** 校验全绿（不再出现 `fleet_members_empty`），且成员与 agents 的指向关系闭合

#### Scenario: 岗位抽屉改动即落文档

- **WHEN** 主人在岗位抽屉把某岗节奏从「每天 09:00」改为自定义 cron
- **THEN** 文档 `content.fleet.members[].cadence.cron` 随之更新并经自动保存落库；刷新页面后值不变

#### Scenario: 删岗不留下悬空指向

- **WHEN** 主人删除一个被其余成员节奏提示词引用的岗位
- **THEN** 该成员的删除与对应 agent 条目的清理同时发生，校验如实报出任何因而悬空的指向，不静默通过

### Requirement: 验收断言表单化

team kind 文档的验收断言清单（`content.acceptance`）SHALL 可在画布内以表单增删编辑，SHALL NOT 只经 JSON 轨可写。

- 每条断言 SHALL 可编辑：`id`、`kind`（既有五类断言的闭集）、`target`（岗位标题，可空）、以及 kind 相关的 `expect` / `rubric`。
- 表单产出的断言 SHALL 与 JSON 轨产出逐字段同形，SHALL 经既有 `normalizeAcceptance` 判定；未知 kind、`llm-judged` 缺 rubric、超判据成本闸等既有拒绝条件 SHALL NOT 被表单面放宽或绕过。
- 校验失败的断言 SHALL 在表单行内逐条呈现并定位到该行。

#### Scenario: 表单增删断言后仍过既有校验

- **WHEN** 主人在表单里加一条 `report-landed` 断言、再加一条缺 rubric 的 `llm-judged`
- **THEN** 前者通过，后者在行内报 `acceptance_rubric_required` 并定位到该行，整体校验保持红

#### Scenario: 表单与 JSON 同源

- **WHEN** 主人在表单添加一条断言后切到 JSON 轨
- **THEN** JSON 轨呈现逐字段同形的断言条目，回切表单后值不变
