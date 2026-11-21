# event-history

## What this is

柏讯事件驱动 · 历史反应统计。当用户要求"这类事件历史上发生后表现如何""业绩预增公告后 20 天一般怎么走""帮我看看这个事件类型的历史分布"时使用。对同类事件做多窗口（默认 5/10/20 个交易日）的历史反应统计：样本量、分位数、均值与离散度，并强制给出反例比例与样本门槛。全部输出为描述性历史分布，不是预测；样本不足不下结论；口径（按分类或按关键词）随结果一并写出。不提供涨跌预期、不给买卖建议。

- Species: skill (plaza category enum v1)
- Official: no



## How to obtain

1. In 壹座 (Yizuo): Extensions → Skills — subscribe from the skills face.
2. Inside editors: skills reach your editor bundled with a pack that references them — install that pack with:

       npx @finddatatechnology/facet install <packId>

3. Deployed agent services receive registry skills through the registry supply channel.
Source repository: https://gitee.com/FindDataTechnology/finddata-skills/tree/master/wire-presets/tree/main/skills/event-history


## As of

Provenance: https://facet.finddatatech.cloud/api/skills-catalog · As of: 2026-11-05
