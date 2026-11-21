# strategy-design

## What this is

柏讯策略工坊 · 策略设计。当用户想把一个投资想法变成可回测的多标的策略（universe + 目标权重 + 调仓频率）、想理解权重语义（和为 1、非负、余量现金）、想取舍调仓频率与换手、或想知道哪些表达不被支持（做空/杠杆/盘中调仓）时使用。产出：一份可创建的 weight 模式策略 spec。

- Species: skill (plaza category enum v1)
- Official: no



## How to obtain

1. In 壹座 (Yizuo): Extensions → Skills — subscribe from the skills face.
2. Inside editors: skills reach your editor bundled with a pack that references them — install that pack with:

       npx @finddatatechnology/facet install <packId>

3. Deployed agent services receive registry skills through the registry supply channel.
Source repository: https://gitee.com/FindDataTechnology/finddata-skills/tree/master/wire-presets/tree/main/skills/strategy-design


## As of

Provenance: https://facet.finddatatech.cloud/api/skills-catalog · As of: 2026-11-05
