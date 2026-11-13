# Wire · Sentiment-Driven / 柏讯 · 舆情驱动

## What this is

柏讯舆情驱动三件套：把公告文本变成带原文引用、可核验、可追踪的观察维度——公告舆情审读（sentiment-document-review，逐篇打分必带引用与字符定位、多篇给分布而非平均情绪、服务拒答如实转述、低置信显式标注）、舆情转向追踪（sentiment-trend-watch，按公告发布日排布、转向点必须附对应文档、样本门槛单期 ≥3 篇且高置信 ≥2 篇、覆盖面与置信度固定两栏）、舆情与价格持仓的描述性对照（sentiment-signal-bridge，只陈述时间先后不断言因果、相关性陈述须 ≥12 对且走计算面、严禁给买卖建议与「信号」称谓）。与投研套件的分工：研报的催化剂章引用本套件分数，不重复打分（同一服务同一幂等键，重复调用命中缓存）；与策略工坊的分工：那边做信号与回测，本套件只做描述性对照不给信号。分数不预示价格、当前版本（gold-v10 / prompt v7）两轮复测置信桶单调递增、方向一致率 99.19%，但五档精档之间仍有相邻档误判，均如实标注。

Wire Sentiment, a three-skill set that turns announcement text into observable dimensions that carry verbatim quotes and can be verified and tracked — announcement sentiment review (sentiment-document-review: per-document scores must carry citations with character offsets, multiple documents yield a distribution rather than an average mood, service refusals are relayed as-is, low confidence is flagged explicitly), sentiment turn tracking (sentiment-trend-watch: scores laid out by announcement publication date, every turn point must cite its corresponding document, sample thresholds of ≥3 documents per period and ≥2 high-confidence, coverage and confidence as two fixed columns), and a descriptive comparison of sentiment against prices and holdings (sentiment-signal-bridge: states temporal order only and never asserts causality, correlation claims require ≥12 pairs and go through the compute plane, buy/sell advice and the word "signal" are strictly forbidden). Division of labor with the Equity Research suite: the report's catalysts section cites this suite's scores instead of re-scoring (same service, same idempotency key — repeat calls hit the cache); division of labor with the Strategy Lab: that side builds signals and backtests, this suite only does descriptive comparison and gives no signals. Scores do not predict prices; in the current version (gold-v10 / prompt v7) two rounds of re-testing show monotonically increasing confidence buckets and 99.19% directional agreement, yet adjacent-band confusion persists among the five fine bands — all stated as-is.

- Species: pack (plaza category enum v1)
- Official: yes — curated by FindData



## How to obtain

Three paths, all landing the same frozen version snapshot:

1. In 壹座 (Yizuo): open the market tab, search "Wire · Sentiment-Driven", subscribe and install.
2. In a CLI-capable editor (Claude Code, Cursor, Codex, Gemini CLI, ZCode):

       npx @finddatatechnology/facet install aMdkHzCbsc3fPsYiqMDUOA

3. From the market page: https://agent.finddatatech.cloud/#/packs

## What it contains

Skills (3):
- sentiment-document-review — 柏讯舆情驱动 · 公告舆情审读。当用户要求"看看这家公司最近的公告口径怎么样""给这几篇公告做个舆情判断""这些公告偏正面还是负面""公告里有什么值得注意的表述"时使用。取公告全文（巨潮面）→ 逐篇打分（fd-sentiment，分数必带原
- sentiment-trend-watch — 柏讯舆情驱动 · 舆情转向追踪。当用户要求"这家公司最近舆情是在变好还是变差""这段时间公告口径有没有转向""按月看公告情绪的分布变化""找出情绪转折点对应的公告"时使用。按公告发布日排布分数，给逐期分布与转向点（附对应文档），并强制报告覆
- sentiment-signal-bridge — 柏讯舆情驱动 · 舆情与价格/持仓的描述性对照。当用户要求"舆情和股价是什么关系""情绪是不是领先价格""看看公告情绪和我持仓的对应""舆情能不能当信号用"时使用。做的是描述性对照：把分数分布的时间位置与价格/持仓的时间位置并排放，说清先后

MCP server references (6): fd-sentiment, fd-cn-report, fd-paper-trading, fd-daas-mcp, fd-quant, wire-build-mcp

## As of

Provenance: https://facet.finddatatech.cloud · As of: 2026-11-05
