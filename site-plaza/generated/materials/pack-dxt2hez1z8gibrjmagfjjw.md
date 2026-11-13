# Wire · Industry-Chain Linkage / 柏讯 · 产业链联动

## What this is

柏讯产业链联动四件套：链条映射（上中下游环节可多级、代表标的与归属依据、每环关键变量与来源、两档映射置信度）、传导验证（逐环相关性 + 时滞扫描 + 样本量与窗口，未验证环节明示不默认成立，不显著如实呈现，频度差处理，非因果表述）、环节受益分析（基于已验证的传导结论给候选，逐候选项回指传导依据，未验证环节不作依据，不预测价格）、链条景气跟踪（按环节分组的变量走势 + 来源与最新期数 + 缺口标注，无预测无建议）。与既有「行业链分析」技能的关系：那是分析技能，本套件是它的可安装套件化 + 可执行出口版本（从产业链关系走到可回测的权重），不是重复实现。核心纪律：产业链叙事最容易滑向讲漂亮故事——上游涨价到中游承压再下游提价听起来总是对的，但时滞、幅度与是否发生都必须有数据支撑；无数据的那一环明示未验证。传导结论是历史统计关系不是因果证明，不构成投资建议。

Wire industry-chain linkage four-skill suite: chain mapping (multi-level upstream/midstream/downstream segments with representative names and attribution rationale, key variables and sources per segment, and two mapping-confidence tiers); transmission verification (per-segment correlations + lag scans + sample sizes and windows; unverified segments are stated as such and never assumed to hold, insignificant results reported honestly, frequency mismatches handled explicitly, no causal wording); segment-beneficiary analysis (candidates based on verified transmission conclusions, each candidate pointing back to its transmission evidence, unverified segments never used as a basis, no price forecasting); and chain-conditions tracking (variable trends grouped by segment + sources and latest periods + gap flags; no forecasts, no advice). Relation to the existing industry-chain-analysis skill: that is the analysis skill, this suite is its installable, executable-outlet form (from industry-chain relations to backtestable weights), not a duplicate implementation. Core discipline: industry-chain narratives slide most easily into pretty storytelling — upstream price rises squeezing midstream margins before downstream price hikes always sound right, but lags, magnitudes and whether it happened at all must be data-backed; segments without data are declared unverified. Transmission conclusions are historical statistical relations, not causal proof, and do not constitute investment advice.

- Species: pack (plaza category enum v1)
- Official: yes — curated by FindData



## How to obtain

Three paths, all landing the same frozen version snapshot:

1. In 壹座 (Yizuo): open the market tab, search "Wire · Industry-Chain Linkage", subscribe and install.
2. In a CLI-capable editor (Claude Code, Cursor, Codex, Gemini CLI, ZCode):

       npx @finddatatechnology/facet install dxT2HEZ1z8GibrjMAgFJJw

3. From the market page: https://agent.finddatatech.cloud/#/packs

## What it contains

Skills (4):
- chain-mapping — 柏讯产业链联动 · 链条映射。当用户要求"把这个行业拆成上下游""这几家公司分别在产业链哪一环""这条链的结构和关键变量是什么"时使用。产出：环节结构（上/中/下游，可多级）+ 代表标的（逐家给可解释的归属依据）+ 每环关键变量与来源 + 
- chain-transmission — 柏讯产业链联动 · 传导验证。当用户说"上游涨价能不能传到中游毛利""这条链的滞后有多长""这个传导到底成不成立"时使用。产出：逐环传导检验表——每环给相关系数、时滞扫描、样本量与窗口；无数据的环节明示"未验证"，不显著的结果如实呈现，频度
- chain-beneficiary — 柏讯产业链联动 · 环节受益分析。当用户说"这条链里哪个环节该配""毛利承压环节选哪几只""把传导结论变成可回测的候选"时使用。产出：可执行候选 universe 与目标权重（可进权重模式回测），每个候选回指某条已验证的传导结论；未验证环节
- chain-watch — 柏讯产业链联动 · 链条景气跟踪。当用户要求"盯一下这条链最近怎么样""按环节给我看关键变量的最新走势""哪些数据好久没更新了"时使用。产出：按环节分组的变量走势表（来源 + 最新期数 + 缺口标注 + 变化方向），不含预测、不含建议。宿主

MCP server references (6): fd-find-data-business-mcp, fd-cn-report, fd-quant, fd-daas-mcp, fd-paper-trading, wire-build-mcp

## As of

Provenance: https://facet.finddatatech.cloud · As of: 2026-11-05
