# Proposal: add-cockpit-orchestration-view

## Why

驾驶舱是舰队的唯一可视面,而 orchestration 段已在 cockpit API 回传(边集/模式/约束/隐式标记)却无 UI 渲染——用户声明了「主管式 + 流水线 + 扇出裁决」,驾驶舱上看不见自己的编排,只能信。台账 §15.20 余项③。

## What Changes

- **驾驶舱编排面板**:舰队详情页(树上方)新增 orchestration 区——模式徽章(schedule/supervisor/pipeline,含隐式全对派发提示)、约束行(maxChainDepth/budgetPerEdgeMin)、**边列表**(每条边一行:类型徽章 trigger/report/dispatch/handoff/fanout/event + 岗位名 from→to/targets + fanout 聚合式与 judge + event 的信号源;岗位 ref 渲染为岗位名);未声明段不渲染(零视觉噪音)。
- **只读**:本面板纯呈现,管理动作仍走架构师对话/既有卡片菜单——不新增写路径。

## Capabilities

### New Capabilities

(无)

### Modified Capabilities

- `agent-fleet-cockpit`: ADDED——驾驶舱呈现舰队编排声明(模式徽章/约束/边列表含类型语义与岗位名解析;未声明不渲染;只读)。

## Impact

- **代码**:`web/src/pages/FleetsPage.tsx`(类型+面板)、五语言 i18n;server 零改动(API 既有)。
- **测试**:typecheck 绿;既有套件回归零新增红(纯前端)。
- **出片**:web/ 有改动随下一列车;兼容性:无 orchestration 的舰队视图逐字节不变。
- **非目标**:不做边的可视化图编辑、不做 fanout 波实时状态(事件流已有)、不做移动端适配差异。
