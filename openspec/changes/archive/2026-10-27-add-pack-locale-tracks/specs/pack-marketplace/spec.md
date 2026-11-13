# pack-marketplace Specification (delta)

## ADDED Requirements

### Requirement: 发布门校验多语言叠加块

发布门与 dry-run 校验 SHALL 对 manifest 顶层 `i18n` 块(形状见 pack-locale-tracks)执行以下规则,违者以**逐字段点名**的结构化错误拒绝(沿既有 `entry` 风格,形如 `i18n.en.guide.steps[1].title`):每个覆盖值 SHALL 为非空字符串且遵守与对应基字段相同的长度帽;`guide.steps` 在同一 locale 下 SHALL 要么三步 title 与 body 全部覆盖、要么整组缺省,半步散件 SHALL 被拒;数组索引越界与未声明的命名实体引用 SHALL 被拒;locale 键形非法或为 `zh` SHALL 被拒。**BREAKING 说明**:本规则只新增可选块的校验——不含 `i18n` 的既有 manifest 行为不变。

#### Scenario: 结构一致性断裂被拒

- **WHEN** `i18n.en` 覆盖 guide 三步中的两步或只覆盖某步的 title 未覆盖 body
- **THEN** 发布门拒绝,报错指名为 `i18n.en.guide` 的结构不完整

#### Scenario: 逐 locale 长度帽parity

- **WHEN** `i18n.en.description` 超过 description 的长度上限
- **THEN** 发布门拒绝并点名 `i18n.en.description`,错误文案与基字段帽同款

#### Scenario: dry-run 与正式发布同规则

- **WHEN** 同一份含非法 `i18n` 块的 manifest 分别提交 dry-run 校验端点与发布端点
- **THEN** 两处返回完全相同的逐字段点名错误清单,且不存储任何版本

### Requirement: 长度比率与 en 副轨禁辞扫描

对长文覆盖字段(description 与 guide.steps[].body),发布门 SHALL 强制每 locale 覆盖文本与 zh 基字段的字符长度比率不超过 3:1(双向:`|loc| / |zh|` 与 `|zh| / |loc|` 均 ≤3),越界以可读报错拒绝(比率门槛仅拦截语种错位/内容贴错,正常翻译膨胀不受影响);比率 SHALL 设有最小长度地板,任一侧短于该地板即不施比率(极短字段的合法译长不构成信号)。发布门 SHALL 对 `i18n` 块内全部英文字符串执行与营销物料审计同款(ABSOLUTE_CLAIM_RE 同规则)的绝对化表述扫描,违例逐字段点名拒绝。zh 基字段本版本不施该扫描。

#### Scenario: 长度比率越界被拒

- **WHEN** zh 基 description 为 40 字,`i18n.en.description` 为 200 字符(比率 5:1)
- **THEN** 发布门拒绝并报该字段比率越界

#### Scenario: en 绝对化表述被拦

- **WHEN** `i18n.en` 任一字符串命中绝对化宣称禁辞(如 "fully replace your team")
- **THEN** 发布门拒绝并点名该 locale 字段路径

#### Scenario: 短字段豁免比率

- **WHEN** zh 基的 `i18n.en` name 覆盖为短字段且比率超过 3:1
- **THEN** 不触发比率错误(短字段不在比率门槛内),仅长度帽生效

### Requirement: 市场浏览与详情按 locale 解析

市场列表摘要与详情响应 SHALL 按 pack-locale-tracks 的解析优先级与回落规则呈现显示字段:name、description、tags(tag 检索语义不变)、guide 及详情内卡片文本按请求 locale 投影;列表行的冗余索引列(name/description/tags)SHALL 继续存 zh 主轨文本,搜索(`search`/`tag` 参数)行为与变更前一致(zh 检索);按非 zh locale 读取列表时 name/description 呈现叠加块覆盖值,搜索范围不变。

#### Scenario: 双语条目列表行按 locale 呈现

- **WHEN** 市场列表请求携带 `locale=en`,某条目含 `i18n.en.name`/`i18n.en.description`
- **THEN** 该条目摘要行呈现英文覆盖值;不含覆盖的条目呈现中文

#### Scenario: 搜索保持 zh 语义

- **WHEN** 以 `locale=en` 且 `search=<英文关键词>` 请求市场列表
- **THEN** 检索仍在 zh 冗余列上进行,行为与无 locale 参数时一致(本版本不提供多语检索)

#### Scenario: 无 locale 请求响应字节等价

- **WHEN** 旧客户端(不传 locale、无 Accept-Language)请求列表与详情
- **THEN** 响应显示字段与本次变更前逐字节等价
