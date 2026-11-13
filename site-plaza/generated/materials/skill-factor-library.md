# factor-library

## What this is

柏讯因子选股 · 因子库与口径。当用户问"有哪些基本面因子可用""这个因子怎么算""为什么这两个因子不能同时用""某个因子在 A 股跑不跑得动"时使用。收录 FinRL-X 的 52 个基本面因子（九类），逐因子给出分子、分母、所用报表、期别、取值来源、数据可得性档位与 A 股适配说明，并写明三个共线因子的剔除理由。本技能只定义因子、不计算因子值、不选股、不做因子择时。

- Species: skill (plaza category enum v1)
- Official: no



## How to obtain

1. In 壹座 (Yizuo): Extensions → Skills — subscribe from the skills face.
2. Inside editors: skills reach your editor bundled with a pack that references them — install that pack with:

       npx @finddatatechnology/facet install <packId>

3. Deployed agent services receive registry skills through the registry supply channel.
Source repository: https://gitee.com/FindDataTechnology/finddata-skills/tree/master/wire-presets/tree/main/skills/factor-library


## As of

Provenance: https://facet.finddatatech.cloud/api/skills-catalog · As of: 2026-11-05
