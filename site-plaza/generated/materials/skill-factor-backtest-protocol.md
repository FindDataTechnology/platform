# factor-backtest-protocol

## What this is

柏讯因子选股 · 无未来函数回测协议。当用户要把因子策略送进回测、要核对"这次回测有没有偷看未来"、要区分样本内与样本外、或要验某条未来数据会不会被拦住时使用。把四条点内纪律写成可核验的断言（财报按披露日、universe 用当期成分、价格止于决策日、断言必须开启），并用注入未来披露的夹具证明协议真的在拦。产出：回测口径卡 + 断言记录 + 夹具测试结果 + 样本内外分离的结论。不做因子择时、不给预期收益。

- Species: skill (plaza category enum v1)
- Official: no



## How to obtain

1. In 壹座 (Yizuo): Extensions → Skills — subscribe from the skills face.
2. Inside editors: skills reach your editor bundled with a pack that references them — install that pack with:

       npx @finddatatechnology/facet install <packId>

3. Deployed agent services receive registry skills through the registry supply channel.
Source repository: https://gitee.com/FindDataTechnology/finddata-skills/tree/master/wire-presets/tree/main/skills/factor-backtest-protocol


## As of

Provenance: https://facet.finddatatech.cloud/api/skills-catalog · As of: 2026-11-05
