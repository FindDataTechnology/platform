# equity-valuation

## What this is

股票估值（DCF + 可比公司 + 三表联动）。当用户要求给某家 A 股/港股公司做内在价值或相对估值、算 WACC 与终值、跑敏感性与情景表、给目标价区间、做同业倍数对照与反推市场隐含预期时使用。财务数据走柏讯服务端通道 A，价格与市值走本地 DAAS 通道 B；通道 B 未连接时中止估值，不给目标价。

Equity valuation (DCF + comparable companies + three-statement linkage). Use when the user asks for intrinsic or relative valuation of an A-share/HK-listed company, WACC and terminal value calculation, sensitivity and scenario tables, a target price range, peer multiple comparison, or back-solving the market's implied expectations. Financial data goes through 柏讯 server-side channel A; prices and market caps through local DAAS channel B; if channel B is not connected, the valuation halts and no target price is given.

- Species: skill (plaza category enum v1)
- Official: no



## How to obtain

1. In 壹座 (Yizuo): Extensions → Skills — subscribe from the skills face.
2. Inside editors: skills reach your editor bundled with a pack that references them — install that pack with:

       npx @finddatatechnology/facet install <packId>

3. Deployed agent services receive registry skills through the registry supply channel.
Source repository: https://gitee.com/FindDataTechnology/finddata-skills/tree/master/wire-presets/tree/main/skills/equity-valuation


## As of

Provenance: https://facet.finddatatech.cloud/api/skills-catalog · As of: 2026-11-05
