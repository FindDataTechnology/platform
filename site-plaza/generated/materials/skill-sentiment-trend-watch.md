# sentiment-trend-watch

## What this is

柏讯舆情驱动 · 舆情转向追踪。当用户要求"这家公司最近舆情是在变好还是变差""这段时间公告口径有没有转向""按月看公告情绪的分布变化""找出情绪转折点对应的公告"时使用。按公告发布日排布分数，给逐期分布与转向点（附对应文档），并强制报告覆盖面与置信度两栏。样本不足时明示不下转向结论。不给情绪指数、不给交易信号。

- Species: skill (plaza category enum v1)
- Official: no



## How to obtain

1. In 壹座 (Yizuo): Extensions → Skills — subscribe from the skills face.
2. Inside editors: skills reach your editor bundled with a pack that references them — install that pack with:

       npx @finddatatechnology/facet install <packId>

3. Deployed agent services receive registry skills through the registry supply channel.
Source repository: https://gitee.com/FindDataTechnology/finddata-skills/tree/master/wire-presets/tree/main/skills/sentiment-trend-watch


## As of

Provenance: https://facet.finddatatech.cloud/api/skills-catalog · As of: 2026-11-05
