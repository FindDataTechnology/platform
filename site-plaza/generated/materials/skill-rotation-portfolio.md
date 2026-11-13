# rotation-portfolio

## What this is

柏讯自适应轮动 · 风险预算建仓与风控参数。当用户要求"按排序结果给个仓位方案""组之间怎么分配""止损怎么设"时使用。产出：TargetWeights 契约实例（组权重 → 资产权重）+ 风险预算依据 + 风控参数（并明确止损须在策略内表达、引擎不自动执行）。

- Species: skill (plaza category enum v1)
- Official: no



## How to obtain

1. In 壹座 (Yizuo): Extensions → Skills — subscribe from the skills face.
2. Inside editors: skills reach your editor bundled with a pack that references them — install that pack with:

       npx @finddatatechnology/facet install <packId>

3. Deployed agent services receive registry skills through the registry supply channel.
Source repository: https://gitee.com/FindDataTechnology/finddata-skills/tree/master/wire-presets/tree/main/skills/rotation-portfolio


## As of

Provenance: https://facet.finddatatech.cloud/api/skills-catalog · As of: 2026-11-05
