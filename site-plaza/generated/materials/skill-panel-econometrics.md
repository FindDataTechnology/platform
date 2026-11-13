# panel-econometrics

## What this is

面板数据计量分析。当用户要在"个体 × 时间"二维结构上做推断时使用——固定效应/随机效应与 Hausman 检验、聚类稳健标准误、动态面板（滞后因变量）、双重差分 DID 与平行趋势/事件研究检验、断点回归概念。面板取自柏讯服务端三类源：GTA 上市公司（firm-year）、中国城市（city-year）、世界银行 WDI（country-year），宏观控制变量取柏讯宏观序列。不涉及股价与市值建模。

Panel data econometrics. Use when the user wants inference on a two-dimensional 'unit × time' structure — fixed/random effects with the Hausman test, cluster-robust standard errors, dynamic panels (lagged dependent variables), difference-in-differences DID with parallel-trends/event-study tests, and regression discontinuity concepts. Panels come from three 柏讯 server-side sources: GTA listed companies (firm-year), Chinese cities (city-year), and World Bank WDI (country-year); macro control variables come from 柏讯 macro series. Does not cover stock price or market-cap modeling.

- Species: skill (plaza category enum v1)
- Official: no



## How to obtain

1. In 壹座 (Yizuo): Extensions → Skills — subscribe from the skills face.
2. Inside editors: skills reach your editor bundled with a pack that references them — install that pack with:

       npx @finddatatechnology/facet install <packId>

3. Deployed agent services receive registry skills through the registry supply channel.
Source repository: https://gitee.com/FindDataTechnology/finddata-skills/tree/master/wire-presets/tree/main/skills/panel-econometrics


## As of

Provenance: https://facet.finddatatech.cloud/api/skills-catalog · As of: 2026-11-05
