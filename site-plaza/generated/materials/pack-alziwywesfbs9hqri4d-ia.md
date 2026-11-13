# Wire · Valuation Suite / 柏讯 · 估值套件

## What this is

股票估值与财报周期分析：DCF（五年预测 + WACC + 终值 + 敏感性表）+ 可比公司 + 三表联动三角验证；财报前瞻与复盘（科目定位与质量分析）。财务数据走柏讯服务端，股价与市值走本地数据平台通道。

Equity valuation and earnings-cycle analysis: DCF (five-year forecast + WACC + terminal value + sensitivity tables) + comparable companies + three-statement triangulation; earnings previews and post-earnings reviews (line-item localization and quality analysis). Financial data goes through the Wire server side; share prices and market caps go through the local data platform channel.

- Species: pack (plaza category enum v1)
- Official: yes — curated by FindData



## How to obtain

Three paths, all landing the same frozen version snapshot:

1. In 壹座 (Yizuo): open the market tab, search "Wire · Valuation Suite", subscribe and install.
2. In a CLI-capable editor (Claude Code, Cursor, Codex, Gemini CLI, ZCode):

       npx @finddatatechnology/facet install AlZiwYWeSfbs9hqRI4d-IA

3. From the market page: https://agent.finddatatech.cloud/#/packs

## What it contains

Skills (3):
- equity-valuation — 股票估值（DCF + 可比公司 + 三表联动）。当用户要求给某家 A 股/港股公司做内在价值或相对估值、算 WACC 与终值、跑敏感性与情景表、给目标价区间、做同业倍数对照与反推市场隐含预期时使用。财务数据走柏讯服务端通道 A，价格与市值走
- earnings-cycle-analysis — 财报周期分析（前瞻 + 复盘）。当用户要求对一家公司做财报前瞻（本次披露类型与时间、该盯哪些科目、超预期/低于预期可能从哪来）、做财报复盘（实际 vs 上年同期、差异由哪个科目驱动、盈利质量如何、对后续季度意味着什么），或梳理连续数期经营动
- stock-research-workflow — 个股研究全流程工作流（数据-股票包入口技能）。当用户询问一只股票（A股或美股）的投资价值、要求个股分析、财报解读、估值判断或多空辩论时使用。驱动从行情基本面到估值结论的完整研究流程，调用行情工具、数据 MCP 与研究技能。

MCP server references (5): fd-cn-report, fd-daas-mcp, fd-find-data-business-mcp, fd-open-data-mcp, wire-build-mcp

## As of

Provenance: https://facet.finddatatech.cloud · As of: 2026-11-05
