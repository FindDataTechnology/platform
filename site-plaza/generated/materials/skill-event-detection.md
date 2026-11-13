# event-detection

## What this is

柏讯事件驱动 · 事件识别与分类。当用户要求"这家公司最近有什么公告/大事""近三个月事件梳理""哪些公司发了业绩预告""把公告按事件类型分一下"时使用。三路检索（公告列表 / 分类字典 / 全文检索），把公告归入六组事件类型（业绩类、融资类、股权变动、监管类、经营类、互动类），逐条附公告标识、披露日期、上游分类与归类依据。只做识别与分类：不读正文下结论、不判断利好利空、不做反应统计（分别交给 event-reading 与 event-history）。

- Species: skill (plaza category enum v1)
- Official: no



## How to obtain

1. In 壹座 (Yizuo): Extensions → Skills — subscribe from the skills face.
2. Inside editors: skills reach your editor bundled with a pack that references them — install that pack with:

       npx @finddatatechnology/facet install <packId>

3. Deployed agent services receive registry skills through the registry supply channel.
Source repository: https://gitee.com/FindDataTechnology/finddata-skills/tree/master/wire-presets/tree/main/skills/event-detection


## As of

Provenance: https://facet.finddatatech.cloud/api/skills-catalog · As of: 2026-11-05
