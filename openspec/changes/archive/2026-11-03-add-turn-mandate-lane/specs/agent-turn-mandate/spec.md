## Purpose

事件来源回合请求的授权链：让「谁有权让智能体开工」成为显式、不可变、可审计的记录。以强度与准入表描述授权依据，以影子档（off/observe/auto）控制自动化放量，以入站去向账保证每个触发有精确终局。现行「命中边即唤醒」的行为为默认值，本能力为纯记账性新增与 opt-in 扩面，不改变既有唤醒判定。

## ADDED Requirements

### Requirement: 唤醒回合携带不可变授权 mandate

凡经 event 边创建的唤醒回合，系统 SHALL 在创建时记录授权 mandate，至少含：强度（explicit / inferred）、basis（准入依据与接收范围）、信号源策略版本戳、触发引用（botId、chatKey、发送者标识）。mandate SHALL NOT 在创建后被改写：仅 accept（创建）、人停（撤销）、恢复前重校验失败（吊销）三种操作可改变其有效性。回合重试 SHALL 沿用原 mandate；回合恢复 SHALL 先按当前信号源策略重校验 mandate，重校验失败 SHALL NOT 恢复该回合，其待处理消息 SHALL 按未命中处理并如实留痕。

#### Scenario: 命中边唤醒记录 explicit mandate

- **WHEN** 某舰队声明 event 边 bot:客服bot→客服岗，名单内发送者的消息命中该边
- **THEN** 创建的唤醒回合携带 mandate：strength=explicit、basis.via=edge、含策略版本戳与触发引用

#### Scenario: 重试沿用原 mandate

- **WHEN** 一个 mandate=explicit(inferred) 的唤醒回合被重试
- **THEN** 新任务沿用原 mandate 原值，策略版本戳不变

#### Scenario: 恢复前重校验失败不恢复

- **WHEN** 一个挂起的 inferred mandate 回合在恢复时，其信号源已关闭 auto 且其 basis 依赖 auto 档
- **THEN** 该回合不被恢复，其待处理消息记为未命中并留 reason code

### Requirement: 信号源准入表

每个 bot 信号源（`bot:<id>`）的策略 SHALL 含准入表：以「接收范围 × 发送者身份（名单内 / 名单外 / bot）× 是否点名 bot」为轴，每格取值 explicit / inferred / 忽略。默认表 SHALL 保持现行行为：命中 event 边的接收范围内消息 = explicit（现行唯一准入面）；名单外点名、未点名消息等新增准入面默认忽略。准入表变更 SHALL NOT 撤销任何在途回合的 mandate；收紧仅在恢复前重校验时生效。

#### Scenario: 默认表与现状逐字节一致

- **WHEN** 主人未修改任何准入格，bot 收到消息且命中某 event 边
- **THEN** 唤醒判定、回合创建与现行行为逐字节一致

#### Scenario: 准入表收紧不撤销在途

- **WHEN** 主人把某格从 explicit 收紧为忽略，此时存在该格准入依据下创建的开启回合
- **THEN** 在途回合不受影响照常执行；其下次恢复前重校验按新表判定

### Requirement: 影子放量档 off/observe/auto

每个 bot 信号源的策略 SHALL 含放量档：off（默认）/ observe / auto。off SHALL 与现行行为逐字节一致（仅默认准入面生效）。observe SHALL 对新准入面（默认表下被忽略的 inferred 候选）做完整研判但只记录 would-accept，SHALL NOT 创建回合。auto SHALL 仅当主人明示开启且该信号源存在显式接受规则时生效；缺任一条件 SHALL 保持 observe 行为。放量档与准入表变更 SHALL 产生新的策略版本戳。

#### Scenario: observe 记录不唤醒

- **WHEN** 信号源开 observe，名单外发送者点名 bot 且无命中边
- **THEN** 系统完整研判并记录 would-accept（含研判依据），不创建任何回合

#### Scenario: auto 需明示开启与显式规则

- **WHEN** 信号源放量档被置为 auto 但主人未写任何显式接受规则
- **THEN** inferred 候选按 observe 行为处理（记录不建回合），并如实提示缺接受规则

#### Scenario: off 与现状逐字节一致

- **WHEN** 全部信号源保持默认 off
- **THEN** 入站处理、唤醒判定与任务创建与现行行为逐字节一致

### Requirement: 入站去向账 disposition

每个 bot 入站消息 SHALL 有精确去向记录（disposition）：admitted（含 mandate 引用）/ filtered（带结构化 reason code）/ would-accept（observe 研判通过）/ cap-refused。reason code SHALL 为码+值结构，SHALL NOT 以自由文本归因。去向账 SHALL 仅作记录，SHALL NOT 触发回合、SHALL NOT 改变既有唤醒判定与任务创建路径。每 bot 信号源的去向记录 SHALL 为有界环（超限翻转最旧），SHALL NOT 无限增长；现行 cap 超限的 O1 留痕 SHALL 并入统一去向账。

#### Scenario: 过滤留痕

- **WHEN** bot 收到一条未命中任何 event 边且放量档为 off 的消息
- **THEN** 去向账记录 filtered + reason code（如 off_mode/no_edge），不建任务

#### Scenario: cap 拒绝并入统一账

- **WHEN** 一小时内某岗唤醒已达上限又来一条命中消息
- **THEN** 该消息记 cap-refused（沿用现行 cap 语义），并保持既有 O1 如实留痕

#### Scenario: 有界环翻转

- **WHEN** 某信号源去向记录超过环上限后又来新消息
- **THEN** 新记录写入、最旧记录翻转丢弃，总记录数有界
