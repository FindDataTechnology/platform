# builder-team-templates Specification

## Purpose
官方 Builder teams 集：把「帮用户建团队」的三类创作（建现役团队、建模板蓝图、建智能体）收进一组
一等公民官方 pack。纪律一律是**只产草稿、不代发布**——builder 产出进既有草稿池、走既有校验链，
生效永远在人的批准与既有门后。

## Requirements

### Requirement: 官方 Builder 集四员且分工互斥

平台 SHALL 维护四员官方 Builder 集，分工互斥不重叠：**团队架构师**（NL→现役团队草稿，既有
`agent-fleet-architect` 能力）、**蓝图构造师**（NL→模板蓝图草稿）、**智能体作者**（面试式→通用
pack manifest 草稿）、**分身工坊**（→分身 facade pack，既有能力）。每员 SHALL 是经既有铸造链上架
的官方 pack，携带官方徽章（判定消费 `official-pack-showcase` 的部署侧名单，非作者自报）。
集成员的 persona SHALL 声明自己的分工边界并拒绝越界请求（架构师不管作战、构造师不碰现役团队、
作者不代发布、工坊只做分身）。

#### Scenario: 四员齐且各就各位

- **WHEN** 用户打开创建团队、创建蓝图、创建智能体、创建分身任一入口
- **THEN** 空态或引导分别指向架构师/蓝图构造师、蓝图构造师、智能体作者、分身工坊，无一处指向两个 Builder

#### Scenario: 构造师拒绝越界到现役团队

- **WHEN** 用户让蓝图构造师「直接把这条编成现役团队」
- **THEN** 它说明自己只产模板蓝图草稿，并把用户引导给团队架构师，不调用任何现役写面

### Requirement: 蓝图构造师经工具面直通草稿池

蓝图构造师 SHALL 携带 bundled 工具面（`blueprint_draft`/`blueprint_validate`/`blueprint_save`，
loopback 桥身份沿架构师惯例=cell owner）：`blueprint_validate` SHALL 调用既有蓝图校验链并逐条
返回结构化错误（禁新立第二套校验）；`blueprint_save` SHALL 把草稿写入既有蓝图草稿池（与手工粘贴
同一池），未过校验的草稿 SHALL 拒绝落池并指名错误。工具面 SHALL NOT 提供批准（approve）、铸造
（cast）、删除或试跑类写面——那些属于主人批准闸与双钥匙纪律。

#### Scenario: 对话内起草即见校验结果

- **WHEN** 用户对蓝图构造师描述一个场景，构造师组稿并调用 blueprint_validate
- **THEN** 校验错误逐条呈现（指名字段），修复后 blueprint_save 落池，蓝图构造间草稿列表可见该草稿

#### Scenario: 未过校验不落池

- **WHEN** 构造师对含环的编导边调用 blueprint_save
- **THEN** 工具以结构化错误拒绝，草稿池不出现半成品

#### Scenario: 工具面无批准与铸造

- **WHEN** 检查构造师工具集
- **THEN** 不存在 approve/cast/trial/delete 类工具；批准与铸造只能由主人在蓝图构造间完成

### Requirement: 智能体作者产过校验的 manifest 草稿且不代发布

智能体作者 SHALL 以既有 pack 草稿 API（`/api/pack-drafts*`，`requireMcpManage` 同权限）为唯一写面：
采访产出经既有草稿模型落草稿，manifest 组稿 SHALL 通过既有 `validatePackManifest` 才交付；MCP 引用
SHALL 从市场目录选取（禁自由端点，沿 pack 编辑器 v1 内容边界）。作者 SHALL NOT 提供发布、上架、
定价或部署类工具面——发布走既有发布门，由人完成。

#### Scenario: 面试到草稿全链

- **WHEN** 用户回答作者的能力域采访并确认
- **THEN** 一份草稿出现在 pack 草稿池，其组稿 manifest 过 validatePackManifest，用户可在编辑器继续加工

#### Scenario: 作者不代发布

- **WHEN** 用户让作者「直接帮我发布上架」
- **THEN** 作者说明发布走设置→智能体→我的智能体的既有发布门，并给出草稿所在位置，不调用任何发布写面

### Requirement: Builder 集随种子供给且过官方 locale 门

四员的在仓种子/manifest SHALL 过 pack 清单校验并纳入 `official-locale-coverage` 门（en 副轨覆盖
全部显示字段）；蓝图构造师与智能体作者的新种子 SHALL 在 `platform.bundle.json` 登记 bundled
自激活（同架构师惯例），离线 bundle 供给道同等可见（沿 `offline-pack-supply` 语义）。

#### Scenario: 新种子过门

- **WHEN** 两份新种子入库后跑官方 locale 门与 pack 校验
- **THEN** en 副轨覆盖完整、校验零 error，测试钉住必须通过

### Requirement: 有工具面的 Builder 必须宣布窄面且不得留空

四个官方 Builder 中，**凡引用 MCP 服务器的** SHALL 为它使用的每一台服务器声明非空工具白名单。
团队架构师 / 蓝图构造师 / 智能体作者三者各自使用一台建设分钟台（舰队编制面 / 蓝图起草面 /
智能体起草面），因此 SHALL 各自声明该台服务器及其工具叶。MUST NOT 以「声明了服务器但
`allowTools` 为空」或是「不声明任何服务器」的形式上架——在运行时「未声明」等于「不裁剪」，
会把全量工具面交给一个只应产草稿的岗位。

分身工坊没有自己的 MCP 面（它是纯技能引导岗，产出是 manifest 文本），因此不在本条范围内：
它的门不是「声明窄面」，而是「不引入任何工具面」。

发布门 SHALL 对「上述三个 Builder 的 manifest 声明了零台 MCP 服务器」判红并指名该 pack；
对非 Builder 的 pack 保持既有语义（无引用即无此检查），对分身工坊保持既有语义。

#### Scenario: 空声明被发布门判红

- **WHEN** 团队架构师 / 蓝图构造师 / 智能体作者任一 manifest 的 `mcpServers` 为空数组或缺失
- **THEN** 发布门拒绝发布并指名该 pack 与缺失的建设分钟台
- **AND** MUST NOT 以「无引用即免检」静默通过

#### Scenario: 已上架的窄面声明生效

- **WHEN** 用户以团队架构师身份发起一轮对话
- **THEN** 该岗可见工具面包含舰队编制读/草稿工具与跨面提案工具
- **AND** 不含发布、实例化、启停类写工具（per `fleet-meta-line` 的写面禁令）

#### Scenario: 纯技能引导岗不被误判

- **WHEN** 分身工坊的 manifest 不声明任何 MCP 服务器
- **THEN** 发布门不因本条拒绝它
- **AND** 它的工具面仍然来自部署基线，不由本包声明

#### Scenario: 非 Builder 的既有 pack 不受影响

- **WHEN** 发布一个不引用任何 MCP 服务器的既有形态 pack
- **THEN** 发布门不因本条新增检查而拒绝它
