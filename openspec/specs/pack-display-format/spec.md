# pack-display-format Specification

## Purpose
市场条目的显示格式契约：在既有纯字符串显示字段之上，新增一组可选的"结构化显示字段"（印章标识、一句话承诺、适用人群、你会得到、可点示例、领域），让卡片与详情能按结构渲染而不是把长描述硬切成两行；全部可选、缺省降级、不写则逐字节不变。

## Requirements

### Requirement: v2 显示字段的形状与上限

manifest SHALL 可选携带以下显示字段，每个字段独立可选，形状与上限如下；任一项形状非法或超出上限 SHALL 被发布面与安装面共用的同一校验器以指名该字段路径的结构化错误拒绝：

- `identity`：对象，可含 `mark` 与 `accent`。`identity.mark` SHALL 为 `{ kind, value }`，`kind` ∈ `glyph` / `emoji` / `image`，`value` 为 1-2 个字符（`glyph`/`emoji`）或一个受控引用串（`image`）；`identity.accent` SHALL 是分类体系的线 slug 之一，作者不可自由填写色值。
- `promise`：字符串，用于卡片与详情的一句话承诺，长度上限按显示宽度计（CJK 计 2）不超过 60。
- `audience`：字符串数组，1-3 项，每项 SHALL 是领域词表中的一个 slug。
- `outcomes`：对象数组，2-5 项，每项 `{ title, detail? }`；`title` 非空且显示宽 ≤ 40，`detail` 可选且显示宽 ≤ 160。
- `examples`：对象数组，2-4 项，每项 `{ title, prompt }`；`title` 非空且显示宽 ≤ 40，`prompt` 非空且显示宽 ≤ 400。
- `domain`：字符串数组，1-3 项，每项 SHALL 是领域词表中的一个 slug。

以上字段 SHALL NOT 改变任何运行时契约：packId、技能名、MCP `registryName`、工具面声明、组闸与计费键一个不动。

#### Scenario: 完整的 v2 manifest 通过校验

- **WHEN** 一份 manifest 同时声明 `identity`、`promise`、`audience`、`outcomes`、`examples`、`domain`，且全部字段在各自形状与上限之内
- **THEN** 校验通过，字段被存储并可按 locale 投影到市场读面

#### Scenario: 承诺超宽被拒

- **WHEN** 一份 manifest 的 `promise` 显示宽度为 61（例如 31 个 CJK 字符）
- **THEN** 校验拒绝，错误指名 `promise` 并按显示宽度说明上限

#### Scenario: 领域未在词表内被拒

- **WHEN** 一份 manifest 的 `domain` 含一个不在领域词表中的 slug
- **THEN** 校验拒绝，错误指名该 slug 与 `domain` 字段路径

#### Scenario: 示例条数越界被拒

- **WHEN** 一份 manifest 的 `examples` 只声明 1 项，或声明 5 项
- **THEN** 校验拒绝并说明允许区间为 2-4 项

#### Scenario: 色值不可自由填写

- **WHEN** 一份 manifest 的 `identity.accent` 写成十六进制颜色值
- **THEN** 校验拒绝，并说明该字段只接受线 slug

### Requirement: 缺省降级链

当 v2 显示字段缺失时，市场读面 SHALL 按固定降级链渲染，SHALL NOT 渲染空槽位、SHALL NOT 用截断半句填充：

- 卡片承诺位：`promise` → `description` 的首句（截至第一个句末标点，含该标点）→ `name`。首句超过承诺位宽上限时 SHALL 按整词边界截断并补省略号，SHALL NOT 按字符硬切。
- 卡片适用人群位：`audience` → 省略该槽位（不渲染空行）。
- 卡片边界位：`notes` 的首句 → 省略该槽位。
- 详情"你会得到"：`outcomes` → 由 `guide.steps` 的 step 标题组成的 3 条 → 省略该段。
- 详情"示例指令"：`examples` → 省略该段。
- 印章标识：`identity.mark` → 服务端按该条目的线归位与结构徽章生成的印章字。
- 领域：`domain` → 由存储的 `category` 归位推导。

#### Scenario: 老 manifest 的卡片仍然完整

- **WHEN** 一个不含任何 v2 字段、只声明 name/description/notes/tags 的既有 pack 被列表读取
- **THEN** 卡片渲染出承诺位（取 description 首句）、边界位（取 notes 首句），适用人群位不出现
- **AND** 不出现任何空槽位或"未填写"占位符

#### Scenario: 首句超长按整词截断

- **WHEN** 一份 description 的首句显示宽度超过承诺位上限
- **THEN** 渲染结果以整词边界截断并补省略号，最后一个字符不是半截词也不是句中标点

#### Scenario: 无 notes 的条目省略边界位

- **WHEN** 一个 pack 没有 `notes`
- **THEN** 卡片不渲染边界位那一行，且卡片高度不因此塌陷为不一致的版式

### Requirement: 兼容不变量：不写就逐字节不变

一份不含任何 v2 显示字段的 manifest，其市场列表投影、详情投影、安装面 manifest 与本次变更前 SHALL 逐字节相同，新增的派生只读字段除外。v2 字段 SHALL 只增不改既有字段的语义。

#### Scenario: 存量 manifest 的投影逐字节不回退

- **WHEN** 以同一请求参数分别读取变更前与变更后版本对同一存量 pack 的列表投影与详情投影
- **THEN** 除新增的派生只读字段外，两个响应逐字节相同

#### Scenario: 含 v2 字段的 manifest 过安装重校验

- **WHEN** 一份带 `identity`/`promise`/`outcomes`/`examples`/`domain` 的已发布版本到达安装端
- **THEN** 安装面以与发布面相同的规则通过校验，安装后的技能、角色、工具面与未带这些字段时完全一致

### Requirement: 市场投影与外部客户端的透传规则

市场投影 SHALL 原样携带 v2 显示字段，SHALL NOT 对其做二次改写。面向外部客户端的市场仓导出中，`marketplace.json` 与 `plugin.json` 的结构 SHALL 保持不变（其字段集由客户端加载器钉死），v2 字段 SHALL 写在该插件的 sidecar 文件里；插件 README 的首行 SHALL 优先使用 `promise`，缺失时回落 `description`。

#### Scenario: 外部市场仓清单结构不变

- **WHEN** 一个带 v2 字段的 pack 被导出到外部市场仓
- **THEN** `marketplace.json` 与 `plugin.json` 的字段集与结构与该变更前完全一致
- **AND** v2 字段出现在该插件目录的 sidecar 文件中，逐字节等于 manifest 中的值

#### Scenario: 客户端载荷不因 sidecar 受伤

- **WHEN** 一个不认识 sidecar 的外部客户端读取该市场仓
- **THEN** 它按既有字段完成解析与安装，不因新增文件报错

#### Scenario: README 首行优先承诺

- **WHEN** 一份带 `promise` 的 pack 被导出
- **THEN** 其插件 README 的首行是该条目的承诺文本；没有 `promise` 时首行为 `description`
