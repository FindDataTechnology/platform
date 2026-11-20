## Purpose

供给注释层：给 MCP server、MCP tool、skill 三类供给对象一份同构注释（human 五语言轨 + canonical brief + provenance），四源合并、读时投影、零源行改写。human 轨让普通人看得懂（zh 主轨通俗名+一句话+何时用），canonical 轨面向智能体（运行时消费归 `add-tool-description-enrichment`）。缺注释的对象如实渲染原文，永不发明。

## Requirements

### Requirement: 三类对象同构注释形状

每条注释 SHALL 挂在三类对象之一：MCP server（按 registryName）、MCP tool（按 server+leaf 名）、skill（按 skill 名）。注释 SHALL 含：`human`（zh 主轨必填：通俗名与一句话说明与何时用；en/ja/es/fr 副轨可选，形状同主轨）与可选 `canonical`（面向智能体的精准 brief，字符串）；MUST NOT 携带执行语义。注释 SHALL 含 provenance（来源与更新时间）。`human.zh` 为唯一必填内容轨——未填 zh 的注释 SHALL 视为非法不参与投影。

#### Scenario: 完整注释合法

- **WHEN** 一条 MCP server 注释含 zh 主轨（名+一句话+何时用）、en 副轨、canonical brief 与 provenance
- **THEN** 注释通过校验并可参与读时投影

#### Scenario: 仅 human 无 canonical 合法

- **WHEN** 一条注释只有 zh 主轨、无 canonical
- **THEN** 注释合法，canonical 侧消费面（运行时增强）对该对象不生效

#### Scenario: 缺 zh 主轨被拒

- **WHEN** 一条注释只有 en 内容、无 zh 主轨
- **THEN** 注释被拒并指明 zh 主轨必填

### Requirement: 四源合并与读时投影

注释投影 SHALL 按优先级合并四源：registry 行 metadata > 仓库注释源（`market-annotations.json`）> 仓库内供给目录（`market-catalog.json`）> 上游原文；高优先级源的字段逐字段覆盖低优先级源。投影 SHALL 发生在读面（目录读、卡片读、规格书读），MUST NOT 改写任何源行（extensions DB 行、registry 条目、仓库文件）。投影结果 SHALL 原样透出合并后的字段与 provenance。

#### Scenario: registry 覆盖仓库目录

- **WHEN** 同一 server 在 registry metadata 与仓库目录都有 human 名
- **THEN** 读面呈现 registry 的名，provenance 标 registry 来源

#### Scenario: 无注释如实原文

- **WHEN** 一台 server 四源均无注释
- **THEN** 该对象的渲染与未引入注释层前逐字节一致（上游原文）

### Requirement: 仓库注释源对 registry 条目生效

对 registry 来源的目录条目，仓库根 `market-annotations.json`（键 = registry 条目 name，即 `pathToName` 结果，无前导斜杠；值形状同本契约）SHALL 作为 registry 行 metadata 之外的第二注释真源，在与桥快照合并点（唯一一处）逐字段并入条目注释：registry metadata 压过仓库注释源，仓库注释源补 registry 缺失字段；`tools` 按 leaf 合并，provenance 跟随胜者。深度视图的工具行集合 SHALL 恒以 registry `tool_list` 为准——注释只装饰既有行，MUST NOT 凭文件新增工具行。bundled 条目的注释键路径 SHALL 零改。条目缺失/损坏的注释 SHALL 被丢弃并告警，MUST NOT 抛错。registry 行 metadata 与仓库注释源皆空的条目 SHALL 维持无注释渲染。

#### Scenario: registry 压过仓库注释源

- **WHEN** 同名条目的 `human.en` 同时存在于 registry metadata 与仓库注释源且内容不同，文件另有 `human.ja`
- **THEN** 英文渲染取 registry 值，`human.ja` 仍来自仓库注释源

#### Scenario: 文件缺失降级为空表

- **WHEN** 镜像内无 `market-annotations.json`（或文件损坏）
- **THEN** 服务正常启动，全部条目按 registry metadata > 仓库目录 > 原文链渲染，与今天一致

#### Scenario: 注释不发明工具行

- **WHEN** 仓库注释源的 `tools` 含某 leaf 而该 leaf 不在条目 registry `tool_list` 中
- **THEN** 深度视图工具列表不因此新增行（注释存在与否不改变行集合）

### Requirement: locale 解析与 zh 唯一回落

注释投影 SHALL 沿 `pack-locale-tracks` 同款解析优先级：显式 `locale` 参数 > 请求 `Accept-Language` 首选 > 默认 zh；`zh*` 标签 SHALL 归一为 zh。请求 locale 的副轨缺失时 SHALL 回落 zh 主轨；zh 主轨缺失（未注释对象）SHALL 回落上游原文；SHALL NOT 存在经第三语言的回落链。

#### Scenario: 副轨缺失回落 zh

- **WHEN** 以 `locale=ja` 请求一台仅有 zh+en 注释的 server
- **THEN** 渲染 zh 主轨内容

#### Scenario: 未注释回落原文

- **WHEN** 以任意 locale 请求一台无任何注释的 server
- **THEN** 渲染上游原文（与今天一致）

### Requirement: 壹座 MCP 卡与市场卡注释渲染

壹座已装 MCP 卡与市场 MCP 卡 SHALL 在注释存在时渲染 human 通俗名与一句话说明替代裸显 `server.name`；连接要素（command/args/url）SHALL 折叠进高级区且可展开查阅原值。市场目录条目 SHALL 同规则渲染注释。壹座扩展页技能卡（`GET /api/extensions/skills` 列表的 registry 来源技能与文件技能）SHALL 在注释存在时按请求 locale 渲染 human 通俗名与一句话说明——registry 来源技能取 `metadata.annotations`，文件技能取仓库注释源 `skills` 键——slug 名 SHALL 保留可见（等宽字体），MUST NOT 被替换。无注释对象 SHALL 保持现有渲染不变（逐字节）。

#### Scenario: 有注释卡

- **WHEN** 一台已装 server 携带 zh 注释
- **THEN** 卡片标题渲染通俗名、描述渲染一句话说明
- **AND** 连接要素折叠可展开，展开值与源配置一致

#### Scenario: 无注释卡不变

- **WHEN** 一台已装 server 无注释
- **THEN** 卡片渲染与未引入注释层前一致

#### Scenario: 技能卡按 locale 呈现通俗名

- **WHEN** 以 `locale=zh` 读取一个携带 zh 注释的 registry 技能条目
- **THEN** 技能卡渲染中文通俗名与一句话说明，slug 名仍以等宽字体可见
- **WHEN** 同一条目以 `locale=en` 读取且注释含 en 副轨
- **THEN** 渲染英文通俗名

#### Scenario: 文件技能经仓库注释源呈现

- **WHEN** 以 `locale=zh` 读取一个文件技能条目且仓库注释源 `skills` 键含其注释
- **THEN** 技能卡渲染中文通俗名与一句话说明；该技能不在仓库注释源内时渲染原文

#### Scenario: 无注释技能逐字节不变

- **WHEN** 以任意 locale 读取一个无任何注释的技能条目
- **THEN** 响应形状与字段与未引入本变更前逐字节一致

### Requirement: 聊天工具块通俗标签

聊天流中工具调用块 SHALL 在注释存在时于原始 tool 名旁渲染该 tool 的 localized 通俗标签；原始 tool 名 SHALL 保留可见（等宽字体与复制/展开均用原名），MUST NOT 被替换。技能调用块 SHALL 同规则渲染：注释索引 SHALL 增设 `skills` 键（技能名 → `{ label, summary }`，随请求 locale 投影），技能块在注释存在时于 slug 名旁渲染 localized 通俗标签。无注释 tool 与 skill SHALL 渲染不变。

#### Scenario: 有注释工具块

- **WHEN** 一个带 zh 注释的 tool 被调用并渲染工具块
- **THEN** 块内同时可见通俗标签与原始 tool 名，复制得到原始名

#### Scenario: 无注释工具块不变

- **WHEN** 一个无注释 tool 被调用
- **THEN** 工具块渲染与未引入注释层前一致

#### Scenario: 技能调用块渲染通俗标签

- **WHEN** 一个带 zh 注释的技能被调用并渲染技能块，索引按 `locale=zh` 构建
- **THEN** 块内同时可见中文通俗标签与原始 slug 名，复制得到 slug
- **WHEN** 索引 `skills` 键中无该技能
- **THEN** 技能块渲染与未引入本变更前一致

### Requirement: 规格书工具桶注释渲染

三桶规格书（full 变体）的工具桶 SHALL 按注释存在与否渲染 server 通俗名或原始 registryName；两种情形 SHALL 均可见原始标识。工具桶渲染 MUST NOT 改变工具面声明的数据（declared/full-surface 语义不变）。

#### Scenario: 工具桶通俗可读

- **WHEN** 规格书渲染一台有注释的 server
- **THEN** 工具桶显示通俗名且原始 registryName 可见

### Requirement: 运行时契约与源行零改

注释层 SHALL NOT 改变运行时契约：registryName、tool 名、skill 名、工具面声明、闭包闸键一个不动。任何展示面与读面 MUST NOT 经注释写回源行或 registry 条目。

#### Scenario: 闭包闸键不受注释影响

- **WHEN** 一份 pack 的工具面闭包校验在注释存在与否两种情形下分别执行
- **THEN** 两次校验的键集合与结果完全一致

#### Scenario: 注释投影只读

- **WHEN** 任意展示面读取带注释对象
- **THEN** 源行、registry 条目、仓库目录文件零写操作
