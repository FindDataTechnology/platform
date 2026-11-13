# supply-annotation-overlay 增量（add-skill-display-annotations）

## MODIFIED Requirements

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
