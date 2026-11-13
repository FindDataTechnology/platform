## Purpose

实例回报单向登记契约（供给域闭环三接口之一，章程 D4「单向 + 出处 + 诚实降级」）：萬星实例的运行状态 SHALL 经脊柱写闸登记进脊柱登记处并带 provenance，使「脊柱登记处能读到实例状态且可反查出处」；脊柱侧 MUST NOT 存在任何回写实例运行态的路径（登记不驱动）。登记通道失败 SHALL 诚实降级（部署面无感），MUST NOT 阻塞实例部署。

## ADDED Requirements

### Requirement: 实例状态经写闸单向登记进脊柱

壹座 SHALL 在实例部署状态变更（部署/启停/移除）后，把实例状态经脊柱写闸 upsert 进 `instances` 登记处：字段 SHALL 含 instance_id、状态、runner、来源 pack（id+版本）与 provenance（reported_at / source=壹座 cell / seat）。登记 SHALL 为单向 fire-and-forget：脊柱侧 MUST NOT 存在任何把登记内容下发回实例运行态的代码路径。

#### Scenario: 部署变更后登记处可读带出处

- **WHEN** 一支萬星实例完成部署且脊柱写闸可达
- **THEN** 脊柱 instances 登记处出现该实例条目，读面可反查 provenance（reported_at/source/seat）

#### Scenario: 脊柱无回写运行态路径

- **WHEN** 对登记处代码与路由做全量检查
- **THEN** 不存在任何由脊柱登记内容驱动实例运行态（启停/配置变更/下发）的路径

### Requirement: 登记通道失败诚实降级不阻塞部署

脊柱写闸不可达或拒绝时，回报器 SHALL 记日志与计数并放行部署主流程；登记条目 SHALL 带 TTL 自然过期（部署状态变更即续期），MUST NOT 因登记失败重试风暴，MUST NOT 让部署面返回错误。

#### Scenario: 脊柱不可达时部署无感

- **WHEN** 脊柱写闸不可达而用户执行实例部署
- **THEN** 部署成功返回与平时无差，日志出现登记失败记录，无重试风暴

#### Scenario: 登记条目 TTL 过期自然消失

- **WHEN** 一条登记超过 TTL 且无后续部署事件续期
- **THEN** 读面该条目标记过期（as_of 可见），无需删除风暴
