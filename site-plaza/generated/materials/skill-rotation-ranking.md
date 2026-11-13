# rotation-ranking

## What this is

柏讯自适应轮动 · 组与组内排序。当用户要求"哪些行业值得配""组内选哪几只""为什么这个组落选"时使用。组 = 申万 L1（31 类）成分股合成的行业指数；组强度用信息比排序，组内用残差动量 + 稳健 Z。产出：组排序表 + 组内排序表 + 落选原因。不建仓（交给 rotation-portfolio）。

- Species: skill (plaza category enum v1)
- Official: no



## How to obtain

1. In 壹座 (Yizuo): Extensions → Skills — subscribe from the skills face.
2. Inside editors: skills reach your editor bundled with a pack that references them — install that pack with:

       npx @finddatatechnology/facet install <packId>

3. Deployed agent services receive registry skills through the registry supply channel.
Source repository: https://gitee.com/FindDataTechnology/finddata-skills/tree/master/wire-presets/tree/main/skills/rotation-ranking


## As of

Provenance: https://facet.finddatatech.cloud/api/skills-catalog · As of: 2026-11-05
