# Proposal: rename-fleet-user-vocabulary

## Why

舰队模块的用户词汇是按内部实现起的(报数/拍板/失联/待补/被动/换防/节奏/日报流),用户实测看不懂(2026-10-24 用户反馈,截图实证)。名字是第一道理解门槛,先于一切解释层。

## What Changes

- **改名(五语言 i18n,键不动只改显示词)**:在岗→正常;暂停→已暂停(与已归档一致);失联→超时未报(说原因不拟人);待补→空缺(状态视角对齐招聘心智);被动→待命(随叫随到);报数→汇报;拍板队列→审批队列(配既有批准/驳回按钮);日报流→最新汇报(名实相符);换防→换人;节奏→排班。en: OK/Paused/Overdue/Vacant/On call/Report/Approvals/Latest reports/Change assignee/Schedule。
- **悬浮释义**:五状态徽章+审批队列+最新汇报+待命标注挂 title 提示(fleets.hints.*,五语言),一句话说清判定依据。
- **课程措辞同步**:舰队编排课程 zh/en 正文同词表改写,canonical+CMS(documentId sceu32stxy3ntvo7cifc9w2h 重发布)+官网快照三处同步。
- 接口层(report_status/escalate/cadence 等键名与 API)零改动——只改人读词。

## Capabilities

### New Capabilities
(无)
### Modified Capabilities
- `agent-fleet-cockpit`: MODIFIED——驾驶舱用户词汇表(状态徽章与区块的用户可见名称取值集更新+悬浮释义)。

## Impact

- 代码:五语言 common.json、FleetsPage.tsx(title×8);课程三载体同步。出片随下一班(paas 镜像含 UI 改名)。
- 兼容:仅显示层;既有数据/接口/事件不变。
- 非目标:接棒/扇出等编排边词(第二期);API 与存储字段名;图表内部代号。
