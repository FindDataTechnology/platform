# agent-fleet-report-lane Delta: 岗位身份行补回合段

## MODIFIED Requirements

### Requirement: 舰队成员回合注入岗位身份

舰队成员在**其岗位回合**内 SHALL 能读到自己的岗位身份，至少包含所属舰队标识、岗位标识、岗位名、在岗目标引用**与回合标识**。身份 SHALL 以一行系统文本前缀在该回合的 prompt 首部，格式稳定到可被模型直接复述为外部系统的生产来源三元组（部署/岗位/回合），key 名与在产实现逐字一致：`fleet=<id>; post=<memberId>; title=<title>; target=<targetKind>:<targetId>; turn=<回合标识>`。

回合标识 SHALL 为该回合实际落地的子会话/回合标识（定时/委托轮次为逐轮轮换的轮次 id；手动派发回合为其会话 id），并 SHALL 与其余字段同批在**两条成员唤醒路径**（有节奏岗的定时回合与被动岗的受委托回合）上都注入。身份 SHALL 不含任何凭据，SHALL NOT 写入对外可见的 AgentCard 或公开目录。

非成员回合 SHALL 不注入：persona 未在岗任何岗位、或一个 persona 同时占据多个岗位（归属歧义）时，回合 prompt SHALL 与现状逐字一致。归属判定 SHALL 复用报数面既有的归属解析，不引入第二套判定。

#### Scenario: 有节奏岗回合带身份

- **WHEN** 一个绑定 persona 的有节奏岗位到点触发回合
- **THEN** 该回合的 prompt 首部含一行岗位身份，五个字段（fleetId / memberId / 目标引用 / 岗位名 / 回合标识）与实际岗位及该轮落地标识一致
- **AND** 该回合的会话史首条用户消息含同一行

#### Scenario: 被动岗受委托回合带身份

- **WHEN** 一个无节奏的被动岗被另一个 agent 通过 delegation 唤醒
- **THEN** 该回合的 prompt 首部同样含岗位身份行（含回合标识）

#### Scenario: 回合标识逐轮轮换

- **WHEN** 同一岗位连续两轮定时回合分别落地
- **THEN** 两轮身份行的 turn 值互不相同，且各自等于该轮实际使用的子会话/回合标识

#### Scenario: 非成员回合不注入

- **WHEN** 普通对话由一个未在岗任何舰队岗位的 persona 执行
- **THEN** 回合 prompt 与现状逐字一致，不含身份行

#### Scenario: 归属歧义不注入

- **WHEN** 执行回合的 persona 同时占据两个岗位
- **THEN** 不注入身份行（与报数面对歧义的诚实拒绝一致）

#### Scenario: 身份不含凭据

- **WHEN** 检查注入的身份行内容
- **THEN** 其中只含舰队标识、岗位标识、岗位名、目标引用与回合标识，不含任何 token、密钥或凭据
