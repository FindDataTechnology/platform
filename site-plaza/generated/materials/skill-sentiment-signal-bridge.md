# sentiment-signal-bridge

## What this is

柏讯舆情驱动 · 舆情与价格/持仓的描述性对照。当用户要求"舆情和股价是什么关系""情绪是不是领先价格""看看公告情绪和我持仓的对应""舆情能不能当信号用"时使用。做的是描述性对照：把分数分布的时间位置与价格/持仓的时间位置并排放，说清先后与是否同期，并强制标注样本是否足以做描述性陈述。严禁给买卖建议、严禁把舆情称为信号。价格通道或账本不可用时明示降级。

- Species: skill (plaza category enum v1)
- Official: no



## How to obtain

1. In 壹座 (Yizuo): Extensions → Skills — subscribe from the skills face.
2. Inside editors: skills reach your editor bundled with a pack that references them — install that pack with:

       npx @finddatatechnology/facet install <packId>

3. Deployed agent services receive registry skills through the registry supply channel.
Source repository: https://gitee.com/FindDataTechnology/finddata-skills/tree/master/wire-presets/tree/main/skills/sentiment-signal-bridge


## As of

Provenance: https://facet.finddatatech.cloud/api/skills-catalog · As of: 2026-11-05
