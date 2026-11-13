# rotation-regime

## What this is

柏讯自适应轮动 · 市场状态判定（套件入口）。当用户要求判断当前 A 股市场处于进攻/中性/防守状态、要求给出轮动的择时前提、或问"现在该不该加仓/降仓"时使用。产出：带证据的 risk_on / neutral / risk_off 判定 + 波动率输入说明 + 参数重标表。本技能只做判定，不选股不建仓——排序与建仓交给 rotation-ranking / rotation-portfolio。

- Species: skill (plaza category enum v1)
- Official: no



## How to obtain

1. In 壹座 (Yizuo): Extensions → Skills — subscribe from the skills face.
2. Inside editors: skills reach your editor bundled with a pack that references them — install that pack with:

       npx @finddatatechnology/facet install <packId>

3. Deployed agent services receive registry skills through the registry supply channel.
Source repository: https://gitee.com/FindDataTechnology/finddata-skills/tree/master/wire-presets/tree/main/skills/rotation-regime


## As of

Provenance: https://facet.finddatatech.cloud/api/skills-catalog · As of: 2026-11-05
