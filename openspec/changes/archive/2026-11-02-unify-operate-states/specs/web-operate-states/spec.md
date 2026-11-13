# web-operate-states Delta Spec

## Purpose

壹座 web 工作台（浏览器与桌面同一代码）的跨页操作状态与反馈契约：任何取数面的三态覆盖、破坏性操作的主题化确认、异步成败的统一反馈通道、键盘与 aria 底线，以及 design-lint 棘轮门的终态全量阻断。批①②已供给原语与门；本能力约束全部页面接线到位后的系统行为。

## ADDED Requirements

### Requirement: 取数面三态覆盖

任何依赖网络取数的页面与懒载抽屉 SHALL 渲染三态：加载期同形骨架（MUST NOT 呈现空白或 `fallback={null}` 式隐形）、空态必给说明与下一步（动作或指引，裸「无数据」文本为违规）、错误态命名问题并给重试动作。三态由 StatesKit 原语承载；既有缓存命中面（listCache 种子渲染）在后台再验证失败时 MUST 保留既有内容并仅呈现错误消息，不得清屏。

#### Scenario: 懒载抽屉不再隐形

- WHEN 任一懒载抽屉（Suspense 包裹）处于加载期
- THEN 抽屉容器呈现同形骨架占位，用户可见「正在装载」

#### Scenario: 缓存命中面后台失败不清屏

- WHEN 已有缓存数据的列表在后台 revalidate 失败
- THEN 既有内容保留，错误以消息呈现；页面不回退到空白

### Requirement: 破坏性操作主题化确认

一切删除/解散/归档/解绑/移除类操作 SHALL 经 ConfirmDialog（危险操作用 danger 变体，焦点落取消侧，Esc 等同取消）；浏览器原生 `confirm()` 与 `window.confirm` MUST 全量清零，`scripts/design-lint.mjs` 的 native-confirm 规则 SHALL 升级为对 `pages/**` 与 `components/**` 的全量阻断（基线清零，新债无处生）。

#### Scenario: 全量阻断生效

- WHEN 任一页面/组件新增裸 confirm 调用并跑单测链
- THEN design-lint 判红，指出文件与规则

#### Scenario: 确认对话框语义统一

- WHEN 用户触发任一破坏性操作
- THEN 弹出 ConfirmDialog，取消按钮获得初始焦点；确认文案说明后果（沿用既有 i18n confirm 串）

### Requirement: 异步成败反馈双通道

异步操作的成败反馈 SHALL 走双通道制：操作型结果（保存/删除/发布/解绑等）经 Toast v2（severity 对应成败，error 可手动关闭），页内表单校验与上下文错误走 inline 呈现；两类 MUST NOT 混用于同一反馈点。静默成功（操作成功且无任何回执）为违规。成功提示文案 SHALL 复用既有 i18n 串或随本批新增（五语言齐）。

#### Scenario: 静默成功清零

- WHEN 用户完成一次删除/保存类操作
- THEN 出现 toast 回执（或页内可见的状态翻转）；无任何反馈视为违规

### Requirement: 键盘与 aria 底线

全部页面 SHALL 具备：交互控件可聚焦且焦点环可见（focus-visible ring）、图标类无文字按钮携带 aria-label（i18n 来源）、对话框/抽屉关闭后焦点还原（由 ui/dialog 契约统一供给）。全局键盘加速器 SHALL 提供最小集：跨面跳转（g 前缀导航）与设置直达（既有 Ctrl+, 保留）。SettingsDialog 自建的重复焦点陷阱 SHALL 删除并复用 ui/dialog 的实现。

#### Scenario: 图标按钮可名

- WHEN 屏读器遍历任一页面的图标按钮
- THEN 每个图标按钮可读出其动作名（aria-label 来自 locale）

#### Scenario: 跨面跳转加速器

- WHEN 用户在任意面按下 g 随后面 slug 首字母（如 g c → chat）
- THEN 焦点跳转至对应面导航项并激活，无需鼠标
