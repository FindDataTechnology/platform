# shock-window

## What this is

柏讯信息冲击 · 影响窗口统计。当用户要求"这类公告发布前后一般怎么走""这条信息的历史前后窗口表现""前后窗口指标偏离多大"时使用。对同类信息冲击做多窗口（默认前窗 5 日基准 + 后窗 5/10/20 个交易日）的历史统计：样本量、分位、离散度与必选的反例比例；样本不足时整表标注"不作依据"。全部输出为描述性历史分布，不是预测；价格只走通道 B，计算只走通道 Q。

- Species: skill (plaza category enum v1)
- Official: no



## How to obtain

1. In 壹座 (Yizuo): Extensions → Skills — subscribe from the skills face.
2. Inside editors: skills reach your editor bundled with a pack that references them — install that pack with:

       npx @finddatatechnology/facet install <packId>

3. Deployed agent services receive registry skills through the registry supply channel.
Source repository: https://gitee.com/FindDataTechnology/finddata-skills/tree/master/wire-presets/tree/main/skills/shock-window


## As of

Provenance: https://facet.finddatatech.cloud/api/skills-catalog · As of: 2026-11-05
