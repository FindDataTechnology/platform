# decision-review-portfolio

## What this is

柏讯持仓体检。当用户要求体检当前模拟账户持仓、看集中度（HHI/前 N 权重）、期间回撤、行业暴露，或核查"持仓是否偏离了最近一次判定"时使用。持仓与账户取自柏讯模拟交易服务（paper-only，模拟盘，无真实资金），统计量一律交给 fd-quant 计算面，缺失数据如实标注，结论为研究参考、不含买卖建议。

- Species: skill (plaza category enum v1)
- Official: no



## How to obtain

1. In 壹座 (Yizuo): Extensions → Skills — subscribe from the skills face.
2. Inside editors: skills reach your editor bundled with a pack that references them — install that pack with:

       npx @finddatatechnology/facet install <packId>

3. Deployed agent services receive registry skills through the registry supply channel.
Source repository: https://gitee.com/FindDataTechnology/finddata-skills/tree/master/wire-presets/tree/main/skills/decision-review-portfolio


## As of

Provenance: https://facet.finddatatech.cloud/api/skills-catalog · As of: 2026-11-05
