# pack-locale-tracks Specification

## Purpose

pack 显示内容的多语言轨道契约:中文为必填主轨、住在既有字符串字段中,多语言副轨以顶层叠加块部分覆盖;缺省与回落永远落到中文,纯字符串旧写法永久合法——国际化是形态副轨,不得让存量包回炉。

## Requirements

### Requirement: 显示字段的 zh 主轨与顶层叠加块
pack manifest 的既有显示字段(name、description、notes、guide.steps、skills[].description、skills[].title、mcpServers[].description、agents[].name、bots[].name/description、cluster、card 文本)SHALL 保持纯字符串形状与既有校验规则不变,其文本即中文(zh)主轨。manifest 的 `skills[]` 条目 SHALL 可选携带 `title`（zh 基轨通俗显示名）；声明 `title` 的技能条目,其显示名按 zh 主轨取 `title`、未声明时回落实名 `name`（slug 身份）——技能 slug 作为运行时身份 SHALL NOT 被任何投影改写。manifest SHALL 可选携带顶层 `i18n` 对象,形状为 `{ <locale>: { <显示字段覆盖> } }`:locale 键 SHALL 匹配 BCP-47 小写主标签形态且 SHALL NOT 为 `zh`(zh 由基字段承担,双写视为非法);每 locale 块内 SHALL 只出现显示字段白名单内的覆盖;数组型字段 SHALL 按索引对齐覆盖,命名实体(skills/agents/bots/card.skills/mcpServers)SHALL 按其在 manifest 中已声明的名字或 id 覆盖。`i18n.skills[<name>]` SHALL 可覆盖 `description` 与 `name`（后者仅当该技能条目声明了 `title`——副轨显示名与 zh 基轨 `title` 对位）。

显示字段白名单 SHALL 同时覆盖结构化的 v2 显示字段:`promise`、`audience`、`outcomes`、`examples`、`domain`、`tags`,以及 `identity.mark.value`。`audience` 与 `domain` 的覆盖 SHALL 是同样长度的数组且逐项对齐基字段;`outcomes` 的覆盖 SHALL 按索引对齐 `title`/`detail`;`examples` 的覆盖 SHALL 按索引对齐 `title`/`prompt`;`tags` 的覆盖 SHALL 是同样长度的字符串数组。结构字段 `identity.accent` 与 `identity.mark.kind` SHALL NOT 进入叠加块——它们是语义而非文案,翻译它们会改变呈现身份。

技能显示名投影 SHALL 与 agents 同构：读时按请求 locale 取 `i18n.skills[<name>].name` 覆盖显示名，覆盖缺失回落 zh 基轨（`title` 声明时）或 slug（未声明时），SHALL NOT 存在经第三语言的回落链；zh 请求与未声明 `title` 的条目 SHALL 逐字节直出。

#### Scenario: 旧式纯字符串 manifest 依旧合法

- **WHEN** 一份不含 `i18n` 键、显示字段为纯字符串的 manifest 提交校验或安装重校验
- **THEN** 其与本次变更前逐字节同规则通过,无任何新增错误或警告

#### Scenario: 合法双语 manifest 通过

- **WHEN** 一份 manifest 的基字段为中文,`i18n.en` 覆盖 name 与全部三步 guide.steps 的 title/body
- **THEN** 校验通过,英文覆盖被存储并可用于按 locale 展示

#### Scenario: `i18n` 块引用未声明实体被拒

- **WHEN** `i18n.en.skills` 试图覆盖一个 manifest `skills` 中不存在的技能名,或 `guide.steps` 索引越界,或 `i18n.en.mcpServers` 试图覆盖 manifest `mcpServers` 中未声明的 registryName
- **THEN** 校验以指明该 locale 与字段路径的结构化错误拒绝

#### Scenario: `zh` 写在叠加块内被拒

- **WHEN** manifest 携带 `i18n.zh` 键
- **THEN** 校验拒绝并指明中文应写在基字段

#### Scenario: mcpServers 描述副轨覆盖合法

- **WHEN** 一份 manifest 的 `i18n.en.mcpServers` 按已声明 registryName 覆盖其 description
- **THEN** 校验通过,英文描述可按 locale 投影,registryName 与连接配置零变化

#### Scenario: 结构化显示字段的副轨覆盖合法

- **WHEN** 一份 manifest 的基字段声明中文 `promise`、2 条 `outcomes`、3 个 `domain`,其 `i18n.en` 分别覆盖 `promise`、同索引的 2 条 `outcomes` 的 `title`、同样长度的 3 个 `domain`
- **THEN** 校验通过,英文请求下卡片承诺、"你会得到"段与领域 chip 全部呈现英文

#### Scenario: 结构化覆盖的数组长度不对齐被拒

- **WHEN** `i18n.en.domain` 声明 2 项而基字段 `domain` 声明 3 项,或 `i18n.en.outcomes` 的条数与基字段不一致
- **THEN** 校验拒绝并指明该 locale、字段路径与两边的条数

#### Scenario: 结构字段进叠加块被拒

- **WHEN** `i18n.en` 块内出现 `identity.accent` 或 `identity.mark.kind`
- **THEN** 校验拒绝,并说明该字段是结构而非文案

#### Scenario: tags 副轨覆盖合法

- **WHEN** 一份 manifest 的基字段 `tags` 为 4 个中文标签,`i18n.en.tags` 为同样长度的 4 个英文标签
- **THEN** 校验通过,英文请求下列表与详情的标签全部呈现英文

#### Scenario: 技能显示名按 locale 投影且 slug 零改

- **WHEN** 某 pack 的技能条目声明 `title`（中文）且 `i18n.en.skills[<name>].name` 为英文,以 `locale=en` 与 `locale=zh` 分别读取已装包技能卡
- **THEN** 英文请求呈现英文显示名、中文请求呈现 `title`,两种语言下技能 slug 与安装/调用键完全一致

#### Scenario: 技能 name 覆盖无 title 对位被拒

- **WHEN** `i18n.en.skills[<name>].name` 出现而对应技能条目未声明 `title`
- **THEN** 校验拒绝并指明该技能缺 zh 基轨 `title` 对位

#### Scenario: 未声明 title 的技能投影零改

- **WHEN** 某 pack 的技能条目只有 `name` 与 `description`,以任意 locale 读取其技能卡
- **THEN** 显示名保持 slug 原文,description 投影行为与变更前一致

### Requirement: locale 解析优先级与 zh 唯一回落

市场与安装读面 SHALL 按以下优先级确定展示 locale:显式 `locale` 请求参数 > 请求 `Accept-Language` 头首选语言 > 默认 `zh`;任何 `zh*` 标签 SHALL 归一为 `zh`。解析某 locale 的显示字段时,该 locale 叠加块缺失或块内该键缺失 SHALL 一律回落对应的 zh 基字段;SHALL NOT 存在经第三语言的回落链(如 en 缺失时回落到另一非 zh 语言)。

#### Scenario: 显式 locale 命中副轨

- **WHEN** 请求以 `locale=en` 读取一份含 `i18n.en` 的市场条目
- **THEN** 被覆盖字段呈现英文文本,未被覆盖字段呈现中文基字段

#### Scenario: 未覆盖 locale 回落中文

- **WHEN** 请求以 `locale=ja` 读取一份仅有 zh 基字段与 `i18n.en` 的条目
- **THEN** 全部显示字段呈现中文基字段

#### Scenario: 无参数请求行为与变更前一致

- **WHEN** 不携带 locale 参数与 Accept-Language 头的旧客户端请求市场列表或详情
- **THEN** 响应中的显示字段与本次变更前逐字节等价(中文基字段)

#### Scenario: 部分覆盖逐键回落

- **WHEN** `i18n.en` 只覆盖 name 未覆盖 description,以 `locale=en` 请求
- **THEN** name 呈现英文,description 呈现中文基字段

### Requirement: 兼容性不变量

display 内容的 locale 结构 SHALL NOT 改变运行时契约:packId、registryName、工具面声明、组闸与计费键一个不动。API 响应 SHALL 保持:不含 `i18n` 感知能力的消费者所读的基字段语义与变更前完全相同;含 overlay 的 manifest SHALL 通过安装面与发布面同一校验器,不产生双规则漂移。

#### Scenario: 含 overlay 的 manifest 过安装重校验

- **WHEN** 一份带 `i18n` 块的已发布版本到达 cell 安装端
- **THEN** 安装面以与发布面相同的规则通过校验并安装,其技能/岗位/persona 内容与 zh 主轨一致

#### Scenario: 运行时标识不因多语言改变

- **WHEN** 一份双语 manifest 被安装
- **THEN** packId、技能名、MCP registryName、组闸与计费键与该包的既有形态完全一致

### Requirement: 分面标签与标签词随请求 locale 呈现

市场读面的分类标签(线词、领域词)与条目标签 SHALL 由服务端按请求 locale 投影;服务端 SHALL NOT 下发与 locale 无关的固定语言标签给非 zh 请求。客户端 SHALL NOT 对标签做二次映射或翻译。

#### Scenario: 英文请求的分面标签是英文

- **WHEN** 以 `locale=en` 请求市场分面
- **THEN** 每个线 chip 与领域 chip 的标签为该 locale 的文案,不出现中文线词

#### Scenario: 未覆盖 locale 的标签回落中文

- **WHEN** 以 `locale=ja` 请求分面,而词表未声明 ja 标签
- **THEN** 标签回落中文主轨,且不出现第三种语言的拼接

#### Scenario: 客户端不二次映射

- **WHEN** 英文界面渲染服务端下发的分面数据
- **THEN** 渲染结果与响应中的标签逐字相同,客户端不基于 slug 自行拼词
