# equity-research-thesis

## What this is

个股论点综合与方向判定（Rating 契约实例）。当用户要求给某只股票下方向结论、写投资论点、列催化剂与风险、给目标价，或把取数/同行/建模三段结果收敛成一个可入决策账本的判定时使用。产出 side / conviction / price_target（可 null）/ basis / evidence；方法分歧、价格通道不可用或输入不足时扣值不扣结论。财务与披露走柏讯服务端通道 A，本地库存读数走本地 DAAS 通道 B，估值与统计量走 fd-quant 计算面通道 Q。

- Species: skill (plaza category enum v1)
- Official: no



## How to obtain

1. In 壹座 (Yizuo): Extensions → Skills — subscribe from the skills face.
2. Inside editors: skills reach your editor bundled with a pack that references them — install that pack with:

       npx @finddatatechnology/facet install <packId>

3. Deployed agent services receive registry skills through the registry supply channel.
Source repository: https://gitee.com/FindDataTechnology/finddata-skills/tree/master/wire-presets/tree/main/skills/equity-research-thesis


## As of

Provenance: https://facet.finddatatech.cloud/api/skills-catalog · As of: 2026-11-05
