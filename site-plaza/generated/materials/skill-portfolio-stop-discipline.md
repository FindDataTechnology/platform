# portfolio-stop-discipline

## What this is

柏讯组合风险 · 止损纪律。当用户要求"止损设多少""移动止损怎么定""止损设了会自动执行吗""帮我看看哪些已经跌破线了"时使用。产出：一份用户既定的止损规则（绝对止损 / 移动止损 / 冷却期，含量级起点与按波动重标的方法与依据）+ 触发检查的状态呈现（当前值 vs 阈值 + 冷却剩余）。**本技能必须首先声明：这些是用户的纪律设定，不是引擎保证——引擎不会自动执行止损，权重模式只消费 weights_series，契约的 constraints 只有单票与板块两个上限字段，没有任何止损字段。**

- Species: skill (plaza category enum v1)
- Official: no



## How to obtain

1. In 壹座 (Yizuo): Extensions → Skills — subscribe from the skills face.
2. Inside editors: skills reach your editor bundled with a pack that references them — install that pack with:

       npx @finddatatechnology/facet install <packId>

3. Deployed agent services receive registry skills through the registry supply channel.
Source repository: https://gitee.com/FindDataTechnology/finddata-skills/tree/master/wire-presets/tree/main/skills/portfolio-stop-discipline


## As of

Provenance: https://facet.finddatatech.cloud/api/skills-catalog · As of: 2026-11-05
