# Wire · Industry & Corporate Suite / 柏讯 · 行业与企业套件

## What this is

行业景气与产业链传导 + 企业基本面与财务质量 + 面板计量方法：行业格局与上下游传导落到上市公司实证（GTA 面板 1,468 变量），企业端做杜邦分解与财务红旗项识别，计量侧支持固定效应、聚类稳健标准误与双重差分。

Industry cyclical conditions and chain transmission + corporate fundamentals and financial quality + panel econometrics: industry structure and upstream-downstream transmission grounded in listed-company evidence (GTA panel, 1,468 variables); DuPont decomposition and financial red-flag identification on the corporate side; fixed effects, cluster-robust standard errors and difference-in-differences on the econometrics side.

- Species: pack (plaza category enum v1)
- Official: yes — curated by FindData



## How to obtain

Three paths, all landing the same frozen version snapshot:

1. In 壹座 (Yizuo): open the market tab, search "Wire · Industry & Corporate Suite", subscribe and install.
2. In a CLI-capable editor (Claude Code, Cursor, Codex, Gemini CLI, ZCode):

       npx @finddatatechnology/facet install XozWSsRjsA8MxFPkHBJZbw

3. From the market page: https://agent.finddatatech.cloud/#/packs

## What it contains

Skills (3):
- industry-chain-analysis — 行业景气与产业链传导分析。当用户要判断一个行业处在景气周期的哪个位置、梳理上下游投入产出与成本价格传导路径、用上市公司财务面板实证行业判断、刻画行业格局（规模/增速/集中度/进入壁垒），或把研报观点与公司真实财务数据对照时使用。走柏讯服务端
- corporate-fundamental-analysis — 企业基本面与财务质量分析（柏讯线）。当用户要求给一家 A 股上市公司做三表速览、杜邦分解、现金流质量诊断、财务红旗项排查或同业分位对照时使用。走 GTA firm-year 财务面板 + 中国财报三表与附注，输出带来源与数据期数的可复核结论
- panel-econometrics — 面板数据计量分析。当用户要在"个体 × 时间"二维结构上做推断时使用——固定效应/随机效应与 Hausman 检验、聚类稳健标准误、动态面板（滞后因变量）、双重差分 DID 与平行趋势/事件研究检验、断点回归概念。面板取自柏讯服务端三类源：

MCP server references (5): fd-cn-report, fd-daas-mcp, fd-find-data-business-mcp, fd-open-data-mcp, wire-build-mcp

## As of

Provenance: https://facet.finddatatech.cloud · As of: 2026-11-05
