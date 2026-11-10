# web-design-system Specification

## Purpose
壹座 web 工作台（浏览器与桌面同一代码）的设计地基能力：定义全站消费的色彩三层纪律（灯/状态/序列）token、可继承的 UI 原语套件、以及看护两者的 design-lint 棘轮门。批②③及未来任何页面 change 的表现层行为以本能力为契约。

## Requirements

### Requirement: 色彩三层纪律 token 供给

主题层 SHALL 向全站暴露三层色彩语义名：灯（`primary`，唯一含义=正在干活/焦点/用户发言/每视图唯一主操作）、状态（`--status-running` / `--status-paused` / `--status-failed` / `--status-waiting` 四个钉扎别名，分别钉扎既有 success/muted-foreground/destructive/warning 色值）、序列（`--series-1..4`，从灯色同 hue 派生的等差色阶，唯一合法多系列计量色源）。新增或改值的色 SHALL 只经主题层单点声明；页面与组件 MUST 消费语义名，不得直接消费色值字面量。

#### Scenario: 状态钉扎唯一

- WHEN 任一页面渲染 running/paused/failed/waiting 之一的状态指示
- THEN 其颜色取自四个状态语义名之一，且与 DESIGN.md 词表逐一对应

#### Scenario: 序列色阶只在多系列处启用

- WHEN 一张计量图表面同时显示两个及以上系列的条/线
- THEN 各系列颜色取自 `--series-1..4`；单系列计量 MUST 用灯色

### Requirement: 颜色永不单独表意

任何以颜色传达状态的界面元素 SHALL 同时提供文字或图标承载同一信息；仅靠色相区分状态的位置 MUST 存在非色彩冗余，否则视为违规。

#### Scenario: 胶囊双承载

- WHEN 状态胶囊以色区分 running 与 waiting
- THEN 胶囊同时携带可读文案（i18n 来源），屏读器与色觉障碍用户可获取同一区分

### Requirement: 原语套件供给与零硬编码文案

地基 SHALL 在共享组件目录提供并导出下列原语：Card、StatusPill、Tabs、Select、Tooltip、Toast v2、ConfirmDialog、PageShell、StatesKit（Skeleton / EmptyState / ErrorState）。全部原语 MUST 经 props 接受一切用户可见文案，MUST NOT 内嵌任何语言字面量；原语的暗亮两态 SHALL 随既有主题联动，桌面与浏览器渲染同一实现。

#### Scenario: 无串供给

- WHEN 任一原语在无文案 props 的构建产物中被检索
- THEN 不存在任何语言的硬编码用户可见串（i18n 门与源码扫描均不得因原语报新串）

### Requirement: Tabs 键盘与角色契约

Tabs 原语 SHALL 以 `role=tablist`/`role=tab`/`aria-selected` 呈现，方向键在 tab 间移动焦点、Home/End 跳首尾，激活态 SHALL 以 `aria-selected=true` 标注。

产品内**每一处页签条** SHALL 由该原语渲染，MUST NOT 再有手搓的 `role="tablist"` + 类名活动态实现：分散实现丢掉的不是外观一致性，而是键盘可达性（方向键不换页、Home/End 不跳首尾、无 roving tabindex），对只有键盘的用户等同于禁用。活动态的判据 SHALL 是 `aria-selected`，MUST NOT 由某个颜色类（如 `border-primary`）承担——类名是外观细节，语义属性才是契约。

既有 testid 契约（如 `*-tab-<slug>`）SHALL 通过原语的 `itemProps` 注入保留，MUST NOT 因为收编而改名或消失。

#### Scenario: 方向键换页

- WHEN 焦点位于任一 tab 且按下 ArrowRight
- THEN 焦点移至相邻 tab 且其内容可见，`aria-selected` 随焦点更新

#### Scenario: Home 与 End 跳首尾

- WHEN 焦点位于中间某个 tab 且按下 Home（或 End）
- THEN 焦点落到首个（或末个）可用 tab，内容随之切换

#### Scenario: 每一处页签条都走原语

- WHEN 在 `web/src` 里检索 `role="tablist"`
- THEN 除 `components/ui/tabs.tsx` 自身外没有第二处手写实现

#### Scenario: 活动态由语义属性承担

- WHEN 任一页签条的选中项被检查
- THEN 它带 `aria-selected="true"`，且其样式不依赖 `border-b-2`（2px 彩色边）表达选中

#### Scenario: 收编不改公开锚点

- WHEN 某页面签条从手搓迁到原语
- THEN 其既有 `data-testid`（如 `extensions-tab-market`、`board-tab-<name>`）逐字保留，引用它的 e2e 无需改选择器即可定位

### Requirement: Toast v2 队列与严重度

Toast v2 SHALL 支持多槽堆叠（同屏上限 3，超出折叠入队）、`success/error/info` 三严重度、error 必可手动关闭且驻留时长不短于 success 与 info，并 SHALL 支持可选动作槽（如重试）。全局容器 SHALL 在应用根部单点挂载；页面接线属批③范围。

#### Scenario: 错误驻留可关

- WHEN 一条 error toast 与一条 success toast 先后弹出
- THEN 两者同屏堆叠、error 携关闭钮、error 自动消失时间不短于 success

### Requirement: ConfirmDialog 危险变体与焦点落位

ConfirmDialog SHALL 复用既有对话框的焦点陷阱/关闭还原契约；`danger` 变体的主确认钮 MUST 走 destructive 语义色，且打开时初始焦点 MUST 落在取消侧；键盘 Esc SHALL 等同取消。

#### Scenario: 焦点默认安全侧

- WHEN 任一 ConfirmDialog（含 danger 变体）被打开
- THEN 焦点位于取消按钮，回车默认路径不触发破坏性动作

### Requirement: StatesKit 三态语义

StatesKit SHALL 提供 Skeleton、EmptyState、ErrorState 三件：Skeleton 的占位块 MUST 可与消费组件同形配置（治加载隐形）；EmptyState MUST 承载「下一步」动作槽（可为空但默认给引导文案）；ErrorState MUST 携带错误说明与重试动作槽。三件均按零硬编码文案律接收 props。

#### Scenario: 加载不再隐形

- WHEN 懒载抽屉或取数列表处于 pending
- THEN 渲染同形 Skeleton 而非空白或 null

#### Scenario: 空态给出路

- WHEN 列表数据为空
- THEN EmptyState 呈现原因说明与可执行下一步（动作或指引），而非裸「无数据」文本

### Requirement: design-lint 棘轮门

仓库 SHALL 提供 design-lint 检查并入既有单测链：对 `web/src/pages/**` 与 `web/src/components/**`（共享原语目录豁免）扫描六类规则——`#hex` 色字面量、`rgba(` 直写、Tailwind 任意值色类、Tailwind 具名色阶（`bg-emerald-500` 之类：族名+数字档，主题 token 不带数字档故无歧义）、卡片/列表条目上的 `border-l-[2-9]`、`window.confirm(` 与裸 `confirm(` 调用。现存违规 SHALL 以「文件+规则→计数」的基线清单入账；变更集内文件出现基线之外的新违规 MUST 判红，基线内计数只允许随迁移下降（棘轮）。`- [var(` 类引用主题的任意值 MUST NOT 被误报。

#### Scenario: 新债即红

- WHEN 一个未入基线的页面新增一处 `#hex` 色字面量并跑检查
- THEN 检查失败并指名文件与规则

#### Scenario: 存量不误伤

- WHEN 改动某已入基线文件但与违规处无关
- THEN 检查通过（计数未升）

#### Scenario: 主题引用豁免

- WHEN 页面使用 `bg-[var(--status-running)]`
- THEN 检查不报任意值色违规

### Requirement: Micro-labels are script-aware

外壳存在一类极小的「标签」文字：导航家族头（知识/构建/运行/接入）、设置分组头（常规/能力/管理）、项目切换器的当前项目标签、构建家族快捷行。此类角色 SHALL 收敛为单一语义微标签类 `micro-label`，MUST NOT 由各组件各自写字号/字距字面量。该类 SHALL 随文档语言分档，语言由 i18n 层已维护的 `<html lang>` 驱动：拉丁语种保持小体大写习语（≈11px、`uppercase`、轻微正字距）；`zh-CN` 与 `ja` SHALL 取更大字号（≈12px），MUST NOT 施加 `text-transform: uppercase`（对汉字无操作，只在他处增加噪声），MUST NOT 施加正字距。规则 SHALL 按角色生效而非按组件生效：同角色的未来标签自动继承，组件 MUST NOT 为这些角色重新引入字号字面量。中日文标签内混入拉丁缩写时，MUST NOT 以斜杠拼接成单一主标签（如 `工具 / MCP`），缩写 SHALL 退居次级位置（副标题/提示），或该标签只陈述单一语种的名称。本需求 MUST NOT 改变任何拉丁语种的渲染（英文 UI 为基准，不得位移）。

design-lint 棘轮 SHALL 承接该规则：在既有六类规则之外，对 `web/src/pages/**` 与 `web/src/components/**`（共享原语目录豁免）扫描微标签角色上的字号/字距/大小写字面量（`text-[10px]`、`text-[11px]`、`uppercase`、`tracking-wide` 直接写在标签元素上）。现存违规 SHALL 以「文件+规则→计数」的基线清单入账；变更集内文件出现基线之外的新违规 MUST 判红，基线内计数只允许随迁移下降（棘轮）。

#### Scenario: 中文家族头不加大小写与字距

- **WHEN** 文档语言为 `zh-CN`，侧栏渲染「知识/构建/运行/接入」家族头
- **THEN** 该标签以不超过 12px 的字号呈现，且计算样式无 `uppercase` 变换、无正字距

#### Scenario: 英文家族头维持小体大写习语

- **WHEN** 文档语言为 `en`，侧栏渲染同一家族头
- **THEN** 该标签维持约 11px、大写变换与轻微正字距，渲染结果与本需求落地前的英文 UI 逐项一致

#### Scenario: 运行时切语种即时重渲染

- **WHEN** 用户在应用内把语言从 `en` 切到 `zh-CN`（不刷新页面，`<html lang>` 随之更新）
- **THEN** 已挂载的微标签无需重载即按中文字档重渲染，字号变大且不再大写、不再加字距

#### Scenario: 硬编码字号即红

- **WHEN** 一个组件为微标签角色直接写 `text-[10px]` 或 `uppercase tracking-wide` 并跑 design-lint
- **THEN** 检查失败并指名文件与规则（未被基线覆盖的新违规判红）

#### Scenario: 混排标签不斜杠拼接

- **WHEN** 一枚标签同时承载中文词与拉丁缩写（如「工具」与「MCP」）
- **THEN** 该缩写不出现在以斜杠连接的主标签文本中，而是呈现于副标题或提示等次级位置，或主标签只显示单语种名称
