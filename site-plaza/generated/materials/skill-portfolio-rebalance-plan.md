# portfolio-rebalance-plan

## What this is

柏讯组合风险 · 再平衡方案。当用户要求"从现在的持仓调到这个目标权重，具体买什么卖什么""每只调多少股""调仓成本大概多少""这套再平衡规则历史上表现如何"时使用。产出：逐标的差额 / 方向 / 整数股数（向下取整，与权重模式引擎同口径）+ 成本预估（佣金 / 印花税 / 滑点分项，参数显式）+ 可送入权重模式回测的权重规则。**方案不含择时建议**；并明确引擎不自动执行止损、只消费 weights_series，cash_floor 只是权重上限校验而非独立持仓约束。

- Species: skill (plaza category enum v1)
- Official: no



## How to obtain

1. In 壹座 (Yizuo): Extensions → Skills — subscribe from the skills face.
2. Inside editors: skills reach your editor bundled with a pack that references them — install that pack with:

       npx @finddatatechnology/facet install <packId>

3. Deployed agent services receive registry skills through the registry supply channel.
Source repository: https://gitee.com/FindDataTechnology/finddata-skills/tree/master/wire-presets/tree/main/skills/portfolio-rebalance-plan


## As of

Provenance: https://facet.finddatatech.cloud/api/skills-catalog · As of: 2026-11-05
