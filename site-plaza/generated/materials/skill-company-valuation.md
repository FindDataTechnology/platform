# company-valuation

## What this is

Estimate the intrinsic value of a public company using DCF, relative (peer multiple) and sum-of-parts (SOTP) methods, then triangulate to an implied share price with upside/downside versus the current market price. Use this skill whenever the user asks: "what is AAPL worth", "valuation of NVDA", "fair value of TSLA", "intrinsic value", "DCF for MSFT", "build a DCF", "discounted cash flow", "WACC", "terminal value", "implied share price", "upside to fair value", "is X overvalued/undervalued", "relative valuation", "peer comparison valuation", "EV/EBITDA target", "SOTP", "sum of the parts", "how much is [company] worth", "price target from fundamentals", "value this company", or any ticker in the context of computing intrinsic or relative valuation. Default to running ALL three methods (DCF + relative + SOTP-if-applicable) and presenting a blended implied price with a sensitivity table. Do not answer valuation questions from memory — always run the workflow.

- Species: skill (plaza category enum v1)
- Official: no



## How to obtain

1. In 壹座 (Yizuo): Extensions → Skills — subscribe from the skills face.
2. Inside editors: skills reach your editor bundled with a pack that references them — install that pack with:

       npx @finddatatechnology/facet install <packId>

3. Deployed agent services receive registry skills through the registry supply channel.
Source repository: https://gitee.com/FindDataTechnology/finddata-skills/tree/master/market-analysis/company-valuation


## As of

Provenance: https://facet.finddatatech.cloud/api/skills-catalog · As of: 2026-11-05
