## Why

2026-10-27 用户裁决：内部方法论对外开放并工具化——L3 垂直构造器（NL→蓝图→批准→铸造→真跑）要从只在内部 harness 里跑的手艺变成**客户面产品**。壹座既有的三条资产已经就位但没缝合：`agent-fleet-architect`（活舰队 NL 编排面）、`agent-fleet-templates`（模板分发+用—养—传上架环）、既有校验链（parseFleetTemplate + 发布门）。客户今天看不到蓝图编辑面、批准闸的操作面、铸造/上架/试跑的结果面。

需求承接单：`docs/fleet-blueprint-studio-requirements.md`（含验收视图与姊妹单交叉；本 change 是规格契约之家）。词表与定位承接 finddata 根 spec `pack-taxonomy-and-naming`（对外只说「集群」）、`vertical-blueprint-constructor`（蓝图格式契约）、`fleet-platform-positioning`。

## What Changes

- 新增 spec `fleet-blueprint-studio`：蓝图实体形态、工作室界面（编辑→校验→diff）、校验链复用纪律、主人批准闸、铸造与上架、试跑验收六组要求。
- 明确与 `agent-fleet-architect` 的边界：**studio 治「包」（蓝图→集群模板→上架），architect 治「舰」（活舰队现场编排）**——两处在 fleet 段共享同一校验函数与起草批准纪律，互不通融。
- 全流程沿现有「市场=唯一分发更新通道」纪律；铸造产物带追溯 `_casting`。
- **BREAKING（无）**：不引入第二套校验器、第二套调度器、第二写路径；运行时契约（模板/编导字段、packId）零改动。

## Capabilities

### New Capabilities

- `fleet-blueprint-studio`：垂直蓝图对象与工作室面（编辑/校验/批准/铸造/上架/试跑）的客户侧契约。

### Modified Capabilities

（无——不修改既有 spec；与 `agent-fleet-architect`/`agent-fleet-templates` 的接口以本 change 的设计边界注释说明，不改其 requirements）

## Impact

- UI：owner 面新增「蓝图构造间」入口（与 owner surface 的多个在途 change 分栏）。
- 服务端：蓝图实体存储与校验/铸造/上架路由（loopback+cell owner 身份、作用域仿 architect 同款裁决）。
- 市场：集群模板专辑条目新增的拍摄位不造成新管理员路径（profit/分成由 add-market-revenue-share 承）。
- 存留：词表以中文主轨（场景/骨词组），外文为副轨；i18n 层由 add-pack-locale-tracks 提供的形态接流入。
- 试点基线：`blueprints/cross-border-ecom-policy`（finddata/fleet-packs，含首跑验收与 `_casting` 追溯）作为对照样件。