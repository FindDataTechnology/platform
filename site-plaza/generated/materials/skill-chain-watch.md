# chain-watch

## What this is

柏讯产业链联动 · 链条景气跟踪。当用户要求"盯一下这条链最近怎么样""按环节给我看关键变量的最新走势""哪些数据好久没更新了"时使用。产出：按环节分组的变量走势表（来源 + 最新期数 + 缺口标注 + 变化方向），不含预测、不含建议。宿主 cron 可定时触发（本技能只给方法与输出形态，不实现调度）。

- Species: skill (plaza category enum v1)
- Official: no



## How to obtain

1. In 壹座 (Yizuo): Extensions → Skills — subscribe from the skills face.
2. Inside editors: skills reach your editor bundled with a pack that references them — install that pack with:

       npx @finddatatechnology/facet install <packId>

3. Deployed agent services receive registry skills through the registry supply channel.
Source repository: https://gitee.com/FindDataTechnology/finddata-skills/tree/master/wire-presets/tree/main/skills/chain-watch


## As of

Provenance: https://facet.finddatatech.cloud/api/skills-catalog · As of: 2026-11-05
