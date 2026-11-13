# Tasks: unify-operate-states

## 1. 破坏性确认清零（12 处，逐文件）

- [x] 1.1 pages 四处：`ZhiyuRoomPage`(721 结束房间)、`CustomPresetsPage`(394 删除预设)、`TasksPage`(207 删除任务)、`DocumentsPage`(362 删除集合) → ConfirmDialog。验证：tsc + 各页操作流手测或 e2e。
- [x] 1.2 components 八处：`ControlStrip`(388 切工作区丢回合提示)、`CronToolCard`(81 删除任务)、`Sidebar`(414 切工作区)、`ChartBinding`(149 解绑)、`TeamsManagementView`(67 归档)、`InspectorDrawer`(502 移除岗位)、`SkillCard`(39 删除技能)、`McpServerCard`(65 删除 MCP) → ConfirmDialog。验证：tsc + lint。
- [x] 1.3 `design-lint` native-confirm 规则升全量阻断（基线清零后变更 `compareRatchet` 语义：baseline 中 native-confirm 条目删除，规则对全树判红）。验证：加一条「新增 confirm → 红」的单测与全量门绿。

## 2. 三态覆盖补齐（审计定罪的重点位）

- [x] 2.1 懒载抽屉 `fallback={null}` → 同形骨架：`FleetsPage` 三抽屉（MemberInspector/EdgeInspector/MemoryDrawer）。验证：tsc + 视觉一瞥。
- [x] 2.2 `AgentsPage` 目录区 blank-until-loaded → SkeletonList。验证：tsc。
- [x] 2.3 `BotsPage` 载入期撒谎空态 → loading 骨架区分。验证：tsc。
- [x] 2.4 `ZhiyuRoomPage` 消息区加载态、`PackDetailDialog` 内容骨架。验证：tsc。
- [x] 2.5 缓存命中面后台失败不清屏核验：`useListCache` 三消费页（apps/resources/knowledge）已有该语义，补一条单测钉行为。验证：node 单测。

## 3. 反馈通道统一（toast-v2 接线）

- [x] 3.1 抽样关键操作流接 `showToast`：删除/发布/解绑成功回执（CustomPresets 删除、Tasks 删除、MCP 删除、Skills 删除、绑定解绑）。验证：tsc + 手测一例。
- [x] 3.2 既有三页旧 Toast（实为全部 12 个消费方一并迁移）（BotsPage/ModelsPage/ResourcesPage 用 showToast 单槽版）迁移至 v2 API（同名换 import，行为兼容）。验证：tsc + 旧 Toast.tsx 保留（③ 末尾不删，另单退役）。

## 4. a11y 与键盘底线

- [x] 4.1 `SettingsDialog`（裁决变更：特化 trap 保留——它有 ui/dialog 没有的嵌套对话框让渡与 active-section 焦点两个行为，盲删即回归；统一的是 FOCUSABLE_SELECTOR 契约，两 trap 同源） 自建焦点陷阱删除 → 复用 `ui/dialog`（行为等价：Esc/Tab 环/还原）。验证：tsc + settings 开关焦点手测。
- [x] 4.2 图标按钮（全仓扫描仅 1 处真缺口：DocumentsPage doc-delete，已补 aria-label；有 title= 无 aria 的也算了缺口） aria-label 补齐：抽四页（Fleets/Agents/Apps/Tasks）无文字 icon 按钮点查补 label。验证：grep 无裸 `<button><Icon/></button>`（无 aria）。
- [x] 4.3 全局 `g` 前缀跳转：App.tsx 键盘层（g+c→/chat 等 nav slug 首字母），desktop 同码。验证：手测 + 单测映射函数。

## 5. 合闸

- [x] 5.1 门：`check:locales`（新增串五语齐）、`web:build`、`tsc --noEmit`、定向单测全绿、`design-lint` 全量阻断绿（confirm=0）。
- [x] 5.2 走查：本地实例抽 6 页过三态/确认/回执走查清单；截图留档 /tmp。
