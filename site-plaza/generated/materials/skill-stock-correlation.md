# stock-correlation

## What this is

Analyze stock correlations to find related companies and trading pairs. Use when the user asks about correlated stocks, related companies, sector peers, trading pairs, or how two or more stocks move together. Triggers: "what correlates with NVDA", "find stocks related to AMD", "correlation between AAPL and MSFT", "what moves with", "sector peers", "pair trading", "correlated stocks", "when NVDA drops what else drops", "stocks that move together", "beta to", "relative performance", "supply chain partners", "correlation matrix", "co-movement", "related tickers", "sympathy plays", "semiconductor peers", "hedging pair", "realized correlation", "rolling correlation", or any request about stocks that move in tandem or inversely. Also triggers for well-known pairs like AMD/NVDA, GOOGL/AVGO, LITE/COHR. If only one ticker is provided, infer the user wants correlated peers.

- Species: skill (plaza category enum v1)
- Official: no



## How to obtain

1. In 壹座 (Yizuo): Extensions → Skills — subscribe from the skills face.
2. Inside editors: skills reach your editor bundled with a pack that references them — install that pack with:

       npx @finddatatechnology/facet install <packId>

3. Deployed agent services receive registry skills through the registry supply channel.
Source repository: https://gitee.com/FindDataTechnology/finddata-skills/tree/master/market-analysis/stock-correlation


## As of

Provenance: https://facet.finddatatech.cloud/api/skills-catalog · As of: 2026-11-05
