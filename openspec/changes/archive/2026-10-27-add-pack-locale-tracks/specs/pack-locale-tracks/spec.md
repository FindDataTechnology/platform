# pack-locale-tracks Specification (delta)

## Purpose

pack 显示内容的多语言轨道契约:中文为必填主轨、住在既有字符串字段中,多语言副轨以顶层叠加块部分覆盖;缺省与回落永远落到中文,纯字符串旧写法永久合法——国际化是形态副轨,不得让存量包回炉。

## ADDED Requirements

### Requirement: 显示字段的 zh 主轨与顶层叠加块

pack manifest 的既有显示字段(name、description、notes、guide.steps、skills[].description、agents[].name、bots[].name/description、cluster、card 文本)SHALL 保持纯字符串形状与既有校验规则不变,其文本即中文(zh)主轨。manifest SHALL 可选携带顶层 `i18n` 对象,形状为 `{ <locale>: { <显示字段覆盖> } }`:locale 键 SHALL 匹配 BCP-47 小写主标签形态且 SHALL NOT 为 `zh`(zh 由基字段承担,双写视为非法);每 locale 块内 SHALL 只出现显示字段白名单内的覆盖;数组型字段 SHALL 按索引对齐覆盖,命名实体(skills/agents/bots/card.skills)SHALL 按其在 manifest 中已声明的名字或 id 覆盖。

#### Scenario: 旧式纯字符串 manifest 依旧合法

- **WHEN** 一份不含 `i18n` 键、显示字段为纯字符串的 manifest 提交校验或安装重校验
- **THEN** 其与本次变更前逐字节同规则通过,无任何新增错误或警告

#### Scenario: 合法双语 manifest 通过

- **WHEN** 一份 manifest 的基字段为中文,`i18n.en` 覆盖 name 与全部三步 guide.steps 的 title/body
- **THEN** 校验通过,英文覆盖被存储并可用于按 locale 展示

#### Scenario: `i18n` 块引用未声明实体被拒

- **WHEN** `i18n.en.skills` 试图覆盖一个 manifest `skills` 中不存在的技能名,或 `guide.steps` 索引越界
- **THEN** 校验以指明该 locale 与字段路径的结构化错误拒绝

#### Scenario: `zh` 写在叠加块内被拒

- **WHEN** manifest 携带 `i18n.zh` 键
- **THEN** 校验拒绝并指明中文应写在基字段

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
