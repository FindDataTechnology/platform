# event-reading

## What this is

柏讯事件驱动 · 事件解读。当用户要求"这条公告到底说了什么""这个定增/减持/业绩预告怎么看""把公告关键条款摘出来"时使用。读公告正文（get_filing），抽取金额、比例、期限、主体、生效条件五类要素，把结论分成"正文要素直接支撑（明确）"与"需看条件"两栏，每条结论引用原文并给出公告标识。硬约束：未读正文不结论，标题与分类只是检索入口。不做涨跌预测，不给买卖建议；对"预期已计入"只作事实呈现与一般性提示。

- Species: skill (plaza category enum v1)
- Official: no



## How to obtain

1. In 壹座 (Yizuo): Extensions → Skills — subscribe from the skills face.
2. Inside editors: skills reach your editor bundled with a pack that references them — install that pack with:

       npx @finddatatechnology/facet install <packId>

3. Deployed agent services receive registry skills through the registry supply channel.
Source repository: https://gitee.com/FindDataTechnology/finddata-skills/tree/master/wire-presets/tree/main/skills/event-reading


## As of

Provenance: https://facet.finddatatech.cloud/api/skills-catalog · As of: 2026-11-05
