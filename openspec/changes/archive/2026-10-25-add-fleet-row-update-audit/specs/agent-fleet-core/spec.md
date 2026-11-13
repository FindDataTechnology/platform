# agent-fleet-core Delta

## ADDED Requirements

### Requirement: 舰队行更新落双审计痕

fleets 表每次 UPDATE SHALL 在 fleet_row_audit 落一行审计记录（时间戳 / fleet_id /
本次变更的字段集 / orchestration 旧值→新值）——以库层 AFTER UPDATE 触发器实现，对任何
写入进程无差别生效，包括平台进程之外的直接 SQL 写入。平台进程内的舰队行更新 SHALL 附
归因（HTTP 请求身份，或进程内调用方首帧），归因随审计可查。orchestration 从非 null 变
为 null 的写，当归因缺失或不是该舰队 owner 的 HTTP 会话时，平台 SHALL 打 warn 日志。
/api/fleets 的非只读请求 SHALL 记访问日志（方法 / 路径 / 请求身份）。审计记录 SHALL NOT
包含凭据或密钥材料。

#### Scenario: 人为 PATCH orchestration 可查 caller 与新旧值

- WHEN owner 通过 PATCH /api/fleets/:id 修改 orchestration
- THEN fleet_row_audit 出现对应审计行（含时间戳、变更字段集、orchestration 旧值→新值、
  归因为该 owner 的 HTTP 会话）

#### Scenario: 进程外直接 SQL 写入仍被捕获

- WHEN 任意进程绕过平台 API 直接 UPDATE fleets 表（如 shell 直写库文件）
- THEN 触发器审计行照常落库（无应用层归因），据此可判读为进程外写入

#### Scenario: orchestration 复位为 null 打 warn

- WHEN 一次写使 orchestration 从非 null 变为 null,且归因缺失或不是该舰队 owner 的
  HTTP 会话
- THEN 平台日志出现 warn(含 fleet_id 与可得归因),审计行同时落库

#### Scenario: 非审计字段的常规更新不改变写语义

- WHEN owner 修改舰队名或状态等常规字段
- THEN 更新行为与审计前完全一致,仅追加审计行,无额外拒绝或延迟语义
