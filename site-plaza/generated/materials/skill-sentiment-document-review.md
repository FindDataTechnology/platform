# sentiment-document-review

## What this is

柏讯舆情驱动 · 公告舆情审读。当用户要求"看看这家公司最近的公告口径怎么样""给这几篇公告做个舆情判断""这些公告偏正面还是负面""公告里有什么值得注意的表述"时使用。取公告全文（巨潮面）→ 逐篇打分（fd-sentiment，分数必带原文引用）→ 呈现分数/band/置信度/引用片段与定位。多篇给分布而非平均情绪；拒答时如实转述；低置信显式标注。不做交易信号，不给情绪指数。

- Species: skill (plaza category enum v1)
- Official: no



## How to obtain

1. In 壹座 (Yizuo): Extensions → Skills — subscribe from the skills face.
2. Inside editors: skills reach your editor bundled with a pack that references them — install that pack with:

       npx @finddatatechnology/facet install <packId>

3. Deployed agent services receive registry skills through the registry supply channel.
Source repository: https://gitee.com/FindDataTechnology/finddata-skills/tree/master/wire-presets/tree/main/skills/sentiment-document-review


## As of

Provenance: https://facet.finddatatech.cloud/api/skills-catalog · As of: 2026-11-05
