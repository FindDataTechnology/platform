# case-progress

## What this is

案件进度与状态台账管理。案件 case.yaml 的唯一写入引擎（新增任务、推进任务、登记期限、更新案件阶段、校验、存量迁移），Agent 会话的进度加载与写回契约，以及案件进度监控对账。当用户或 Agent 需要"更新案件进度/推进任务/登记期限/更新案件阶段/同步案件状态/校验或迁移案件数据/查看案件结构化状态"时使用。不要用于：看板展示与周研判（用 case-dashboard）、案件建档初始化（用 new-case）。

Case progress and status ledger management. The sole write engine for a case's case.yaml (adding tasks, advancing tasks, recording deadlines, updating case stage, validation, migration of legacy data), the progress load and write-back contract for Agent sessions, and reconciliation of case progress monitoring. Use when the user or an Agent needs to 'update case progress', 'advance tasks', 'record deadlines', 'update case stage', 'sync case status', 'validate or migrate case data', or 'view structured case status'. Not for: dashboard display and weekly analysis (use case-dashboard), case file initialization (use new-case).

- Species: skill (plaza category enum v1)
- Official: no



## How to obtain

1. In 壹座 (Yizuo): Extensions → Skills — subscribe from the skills face.
2. Inside editors: skills reach your editor bundled with a pack that references them — install that pack with:

       npx @finddatatechnology/facet install <packId>

3. Deployed agent services receive registry skills through the registry supply channel.
Source repository: https://github.com/cat-xierluo/legal-skills


## As of

Provenance: https://facet.finddatatech.cloud/api/skills-catalog · As of: 2026-11-05
