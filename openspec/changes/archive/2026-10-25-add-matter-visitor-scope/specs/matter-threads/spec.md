# matter-threads Delta Spec

## ADDED Requirements

### Requirement: 事项的访客可见边界

开事项时 SHALL 以调用方访客会话派生的不透明 scope key 绑定该事项（`scope_key`）。
接待工具面的 list/read SHALL 按调用方会话过滤：仅返回**本会话绑定**与**无界存量**
（scope 为空）的事项；异会访客的事项 SHALL NOT 经工具面可见，其存在性 SHALL NOT
泄露。主人队列（部署者/管理组）SHALL 全量可见不受 scope 影响。存量无 scope 事项
SHALL 保持对全部访客可见（兼容 v1）。无会话上下文的开串 SHALL 落为无界并留审计行。

#### Scenario: 异会访客不可见

- **WHEN** 访客 A 开了事项，访客 B（不同会话）让接待列事项
- **THEN** B 的事项清单不含 A 的事项，读取 A 的事项号返回同形不存在

#### Scenario: 同会访客可见

- **WHEN** 开串的同一会话内访客随后查询状态与时间线
- **THEN** 该事项可见且可读（含主人回应）

#### Scenario: 主人全见

- **WHEN** 部署者打开包详情的队列
- **THEN** 全部事项（含各 scope）按现状全量呈现
