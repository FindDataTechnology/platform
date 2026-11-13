## ADDED Requirements

### Requirement: 本体草案提交目标是域提案箱

本体舰队的提案岗 SHALL 通过唯一的出口函数把每条草案提交到
`POST {BENCH_URL}/api/d/{domain_key}/proposals`。提交目标 SHALL 由配置 `BENCH_URL` 与
`BENCH_PROPOSAL_DOMAIN` 决定，SHALL NOT 从草案内容推断域，SHALL NOT 使用任何硬编码的缺省域。
提案岗 SHALL NOT 同时向柏讯动作审批队列提交本体类草案（无双写）。

#### Scenario: 一轮产出草案落到本域提案箱

- **WHEN** 提案岗在 `BENCH_PROPOSAL_DOMAIN=legal` 的配置下产出一条实体草案并提交，对端接受
- **THEN** 本轮报告记该条为「新增」，且知验台 `legal` 域提案箱出现一条 `state=pending` 的草案
- **THEN** 同轮柏讯动作审批队列不新增任何本体类提案

#### Scenario: 域 key 缺失时本轮失败而不是落到某个缺省域

- **WHEN** `BENCH_PROPOSAL_DOMAIN` 未配置
- **THEN** 提案岗本轮失败，错误信息报明缺失的环境变量名
- **THEN** 不产生任何提交请求，草案留在本轮产物中

### Requirement: 提交体携带可核对的依据与稳定身份

每条提交 SHALL 携带 `source`、`kind`、`external_key`、`evidence`、`submitted_by`。
`source` SHALL 为跨轮稳定的岗位身份（`fleet:<fleet_id>/<post_id>`）。`evidence` SHALL 非空且可核对 ——
它是域负责人确认时唯一的判断材料。提交体 SHALL NOT 携带客户工作区/账号目标，也不携带动作执行相关字段。

#### Scenario: 缺依据被对端拒绝且如实上报

- **WHEN** 提案岗提交的草案 `evidence` 为空，对端返回 400
- **THEN** 本轮报告记该条为失败并保留对端错误语义
- **THEN** 不重试为「已提交」，也不静默丢弃该条

#### Scenario: 出表 kind 被拒绝且库无变化

- **WHEN** 草案的 `kind` 不在该域模板词表内，对端返回 400
- **THEN** 本轮报告记失败并指明是词汇表拒绝
- **THEN** 知验台 `knowledge_units` 与提案箱均无新增

### Requirement: 幂等与重试纪律

同 `(domain, source, external_key)` 且对端已有 `pending` 行时，提交 SHALL 记为「幂等命中」，
SHALL NOT 新增行、SHALL NOT 计为失败。对被驳回的键提交同一依据 SHALL 视为失败并**停止自动重试**；
换新依据是人的判断，不是轮次的机械行为。

#### Scenario: 同键重复提交只留一条

- **WHEN** 提案岗连续三轮提交同一 `source` + `external_key` + 同一依据
- **THEN** 知验台提案箱该键只有一条 `pending` 行
- **THEN** 后两轮报告记「幂等命中」

#### Scenario: 被驳回后同依据重提不再自动重试

- **WHEN** 某键已被域负责人驳回，提案岗提交同一依据，对端返回 400（同键已驳回，需新证据）
- **THEN** 本轮报告记失败并标注「需新证据」
- **THEN** 后续轮次不再对该键自动提交，直到草案依据发生变化

### Requirement: 对端错误如实透传，凭据只经环境

提案岗 SHALL 把对端的 400/401/403/404/5xx 与网络超时按语义记入本轮报告，SHALL NOT 把失败记为成功。
凭据（`BENCH_CONSUMER_TOKEN`）SHALL 只经环境变量读取，SHALL NOT 落仓、SHALL NOT 出现在日志或报告中
（对端回显时按脱敏规则遮盖）。缺凭据时提案岗 SHALL 启动不崩、本轮明确失败并报明 env 名。

#### Scenario: 跨域提交被拒

- **WHEN** 提案岗用只对 `legal` 有权的凭据提交到 `banking` 域，对端返回 403
- **THEN** 本轮报告记失败并保留「无该域权限」的对端语义
- **THEN** 不产生任何本地「已提交」记录

#### Scenario: 对端不可达

- **WHEN** 提交时对端超时或 5xx
- **THEN** 本轮报告记失败，草案仍留在本轮产物里供下一轮重提
- **THEN** 报告中不出现 token 明文

### Requirement: 柏讯审批队列对本体类提案零新增

柏讯（fd-wire）动作审批队列 SHALL 只为客户侧域动作服务；本体类提案 SHALL NOT 再写入该队列。
该关停的判据 SHALL 是一轮真跑后的两侧计数对照，而不是「代码里删掉了调用」这一静态事实。
队列既有历史行 SHALL 保持不变（审计记录不迁移、不删除）。

#### Scenario: 一轮真跑的两侧对照

- **WHEN** 提案岗在切换后完整跑一轮，产出 N 条草案
- **THEN** 知验台对应域提案箱新增 N 条（或按幂等命中少于 N 条），且每条可在控制台看到
- **THEN** 柏讯动作审批队列的本体类提案计数增量为 0
