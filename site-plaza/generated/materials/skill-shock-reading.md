# shock-reading

## What this is

柏讯信息冲击 · 冲击解读。当用户要求"这条公告/这条信息说了什么""把关键条款摘出来""这个消息的具体金额和条件"时使用。读条目正文，抽取金额/比例/期限/主体/生效条件五类要素，结论分"明确（正文要素直接支撑）"与"需看条件"两栏；每条结论附证据块：item_id、as_of（发布时间）与经 locate_evidence 核对的原文逐字片段。硬约束：未读正文不结论；强断言缺可定位证据时只能弱表述"据标题/摘要，正文未核实"。不预测涨跌。

- Species: skill (plaza category enum v1)
- Official: no



## How to obtain

1. In 壹座 (Yizuo): Extensions → Skills — subscribe from the skills face.
2. Inside editors: skills reach your editor bundled with a pack that references them — install that pack with:

       npx @finddatatechnology/facet install <packId>

3. Deployed agent services receive registry skills through the registry supply channel.
Source repository: https://gitee.com/FindDataTechnology/finddata-skills/tree/master/wire-presets/tree/main/skills/shock-reading


## As of

Provenance: https://facet.finddatatech.cloud/api/skills-catalog · As of: 2026-11-05
