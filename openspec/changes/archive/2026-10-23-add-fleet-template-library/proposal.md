# Proposal: add-fleet-template-library

## Why

舰队模板机制（agent-fleet-templates：清单预校验、市场分发、实例化降级、导出、驾驶舱）已于 2026-10-23 全链上产，但官方种子只有「公司式舰队」一份——用户想组队时没有第二个可装的组织形态可参考，模板作为舰队「用—养—传」生态的入口实际只有单点样例。机制已备，缺的是内容。

## What Changes

- 新增四份官方舰队模板种子（内容面，机制零改动），每份都是一份 pack 清单真源文件（`docs/fleet-templates/*.seed.json`，含可选 `fleet` 段与自带 agents）：
  - **投研晨会舰队**：首席分析师→宏观研究员+行业研究员（三层级联），风控官被动岗（escalate 驱动）；模拟盘/数据源/搜索取数，演示三层组织与拍板驱动唤醒。
  - **内容工厂舰队**：主编→选题策划→撰稿人，审校被动岗（受委托唤醒）；演示被动岗横向协作（delegation）与文档工具面。
  - **客服护航舰队**：客服组长→一线客服+质检员；高频节奏（每 4 小时巡检），演示 escalate 疑难工单双通道与 CRM 客服工具面。
  - **情报站舰队**：主编→科技情报员+市场情报员，另含 existing-cluster 引用岗；演示集群引用岗与每日晨报流。
- 每份种子各自铸造上架为 pack（市场 curation category=fleet，走公司式种子 aofNf6o2 同一配方），应用中心舰队类目可见可装。
- 守恒测试：官方种子库中每份清单 SHALL 通过 fleet 段预校验，CI 钉住（防止种子腐烂为非法清单）。
- **主题清单为代决**（用户仅说「组建一些」）：按平台既有能力面（模拟盘/文档/CRM/搜索/集群）与机制特性覆盖度（三层级联/被动岗两种唤醒/高频节奏/cluster 引用岗）选型，替换或增删主题不影响本 change 的机制边界。

## Capabilities

### New Capabilities

（无——不引入新能力面，全部复用既有机制）

### Modified Capabilities

- `agent-fleet-templates`: ADDED 一条需求——官方种子库守恒：随仓分发的官方舰队模板清单 SHALL 全部通过与上架同源的 fleet 段预校验并被测试钉住；官方种子上架为市场 pack 后其清单真源仍以仓内文件为准。

## Impact

- **代码**：`docs/fleet-templates/`（四份新种子文件）；`scripts/test-fleet-templates.mjs`（守恒测试从钉单份公司种子扩为钉全库）；无 server/gateway 改动。
- **市场/生产**：四个新 pack 上架（category=fleet）；应用中心舰队类目从 1 卡变 5 卡（纯内容增量，卡片四态复用既有逻辑）。
- **依赖**：每份种子自带 agents ≤3（公司种子铸造实证的 pack agents 上限），超出部分以引用岗/被动岗/cluster/a2a 表达；种子 persona 只依赖既有 cell 能力（模拟盘、web 搜索、文档工具、CRM 桥、集群），取不到数据时按公司种子同款纪律如实报「未取得」。
- **验收面**：每份模板至少走「装→实例化→确认启动」全链一份活体验收（其余至少装+实例化），台账 `docs/registry-maintenance.md` 补记。
