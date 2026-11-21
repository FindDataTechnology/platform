# event-watch

## What this is

柏讯事件驱动 · 事件跟踪。当用户要求"帮我盯住这几家公司""每天把公告按类型筛一遍""按标的或事件类型给我一张事件跟踪表"时使用。按标的与事件类型筛选公告流，输出事件清单、分类计数与期间对比（本周 vs 上周等），并明确标注检索口径与数据截至日期。不做预告、不做推荐、不预测影响；定时触发属宿主 cron 配置，本技能只提供被调用时的方法与输出形态，不实现调度。

- Species: skill (plaza category enum v1)
- Official: no



## How to obtain

1. In 壹座 (Yizuo): Extensions → Skills — subscribe from the skills face.
2. Inside editors: skills reach your editor bundled with a pack that references them — install that pack with:

       npx @finddatatechnology/facet install <packId>

3. Deployed agent services receive registry skills through the registry supply channel.
Source repository: https://gitee.com/FindDataTechnology/finddata-skills/tree/master/wire-presets/tree/main/skills/event-watch


## As of

Provenance: https://facet.finddatatech.cloud/api/skills-catalog · As of: 2026-11-05
