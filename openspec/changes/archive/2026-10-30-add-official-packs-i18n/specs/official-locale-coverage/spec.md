# official-locale-coverage Specification

## Purpose

在仓官方资产（官方助手包、官方 pack、团队模板种子）的 en 副轨覆盖契约：官方资产是平台的门面，
英文访客在市场与登录墙前看到的官方显示面必须已是英文，不允许回落中文。zh 仍是唯一主轨与唯一回落
（契约不放松）；本能力只管「官方资产的副轨必须满」与防漂移门。

## ADDED Requirements

### Requirement: 官方资产的 en 副轨覆盖其 zh 主轨声明的全部显示字段

仓库内官方资产——`docs/official-packs/*.json`、`packs/*/manifest.json`、
`docs/fleet-templates/*.seed.json` 与 `docs/fleet-architect.seed.json`——SHALL 各自携带 `i18n.en`
overlay，且覆盖其 zh 主轨实际声明的每一个显示字段：name、description、notes（声明时）、guide
（三步整组，含每步 title/body）、每条声明 skill 的 description、每个声明 agent 的 name
（带 serving.card 的另覆盖 card.name 与 card.description）。团队种子 SHALL 另携带
`fleet.i18n.en`，覆盖 fleet 名、每个成员岗的 title 与每个 KPI 槽位的 label。
内容字段（技能正文、persona、promptTemplate）SHALL NOT 进 overlay——内容层单语言是既有契约。

#### Scenario: 英文访客看官方包全英文显示面

- **WHEN** 英文访客以 locale=en 打开任一官方 pack 的市场详情
- **THEN** 名称、描述、三步指南、技能描述、agent 名全部为英文，无回落中文的字段

#### Scenario: 英文访客实例化官方团队模板

- **WHEN** 英文用户按 en 实化一份官方团队种子
- **THEN** 团队名、岗位名、KPI 标签呈现英文；节奏 prompt 与 persona 保持中文主轨（内容层不翻）

#### Scenario: 架构师种子无 fleet 段不背 fleet overlay 义务

- **WHEN** 检查 `docs/fleet-architect.seed.json`（无 fleet 段）
- **THEN** 只要求 manifest 级 i18n.en 覆盖，不要求 fleet.i18n

### Requirement: 官方资产 locale 门是防漂移门

单测 SHALL 钉死官方资产的覆盖契约：任一官方资产新增/修改 zh 显示字段而未同步 en 副轨、
overlay 混入 zh 块或非显示键、guide 部分翻译，均 SHALL 红。该门 SHALL 随 `test:unit` 全量跑。

#### Scenario: 新增显示字段漏翻即红

- **WHEN** 官方 manifest 新增一个 guide 步骤而 en overlay 未同步
- **THEN** locale 门失败并指名文件与字段路径

#### Scenario: 部分翻译的 guide 被拒

- **WHEN** en overlay 只翻了三步指南中的一步
- **THEN** 门失败——overlay 规则本就要求整组或全无

#### Scenario: zh 块混入 overlay 被拒

- **WHEN** 任一官方资产出现 `i18n.zh`
- **THEN** 门失败（zh 主轨住在基字段，overlay 声明 zh 视为非法）
