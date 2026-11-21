# ic-adjudication

## What this is

柏讯投委会 · 裁决（套件入口技能）。当用户要求"开投委会""对某只股票做一次多空辩论并给结论""裁决多头空头的分歧""把辩论结论落账"时使用。本技能是套件入口：调度 ic-bull-case 与 ic-bear-case 双方立论，然后按四条裁决纪律（冲突不给 hold 须指强弱、证据不足给 review 不降级、产出 Rating 契约实例、change_my_mind 必填）给出 Rating 契约实例，并可落账（账本不可用时明示"未落账"）。形态为单 agent 内分角色，不构成独立视角。

- Species: skill (plaza category enum v1)
- Official: no



## How to obtain

1. In 壹座 (Yizuo): Extensions → Skills — subscribe from the skills face.
2. Inside editors: skills reach your editor bundled with a pack that references them — install that pack with:

       npx @finddatatechnology/facet install <packId>

3. Deployed agent services receive registry skills through the registry supply channel.
Source repository: https://gitee.com/FindDataTechnology/finddata-skills/tree/master/wire-presets/tree/main/skills/ic-adjudication


## As of

Provenance: https://facet.finddatatech.cloud/api/skills-catalog · As of: 2026-11-05
