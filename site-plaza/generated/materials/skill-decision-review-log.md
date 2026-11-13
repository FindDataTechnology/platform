# decision-review-log

## What this is

柏讯决策落账纪律（复盘套件入口）。当用户要求把一条判定（Rating）或目标权重（TargetWeights）记入决策账本、要求"再记一次"、要求修改或"更正"已落账的判定、或需要查回某标的的历史判定与教训时使用。账本是追加式的：幂等键 (as_of, symbol, pack, skill) 拒绝重复提交并返回既有 decision_id，修订产生新记录并以 revises 指向被修订记录，历史判定永不被就地改写。

- Species: skill (plaza category enum v1)
- Official: no



## How to obtain

1. In 壹座 (Yizuo): Extensions → Skills — subscribe from the skills face.
2. Inside editors: skills reach your editor bundled with a pack that references them — install that pack with:

       npx @finddatatechnology/facet install <packId>

3. Deployed agent services receive registry skills through the registry supply channel.
Source repository: https://gitee.com/FindDataTechnology/finddata-skills/tree/master/wire-presets/tree/main/skills/decision-review-log


## As of

Provenance: https://facet.finddatatech.cloud/api/skills-catalog · As of: 2026-11-05
