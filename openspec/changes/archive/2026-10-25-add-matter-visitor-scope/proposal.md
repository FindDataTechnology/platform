# add-matter-visitor-scope

> 2026-10-25 V2 披露边界第一刀（用户明令「现在就做 v2」）。事项串 v1 上产后暴露的
> 真实披露洞：事项是**部署级**对象，任何访客都能经接待的 matter_status/matter_read
> 读到**其他访客**的事项（摘要+访客线索）——跨访客披露无闸。

## Why

v1 的访客身份如实弱（会话线索+自述），因此把事项挂部署而非访客。但「弱身份」不能推出
「无边界」：两个访客同时与同一分身对话时，A 可以问出 B 留给主人的联系方式线索。披露
边界的 v2 第一刀就是把这个洞堵上——**开串时的会话即边界**：事项绑定到打开它的访客
会话（context id 派生的不透明 scope key），同会话读得到，异会话读不到，主人全见。

## What Changes

- **平台侧**：matters 表增 `scope_key`（可空；存量行=空=无界，兼容 v1）；internal
  open 携带 `visitor_scope`（runner 传）；internal list/read 按调用方的 scope 过滤
  （`scope IS NULL OR scope = ?`——无界存量行对所有人可见）；主人路由全量不变。
- **runner 侧**：manager 在回合期记录 childKey→activeSession（单写者纪律保证一 child
  同时至多一回合），matters 执行器把当前会话的 sha256 前 32 位作为 visitor_scope
  随 open 上送；非回合期（理论不可能，防御）开串落无界并审计。
- **child 侧零改动**：工具面形状不变（接待无需知道 scope 存在）。

## Non-Goals

- 访客强身份（跨会话同一访客的关联）——那是 IdP 级议题；同会话连续性已由车道
  context id 的稳定性承载。
- 存量 v1 事项的回溯绑定（无会话信息可绑；主人可关闭）。

## Impact

- 代码：gateway/packs.js（列+过滤）、agent-runner/manager.js（activeSession）、
  agent-runner/matters.js（scope 上送）、单测两面。
- 规格：matter-threads 增一条要求（事项访客可见边界）。
