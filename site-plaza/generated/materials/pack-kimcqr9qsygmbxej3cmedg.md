# Wire · Factor Selection / 柏讯 · 因子选股

## What this is

柏讯因子选股四件套：因子库与口径（52 因子九类清单、逐因子分子分母与报表期别、三个共线因子的剔除说明、数据可得性分档）、因子暴露与分层（走计算面，层数与极端值处理显式，IC 含 Pearson/Spearman，样本不足不作依据）、选股应用（多因子打分或条件筛选，产出候选 universe/目标权重，打分非预测）、无未来函数回测协议（财报用披露日而非报告期、universe 用当期成分、价格止于决策日、断言必须开启）。与自适应轮动套件的分工：轮动用价格类行业动量选组、本套件用基本面因子选股，两者可组合不重复；与个股投研套件的分工：那边做单只公司的深度报告，本套件做横截面的排序与筛选。因子值一律由计算面算出，不手算。回测为历史模拟，不构成投资建议。

Wire factor-selection four-skill suite: factor library and methodologies (a list of 52 factors in nine categories, with per-factor numerator, denominator, source statement and period, removal notes for three collinear factors, and data-availability tiers); factor exposure and quantile grouping (computed on the calculation surface, with explicit layer counts and outlier handling, IC incl. Pearson/Spearman, insufficient samples never used as a basis); stock-selection application (multi-factor scoring or conditional screening producing a candidate universe and target weights — scoring is not forecasting); and a no-look-ahead backtest protocol (financials dated by disclosure date, not reporting period; universe from current-period constituents; prices end at the decision date; assertions mandatory). Division of labor with the adaptive-rotation suite: rotation selects industry groups on price-based momentum, this suite selects stocks on fundamental factors — the two combine without overlap. With the single-stock research suite: that one produces in-depth reports on a single company, this one does cross-sectional ranking and screening. Factor values are always computed on the calculation surface, never by hand. Backtests are historical simulations and do not constitute investment advice.

- Species: pack (plaza category enum v1)
- Official: yes — curated by FindData



## How to obtain

Three paths, all landing the same frozen version snapshot:

1. In 壹座 (Yizuo): open the market tab, search "Wire · Factor Selection", subscribe and install.
2. In a CLI-capable editor (Claude Code, Cursor, Codex, Gemini CLI, ZCode):

       npx @finddatatechnology/facet install kimcQr9qSyGmbXej3CmeDg

3. From the market page: https://agent.finddatatech.cloud/#/packs

## What it contains

Skills (4):
- factor-library — 柏讯因子选股 · 因子库与口径。当用户问"有哪些基本面因子可用""这个因子怎么算""为什么这两个因子不能同时用""某个因子在 A 股跑不跑得动"时使用。收录 FinRL-X 的 52 个基本面因子（九类），逐因子给出分子、分母、所用报表、期
- factor-exposure — 柏讯因子选股 · 因子暴露与分层。当用户要求"算某只/某组标的的因子暴露""按因子分层看收益差""给我这个因子的 IC""这个因子在横截面上有没有区分度"时使用。暴露、分层、IC 与秩变换全部经 fd-quant 计算面完成，不在对话里手算
- factor-screening — 柏讯因子选股 · 选股应用。当用户要求"按这些因子筛一批股票""多因子打分选前 N 只""把因子结论变成可回测的持仓"时使用。把 factor-exposure 的暴露与 IC 结果变成候选 universe 与目标权重，权重或规则显式写出
- factor-backtest-protocol — 柏讯因子选股 · 无未来函数回测协议。当用户要把因子策略送进回测、要核对"这次回测有没有偷看未来"、要区分样本内与样本外、或要验某条未来数据会不会被拦住时使用。把四条点内纪律写成可核验的断言（财报按披露日、universe 用当期成分、价格

MCP server references (6): fd-quant, fd-cn-report, fd-find-data-business-mcp, fd-paper-trading, fd-daas-mcp, wire-build-mcp

## As of

Provenance: https://facet.finddatatech.cloud · As of: 2026-11-05
