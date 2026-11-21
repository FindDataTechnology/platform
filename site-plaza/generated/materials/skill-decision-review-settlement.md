# decision-review-settlement

## What this is

柏讯到期结算复盘。当用户要求结算某条已落账的判定、想知道某判定"后来怎么样了"、要求汇总待结算记录、或要看原始收益与相对基准 alpha 时使用。流程为待结算汇总 → 取结算窗序列（价格走本地 DAAS 通道 B）→ 触发账本结算 → 三段式输出（判定理由回顾 + 结算结果 + 对照评述）。持有期未满不强行结算；alpha 为负不等于判断错误。

- Species: skill (plaza category enum v1)
- Official: no



## How to obtain

1. In 壹座 (Yizuo): Extensions → Skills — subscribe from the skills face.
2. Inside editors: skills reach your editor bundled with a pack that references them — install that pack with:

       npx @finddatatechnology/facet install <packId>

3. Deployed agent services receive registry skills through the registry supply channel.
Source repository: https://gitee.com/FindDataTechnology/finddata-skills/tree/master/wire-presets/tree/main/skills/decision-review-settlement


## As of

Provenance: https://facet.finddatatech.cloud/api/skills-catalog · As of: 2026-11-05
