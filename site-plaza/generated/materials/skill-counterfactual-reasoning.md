# counterfactual-reasoning

## What this is

当需要评估'如果某一事实/行为/条件不存在或发生改变，法律结果将如何不同'时触发此技能。典型触发场景包括：因果关系认定（若无该行为，损害是否仍会发生）、过错与责任比例划分、损害赔偿范围确定、合同违约损失计算、行政行为合法性假设检验、刑事因果关系中断判断、立法影响评估等。核心方法是构建一个与现实世界仅在目标变量上不同的'反事实世界'，比较两个世界的结果差异，从而得出目标变量对结果的贡献程度。

Triggers when one needs to assess "how the legal outcome would differ if a given fact/action/condition did not exist or changed". Typical trigger scenarios include: causation determination (would the harm still occur absent the act), apportioning fault and liability shares, defining the scope of damages, calculating contract breach losses, hypothesis-testing the legality of administrative acts, judging interruptions of criminal causation, assessing legislative impact, and the like. The core method is to construct a "counterfactual world" that differs from the real world only in the target variable, compare the outcome differences between the two worlds, and thereby derive the target variable's degree of contribution to the outcome.

- Species: skill (plaza category enum v1)
- Official: no



## How to obtain

1. In 壹座 (Yizuo): Extensions → Skills — subscribe from the skills face.
2. Inside editors: skills reach your editor bundled with a pack that references them — install that pack with:

       npx @finddatatechnology/facet install <packId>

3. Deployed agent services receive registry skills through the registry supply channel.
Source repository: https://github.com/THUYRan/Legal-Skills-Chinese


## As of

Provenance: https://facet.finddatatech.cloud/api/skills-catalog · As of: 2026-11-05
