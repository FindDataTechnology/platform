# equity-research-modeling

## What this is

个股投研的估值建模与计算层。当用户要求给某家 A 股/港股公司做 DCF、DDM、可比倍数、Monte Carlo 或敏感性分析，或要求算基本面比率、跑红旗检测、把多种估值方法合成目标价时使用。全部算术一律调 fd-quant 确定性计算面（通道 Q），本技能只组织输入、标注来源、原样转述返回；计算面不可用时顶部明示"估值部分未完成"，绝不自算顶替。财务科目走柏讯服务端通道 A，价格与市值类输入走本地 DAAS 通道 B。

- Species: skill (plaza category enum v1)
- Official: no



## How to obtain

1. In 壹座 (Yizuo): Extensions → Skills — subscribe from the skills face.
2. Inside editors: skills reach your editor bundled with a pack that references them — install that pack with:

       npx @finddatatechnology/facet install <packId>

3. Deployed agent services receive registry skills through the registry supply channel.
Source repository: https://gitee.com/FindDataTechnology/finddata-skills/tree/master/wire-presets/tree/main/skills/equity-research-modeling


## As of

Provenance: https://facet.finddatatech.cloud/api/skills-catalog · As of: 2026-11-05
