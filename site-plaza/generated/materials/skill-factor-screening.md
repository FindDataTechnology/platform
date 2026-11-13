# factor-screening

## What this is

柏讯因子选股 · 选股应用。当用户要求"按这些因子筛一批股票""多因子打分选前 N 只""把因子结论变成可回测的持仓"时使用。把 factor-exposure 的暴露与 IC 结果变成候选 universe 与目标权重，权重或规则显式写出，筛选条件逐条可解释，缺失因子按声明规则处理。产出可直接进入权重模式回测的候选名单/权重。因子打分不是预测。

- Species: skill (plaza category enum v1)
- Official: no



## How to obtain

1. In 壹座 (Yizuo): Extensions → Skills — subscribe from the skills face.
2. Inside editors: skills reach your editor bundled with a pack that references them — install that pack with:

       npx @finddatatechnology/facet install <packId>

3. Deployed agent services receive registry skills through the registry supply channel.
Source repository: https://gitee.com/FindDataTechnology/finddata-skills/tree/master/wire-presets/tree/main/skills/factor-screening


## As of

Provenance: https://facet.finddatatech.cloud/api/skills-catalog · As of: 2026-11-05
