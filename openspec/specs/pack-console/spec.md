# pack-console Specification

## Purpose
团队的"自己的脸"：pack 声明这个团队要看哪几块，平台与谦面两个宿主读到同一份 view model、用同一份渲染实现呈现；声明只选块与参数，不携带取数方式，不声明则与今天字节一致。

## Requirements

### Requirement: manifest 可声明团队控制台

pack manifest SHALL 可选携带 `console` 对象，形状为 `{ headline?, blocks[] }`；`blocks[]` 每项 SHALL 为 `{ block, params?, surfaces? }`。`headline` SHALL 引用一个已声明块内的字段路径。`blocks[].block` SHALL 是块注册表中已注册的 id，未知 id SHALL 被拒绝并指名该字段路径与未知值。`blocks[].params` SHALL 只接受该块声明的参数集合，未知键 SHALL 被拒绝。`blocks[].surfaces` SHALL 取 `platform` / `share` 的子集，缺省 SHALL 等于两者都含。`blocks` SHALL 至多 8 项且 SHALL NOT 出现重复 `block`。声明校验 SHALL 由发布面与安装面共用的同一校验器执行，错误 SHALL 指名具体字段路径。

声明 SHALL NOT 携带取数方式：`console` 内任何层级出现 URL、端点、查询语句、凭据或脚本 SHALL 被拒绝。`console` 不得改变任何运行时契约——技能名、MCP `registryName`、工具面、组闸、计费键一个不动。缺省 `console` SHALL 使制品逐字节不变，且团队不呈现控制台入口。

#### Scenario: 合法声明通过校验

- **WHEN** 一份 manifest 声明 `console.headline = "kpi.deliverables"` 与六个已注册块，参数与 surfaces 皆在各自允许集合内
- **THEN** 校验通过，该声明按 locale 投影到市场读面，并可被安装

#### Scenario: 未知块或未知参数被拒

- **WHEN** 一份 manifest 声明 `blocks[2].block = "sales-funnel"`（未注册），或给 `team` 块传 `params.limit`
- **THEN** 校验拒绝，错误指名 `console.blocks[2].block` 或 `console.blocks[N].params.limit` 及允许集合

#### Scenario: 携带取数方式被拒

- **WHEN** 一份 manifest 的块参数里出现 `url`、`endpoint` 或 `query` 任一字段
- **THEN** 校验拒绝并指明该字段路径，声明不落库

#### Scenario: 未声明则零变更

- **WHEN** 一份不含 `console` 的 agent 与一份含 `console` 的同版 agent 分别安装到两台机器
- **THEN** 前者的市场条目、安装态与运行时行为与本次变更前逐字节一致，且不出现控制台入口

### Requirement: 单一 view model 服务两个宿主

系统 SHALL 提供 `GET /api/fleets/:id/console?surface=platform|share`，一次调用返回该团队的控制台 view model：`fleet` 摘要、按声明顺序排列的 `blocks[]`（每项含 `block` id、解析后的 `title` / `summary` 标注、`state` ∈ `ready` / `absent`、`data` 或 `absentReason`）、`headline` 解析值与 `sampledAt`。`surface` 缺省 SHALL 为 `platform`。

所有块的数值与状态 SHALL 复用既有读面派生（岗位状态、拍板排序与过期策略、日报流、支出与运行台账、编排读视图），SHALL NOT 另造排序、健康或过期语义。块内数据 SHALL 有硬界（成员、日报、拍板、运行各不超过既有端点同界），并 SHALL 带 `v` 版本字段。

`surface=share` SHALL 在服务端裁掉未声明 `share` 的块，响应体 SHALL NOT 含被裁块的数据或标题。非本团队主人且非 admin 请求 `surface=platform` SHALL 403；`surface=share` SHALL 允许匿名读取，且 SHALL NOT 返回任何写动作、成员邮箱、模型档位、凭据或工具面信息。

#### Scenario: 两个宿主取到同一份 view model

- **WHEN** 同一团队的控制台分别在平台页与谦面分享页打开
- **THEN** 两次取数返回相同的块集合与数值（`sampledAt` 可不同），两侧渲染的块标题、顺序与数值一致

#### Scenario: share 面在服务端被裁

- **WHEN** 一份声明只把 `team` / `stream` / `kpi` 标为 `share`，其余标为 `platform`，以 `surface=share` 取数
- **THEN** 响应只含三个块，且 spend 与 decisions 的标题与数据均不出现（服务端裁剪，非前端隐藏）

#### Scenario: 匿名读取不越权

- **WHEN** 匿名请求以 `surface=share` 读取分享控制台
- **THEN** 返回 200 与裁剪后的块，响应内无成员邮箱、模型、工具面、凭据字段

#### Scenario: 主人读全量

- **WHEN** 团队主人以 `surface=platform` 读取
- **THEN** 返回全部声明块；另一租户的用户请求同一路径以 `surface=platform` 读取 SHALL 403

### Requirement: 缺数据渲染诚实空态

块 SHALL 在数据缺失时返回 `state: "absent"` 与机器可读的 `absentReason`（例如无报数、无支出记录、编排未声明、上游读面不可用），并 SHALL NOT 编造行、占位数值或估算值。`absent` 的块 SHALL 仍携带标题标注，以便宿主渲染"暂无数据"的空态。`headline` 所引用的字段在对应块 `absent` 时 SHALL 解析为 `null`，SHALL NOT 回落为 0。

#### Scenario: 无报数的团队

- **WHEN** 一支新建、尚无任何报数的团队打开控制台
- **THEN** `stream` 与 `kpi` 块返回 `state: "absent"` 与原因，宿主渲染空态而非零值卡片

#### Scenario: 上游读面不可用

- **WHEN** 支出读面超时
- **THEN** `spend` 块返回 `state: "absent"` 与 `absentReason` 指明上游不可用，其余块照常返回

#### Scenario: headline 不回落为 0

- **WHEN** `headline` 引用的 `kpi.deliverables` 所在块为 `absent`
- **THEN** 响应的 `headline.value` 为 `null`，不是 0

### Requirement: 两个宿主共用一个渲染实现

块渲染 SHALL 由平台前端与谦面前端共享的单一实现提供（workspace 包），两个宿主 SHALL NOT 各自实现同一块的渲染。块标题与摘要的本地化 SHALL 沿用 pack 的 locale 轨道（zh / en / ja / es / fr），缺语 SHALL 回落 `en`，SHALL NOT 机器翻译或省略。未知块（声明来自更新版本的校验器）SHALL 渲染为"此块需要更新版本"的降级位，SHALL NOT 让整页失败。

#### Scenario: 新增一块只改一处

- **WHEN** 注册表新增一个块并在两份声明中引用
- **THEN** 两个宿主都渲染该块，且改动只落在注册表与共享渲染包，两个宿主的页面代码无需修改

#### Scenario: 缺语回落

- **WHEN** 块标注只提供 zh 与 en，访问者 locale 为 ja
- **THEN** 该块标题呈现 en 文本，不呈现空串或 zh 原文混排

#### Scenario: 未知块不炸整页

- **WHEN** 传递来的 view model 含一个当前渲染包不认识的块 id
- **THEN** 该位置呈现降级位，同页其余块正常渲染
