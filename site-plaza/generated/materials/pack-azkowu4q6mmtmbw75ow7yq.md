# Wire · Equity Research Suite / 柏讯 · 个股投研套件

## What this is

个股深度投研：从取数与口径、同行与竞争、财务建模、论点综合到 13 章报告装配的完整链条。五技能对齐 FinRobot 生产版 V2 的五个在跑角色（数据/分析/建模/综合/报告）。财务与披露走柏讯服务端通道 A，价格与市值走本地通道 B，估值与统计数字一律由 fd-quant 计算面产出（不自行计算）。与「估值套件」（单点估值）、「财务底盘」套件的分工：本套件是**全链报告**，估值套件是**单点深挖**，财务底盘是**通用财务分析**。方法分歧时点位可缺（null），评级必发。

Full-chain single-stock research: data acquisition and methodology, peers and competition, financial modeling, thesis synthesis, and 13-chapter report assembly. Five skills aligned with the five running roles of FinRobot production V2 (data / analysis / modeling / synthesis / report). Financials and disclosures go through the Wire server-side channel A, prices and market caps through the local channel B, and all valuation and statistical figures are produced by the fd-quant compute plane (never computed in-house). Division of labor with the Valuation suite (single-point valuation) and the Financial Foundation suite: this suite is the full-chain report, the Valuation suite is the single-point deep dive, and the Financial Foundation suite is general-purpose financial analysis. When methods disagree, point values may be missing (null) but a rating is always issued.

- Species: pack (plaza category enum v1)
- Official: yes — curated by FindData



## How to obtain

Three paths, all landing the same frozen version snapshot:

1. In 壹座 (Yizuo): open the market tab, search "Wire · Equity Research Suite", subscribe and install.
2. In a CLI-capable editor (Claude Code, Cursor, Codex, Gemini CLI, ZCode):

       npx @finddatatechnology/facet install azkOwU4q6mmTmbw75Ow7yQ

3. From the market page: https://agent.finddatatech.cloud/#/packs

## What it contains

Skills (5):
- equity-research-data — 个股投研的取数与口径纪律层。当用户要求为某家 A 股/港股公司取财务科目、公告披露、行业财务指标或公司面板变量，或需要交代某个数字的来源工具、数据期数、币种与单位时使用。财务与披露一律走柏讯服务端通道 A，价格与市值一律走本地 DAAS 通
- equity-research-peers — 个股投研的同业与竞争层。当用户要求为某家 A 股/港股公司挑可比公司、给同业规模与增速带对照、做可比性说明或跑倍数对照表时使用。候选池用 GTA 公司面板按规模带与增速带筛选（通道 A），价格类输入与倍数只走本地 DAAS（通道 B）；同业
- equity-research-modeling — 个股投研的估值建模与计算层。当用户要求给某家 A 股/港股公司做 DCF、DDM、可比倍数、Monte Carlo 或敏感性分析，或要求算基本面比率、跑红旗检测、把多种估值方法合成目标价时使用。全部算术一律调 fd-quant 确定性计算面
- equity-research-thesis — 个股论点综合与方向判定（Rating 契约实例）。当用户要求给某只股票下方向结论、写投资论点、列催化剂与风险、给目标价，或把取数/同行/建模三段结果收敛成一个可入决策账本的判定时使用。产出 side / conviction / price
- equity-research-report — 个股投研报告装配（本套件入口技能）。当用户要求"给某只股票出一份完整研究报告""写一份研报""跑一遍个股投研流程"时从这里进入。按固定 13 章装配报告、执行六项叙述审计自检、保留缺数据章并写明原因、末尾给数据期数汇总行。串起取数与口径、同

MCP server references (6): fd-cn-report, fd-daas-mcp, fd-find-data-business-mcp, fd-open-data-mcp, fd-quant, wire-build-mcp

## As of

Provenance: https://facet.finddatatech.cloud · As of: 2026-11-05
