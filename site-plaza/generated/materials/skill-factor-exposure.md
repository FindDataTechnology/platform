# factor-exposure

## What this is

柏讯因子选股 · 因子暴露与分层。当用户要求"算某只/某组标的的因子暴露""按因子分层看收益差""给我这个因子的 IC""这个因子在横截面上有没有区分度"时使用。暴露、分层、IC 与秩变换全部经 fd-quant 计算面完成，不在对话里手算；层数、极端值处理、样本门槛三处必须显式声明。产出：暴露表 + 分层收益表 + IC 数值与样本量。不做选股、不做因子择时。

- Species: skill (plaza category enum v1)
- Official: no



## How to obtain

1. In 壹座 (Yizuo): Extensions → Skills — subscribe from the skills face.
2. Inside editors: skills reach your editor bundled with a pack that references them — install that pack with:

       npx @finddatatechnology/facet install <packId>

3. Deployed agent services receive registry skills through the registry supply channel.
Source repository: https://gitee.com/FindDataTechnology/finddata-skills/tree/master/wire-presets/tree/main/skills/factor-exposure


## As of

Provenance: https://facet.finddatatech.cloud/api/skills-catalog · As of: 2026-11-05
