# Proposal: add-cockpit-density

## Why

真机走查暴露密度缺陷:某些岗位把整段散文报数写进 KPI 槽位(如「5 席已报(开源/投资/助理/电商/内容);CEO 侧复核:26 条连接全为公开数据源…」),画布节点卡被撑破版式;检查器里同样溢出。同时时间线一屏混排各岗位 run,运营者最常问的「这个岗位跑了什么」只能靠肉眼扫。

## What Changes

- 画布节点卡与检查器 KPI 槽位:自由文本值就地截断单行(画布 16 字/检查器 24 字),全文挂悬停 title;槽位容器不换行溢出。
- 执行时间线增「按岗位过滤」(客户端对已加载页过滤):选岗位只剩该岗 run,无匹配呈现诚实空态文案。

## Capabilities

### New Capabilities
(无)
### Modified Capabilities
- `agent-fleet-cockpit`: ADDED——自由文本槽位值单行截断且全文可悬停读取;执行时间线按根岗位过滤。

## Impact

- 前端:`FleetCanvas.tsx`(槽位芯片截断+容器溢出)、`InspectorDrawer.tsx`(同判)、`RunTimeline.tsx`(岗位过滤)、i18n 五语言三键。零后端改动。
- 非目标:不改槽位数据类型(自由文本是既有事实,不收紧);不做服务端岗位过滤(页内足够)。
