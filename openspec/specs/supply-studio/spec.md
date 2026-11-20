# supply-studio Specification

## Purpose
The supply-domain Studio face: the single creation surface for agent and team documents, hosted on the facet side with a facet identity ticket covering the whole creator funnel (register → create → preview → publish, no 壹座 account required), carrying over the workspace's three-pane semantics, document lifecycle, validation, deep links, and canvas design mode verbatim, storing documents in a facet-side store behind the credential-free gate, publishing through the supply-domain publish gate, and closing the cast-to-run loop across the domain boundary into 壹座.

## Requirements

### Requirement: Studio 是供给域唯一创作面

供给域 Studio SHALL 渲染三栏：文档库（左）、画布（中）、检查器（右），SHALL 是 agent 文档与 team 文档在供给域的唯一创作面（无第二编辑宿主并行）；team 文档的蓝图专属段（边界/数据源/判据模型/验收）SHALL 作为画布一等区块与三桶段同栏同检查器。空态 SHALL 一次点击进入创建（kind 显式选定，agent 文档不呈现团队 ribbon）；窄屏 SHALL 降级可用。最近文档 SHALL 按更新时间列于文档库顶部并带状态徽章。

#### Scenario: team 文档在工作区编辑

- **WHEN** 创作者在 Studio 打开一份 team kind 文档
- **THEN** 边界/数据源/判据段与三桶段同在画布呈现，检查器与 agent 文档同构（ribbon/规格书/校验三段）

#### Scenario: 空态一次点击创建

- **WHEN** 无文档的创作者打开 Studio 并点击新建
- **THEN** 一次点击产生带显式 kind 的新文档并聚焦名称输入

### Requirement: 创作者身份一张票

创作者 SHALL 以谦面身份（Logto 轻账号）完成注册→创作→预览→发布全程；创作与发布路径 SHALL NOT 要求壹座账号或壹座会话。「运行」动作（部署团队）SHALL 在进入壹座运行域时如实标注需要壹座账号，并引导注册——MUST NOT 静默降级或伪造成功。

#### Scenario: 无壹座账号的创作者完成发布

- **WHEN** 仅持谦面身份的创作者走完创作→预览→发布
- **THEN** 文档经发布闸成为市场包，全程未要求壹座账号

#### Scenario: 部署动作的诚实边界

- **WHEN** 无壹座账号的创作者点击「部署团队」
- **THEN** 界面如实说明运行需要壹座账号并引导注册/登录，MUST NOT 呈现已部署的假状态

### Requirement: 文档存储宿主在谦面侧并执行凭据禁带闸

蓝图文档 SHALL 物理存储于谦面侧 Studio 文档库（含 owner 谦面身份、版本号、生命周期、铸造追溯）；任何写路径落笔前 SHALL 执行凭据扫描——携带端点/token/secret 的文档结构性不可存储，v1 方言形状不可存储。壹座侧原存储退役为只读归档，文档 id SHALL 跨迁移保持稳定。

#### Scenario: 携带凭据的文档被拒

- **WHEN** 创作或 AI 起草产生的文档内容携带端点/token/secret 并提交保存
- **THEN** 存储层结构性拒绝该写入并返回带状态码的错误，文档库中不存在该记录

#### Scenario: 文档 id 跨迁移稳定

- **WHEN** 壹座侧旧链接以 `?doc=<id>` 访问一份已迁移文档
- **THEN** 重定向落在供给域 Studio 同 id 文档上，内容逐字节一致

### Requirement: 自动保存与版本冲突处置

Studio SHALL 以 1.5s 防抖乐观锁自动保存（expectVersion PUT）；409 冲突 SHALL 呈现「加载最新 / 以我为准」横幅，后者 MUST 经过危险确认，且「以我为准」覆盖 MUST 成功落库。

#### Scenario: 冲突双选

- **WHEN** 两个会话同改一份文档且后保存者撞 409
- **THEN** 后保存者见双选横幅；选「以我为准」并危险确认后其内容覆盖落库

### Requirement: 生命周期 ribbon 如实镜像服务端状态机

生命周期 ribbon SHALL 为服务端真状态机的纯投影（draft/approved/cast 态、试跑仅铸后、批准人闸、编辑回 draft 带重封注记）；服务端显式拒绝（agent 文档 approve/cast/trial/signoff 409）SHALL 如实呈现而非藏按钮。

#### Scenario: 铸后编辑回草稿

- **WHEN** 已铸文档被编辑保存
- **THEN** 状态自动回落 draft 并升版本，ribbon 呈现重封注记

### Requirement: 校验错误可行动

校验错误 SHALL 携稳定语义 code、五语摘要表（未知 code 回落原文不猜）与点击定位（entry/data-anchor 双路径：创建时刻定位与保存后 code 定位）。

#### Scenario: 名称过长错误三同框

- **WHEN** 保存时名称超限
- **THEN** 五语摘要、原文、跳转定位三同框呈现

### Requirement: 深链契约

Studio SHALL 支持 `?new=agent`（一次点击新建）、`?doc=<id>`（打开指定文档）、`?fork=<id>`（fork 深链）；深链 SHALL 在谦面域下解析。宿主（谦面薄壳）SHALL 把其地址栏的深链参数原样转发给 Studio 的局部路由，且 Studio 内部导航产生的文档切换 SHALL 不改变宿主的顶层视图地址（`#/studio` 保持为唯一顶层 hash）。

#### Scenario: 深链直达文档

- **WHEN** 访问 `?doc=<id>`
- **THEN** 三栏工作区打开该文档并同源高亮

#### Scenario: 宿主转发深链

- **WHEN** 宿主的 hash 形如 `#/studio?doc=<id>`，其中未知参数被丢弃
- **THEN** Studio 以该 `doc` 参数挂载并打开对应文档，宿主顶层视图仍为创作面

### Requirement: 可写团队结构图设计模式

结构图 SHALL 显式开关设计模式：拖线=handoff 草稿、点声明边=起草删除、确认=纯函数合并 orchestration.edges 走普通自动保存与发布门链；非法合并 SHALL 幂等去重或拒绝且回滚锚定终态，声明数据 SHALL 零污染。

#### Scenario: 环拒绝回滚

- **WHEN** 创作者在结构图拖出成环 handoff 并确认
- **THEN** 合并被拒绝，画布回滚到确认前终态，声明数据无残留

### Requirement: 发布经供给域发布闸

发布 SHALL 走谦面既有发布闸（manifest 校验、注释层强制、身份落戳、版本不可变快照），与 pack 发布同闸同 UX 家族；发布产物进入统一供给目录（W1 契约）。AI 起草（判官桥）SHALL 逐字段采用——采用只写本次草稿产出的字段，未产字段逐字节不动。

#### Scenario: 发布产物入统一目录

- **WHEN** 创作者在 Studio 发布一份 team 文档
- **THEN** 产物经发布闸成为市场包并出现在统一供给目录投影中，注释层强制生效

#### Scenario: AI 起草逐字段采用

- **WHEN** 创作者对 AI 草稿逐字段勾选采用
- **THEN** 仅勾选字段写入文档，本次草稿未产的顶层字段保持逐字节不变

### Requirement: 铸到部署的跨域闭环与回链

铸成功的文档 SHALL 提供「部署团队」动作：经深链进入壹座承接（装机 reused 幂等 + from-template 出生 paused + 落团队页）；壹座团队详情 SHALL 在产物携带 `_casting.blueprintId` 时呈现「来源蓝图」芯片并回链供给域 Studio 文档。

#### Scenario: 铸→部署→团队页

- **WHEN** 持壹座会话的创作者完成铸造并点「部署团队」
- **THEN** 壹座新建 born-paused 团队且界面落在该团队运行面

#### Scenario: 团队回链来源文档

- **WHEN** 打开一支由蓝图铸造而来的团队详情
- **THEN** 来源芯片可见，点击直达供给域 Studio 对应文档

### Requirement: 发布前有一张可行动的体检单

Studio 与草稿面 SHALL 在发布动作旁呈现一张体检单，把发布闸已有的判据（注释层与词表、工具面声明闭包、语言覆盖、清单结构）汇总为逐行条目；每行 SHALL 写明是哪一项、缺什么、以及去哪里修（跳转到对应字段或条目），MUST NOT 只给一句汇总。体检单 SHALL 常驻显示待修条目数，并在全部通过时明说「可发布」。体检单 MUST NOT 改变任何判据的通过条件——它是同一条闸的呈现，不是第二道闸。

#### Scenario: 有待修项时逐条可定位

- **WHEN** 一份草稿的某个 MCP 引用未声明工具白名单、且英文摘要缺失
- **THEN** 体检单出现两行，分别指向该引用与该摘要字段，顶部显示待修 2 条

#### Scenario: 全部通过时明说可发布

- **WHEN** 草稿通过全部判据
- **THEN** 体检单显示「全部通过，可发布」，发布按钮可用

#### Scenario: 体检单与服务端拒绝同源

- **WHEN** 发布仍被服务端拒绝
- **THEN** 拒绝信息以同样可定位的条目呈现，且条目内容与体检单来自同一处判据

#### Scenario: 判据不被呈现层放宽

- **WHEN** 体检单显示全部通过但服务端因新增判据拒绝
- **THEN** 拒绝照常生效，体检单列出该新判据而不是静默通过

### Requirement: 一试在工作域完成，供给域不伪造执行

供给域 SHALL 提供「装进工作台试用」动作：把当前草稿或已发布版本带到运行域（壹座）完成安装并开启一次对话。供给域 MUST NOT 自行执行包内技能或工具，MUST NOT 把试用渲染成「运行成功」「已验证」或任何质量结论。试用发生与否 SHALL 以「已试用 vN」的形式呈现，且该状态 MUST NOT 影响发布闸的任何判据。

#### Scenario: 带包进入运行域

- **WHEN** 创作者在 Studio 对一份草稿点「装进工作台试用」
- **THEN** 打开运行域并携带该包引用，运行域按既有安装与对话路径承接

#### Scenario: 没有运行域会话时诚实降级

- **WHEN** 当前部署没有可用的运行域会话（例如自部署谦面）
- **THEN** 动作降级为说明「去哪里可以试」，不打开空会话、不伪造运行结果

#### Scenario: 试用状态不是质量结论

- **WHEN** 某包已被试用
- **THEN** 界面只显示「已试用 vN」，不出现「已验证」「已通过」等质量表述，发布闸判据不变

#### Scenario: 未试用也可发布

- **WHEN** 创作者从未试用却满足全部发布判据
- **THEN** 发布成功

### Requirement: 草稿与线上版本的关系一眼可见

草稿面 SHALL 显示当前编辑内容与最近一次发布的版本关系：有未发布改动，或已与线上一致（含版本号）。判定 SHALL 由草稿清单与已发布版本的清单对比得出，MUST NOT 依赖手工维护的脏标记。

#### Scenario: 改完未发

- **WHEN** 创作者在上次发布 v3 之后改了 persona 文本
- **THEN** 草稿面显示「v3 后有不发布的改动」

#### Scenario: 已与线上一致

- **WHEN** 草稿内容与最近发布的 v3 完全一致
- **THEN** 草稿面显示「与线上 v3 一致」，不提示发布

### Requirement: 嵌入宿主的导航必须真实可达

Studio 被谦面薄壳嵌入时，视图内的每一个导航控件 SHALL 要么在宿主提供的局部路由表内解析，要么以真实外链指向壹座对应页面；SHALL NOT 呈现指向宿主不存在路由的控件——静默无操作的按钮视为缺陷。宿主 SHALL 为返回类动作提供域内落点，为运行域动作（集群/团队承接）提供带 SSO 的外链。

#### Scenario: 返回动作落到域内

- **WHEN** 创作者在嵌入态下点击 Studio 的返回控件
- **THEN** 视口回到宿主的智能体市场视图，且不产生无匹配路由的空渲染

#### Scenario: 跨域动作是真外链

- **WHEN** 创作者在嵌入态下触发集群或团队承接类动作
- **THEN** 浏览器以新目标打开壹座对应页面，URL 可复制、可分享

#### Scenario: 不存在静默无操作

- **WHEN** 嵌入态下任意导航控件被激活
- **THEN** 要么宿主视图发生变化，要么浏览器发生了导航；两者皆无时的控件不得渲染

