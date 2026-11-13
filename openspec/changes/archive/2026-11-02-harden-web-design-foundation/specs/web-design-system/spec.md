# web-design-system Delta Spec

## Purpose

壹座 web 工作台（浏览器与桌面同一代码）的设计地基能力：定义全站消费的色彩三层纪律（灯/状态/序列）token、可继承的 UI 原语套件、以及看护两者的 design-lint 棘轮门。批②③及未来任何页面 change 的表现层行为以本能力为契约。

## ADDED Requirements

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

Tabs 原语 SHALL 以 `role=tablist`/`role=tab`/`aria-selected` 呈现，方向键在 tab 间移动焦点、Home/End 跳首尾，激活态 SHALL 以 `aria-selected=true` 标注；既有三套手搓 tabs 的迁移由批②③承接，本能力只锁定原语行为。

#### Scenario: 方向键换页

- WHEN 焦点位于任一 tab 且按下 ArrowRight
- THEN 焦点移至相邻 tab 且其内容可见，`aria-selected` 随焦点更新

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
