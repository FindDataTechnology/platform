# portfolio-budget

## What this is

柏讯组合风险 · 风险预算。当用户要求"资金怎么分到这些标的/行业""单票最多放多少""按上限重新分配一遍"时使用。产出：一份**生成即合规**的 TargetWeights 契约实例（单票上限 + 板块上限 + 迭代重分配，迭代上限显式，未收敛如实报告）+ 约束满足表。只管权重结构，不管"该投多少钱"；现金靠 Σweights < 1 留出，引擎不会替你扣。

- Species: skill (plaza category enum v1)
- Official: no



## How to obtain

1. In 壹座 (Yizuo): Extensions → Skills — subscribe from the skills face.
2. Inside editors: skills reach your editor bundled with a pack that references them — install that pack with:

       npx @finddatatechnology/facet install <packId>

3. Deployed agent services receive registry skills through the registry supply channel.
Source repository: https://gitee.com/FindDataTechnology/finddata-skills/tree/master/wire-presets/tree/main/skills/portfolio-budget


## As of

Provenance: https://facet.finddatatech.cloud/api/skills-catalog · As of: 2026-11-05
