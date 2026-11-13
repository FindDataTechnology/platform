# Wire · Event-Driven / 柏讯 · 事件驱动

## What this is

柏讯事件驱动四件套：事件识别（公告列表/分类/全文三路检索，六组事件类型映射，附公告标识与日期）、事件解读（读正文抽要素：金额/比例/期限/主体/生效条件，明确与需看条件二分，结论须引原文）、历史反应统计（多窗口收益分布 + 样本量 + 分位 + 必选的反例比例，明确是历史分布不是预测）、事件跟踪（按标的/类型筛选与统计，不含预测与推荐）。与柏讯舆情和投研套件的分工：舆情看文本倾向，投研做论点综合，本套件只处理结构化事件（公告/监管/业绩），不猜情绪也不给结论。核心纪律：不预测（不给涨跌预期、不说预计影响百分比）、正文支撑（标题与分类只是检索入口）、历史分布非预测（必须同时给反例比例）、预期已计入提示。公告是事实，解读是本套件的判断，两者分开呈现。不构成投资建议。

Wire event-driven four-skill set: event identification (three-way retrieval over announcement list / classification / full text, mapped into six event-type groups, each item with announcement id and date), event reading (read the body and extract elements — amount, ratio, horizon, party, effectiveness condition — split into explicit vs conditional, every conclusion citing the original text), historical reaction statistics (multi-window return distributions + sample size + quantiles + a mandatory counterexample ratio, explicitly a historical distribution, not a forecast), and event tracking (filter and tally by symbol or event type, no forecasts or recommendations). Division of labor with the Wire sentiment and equity research suites: sentiment reads text leaning, equity research synthesizes theses, this suite only handles structured events (announcements / regulatory / earnings) — it reads no mood and draws no conclusions. Core discipline: no prediction (no up/down expectations, no projected percentage impact), body-text support (title and category are only retrieval entries), historical distribution is not prediction (the counterexample ratio must accompany it), and the 'already priced in' reminder. Announcements are facts; the reading is this suite's judgment; the two are presented separately. Not investment advice.

- Species: pack (plaza category enum v1)
- Official: yes — curated by FindData



## How to obtain

Three paths, all landing the same frozen version snapshot:

1. In 壹座 (Yizuo): open the market tab, search "Wire · Event-Driven", subscribe and install.
2. In a CLI-capable editor (Claude Code, Cursor, Codex, Gemini CLI, ZCode):

       npx @finddatatechnology/facet install BX0qjZe26KJU-waLQNVS-A

3. From the market page: https://agent.finddatatech.cloud/#/packs

## What it contains

Skills (4):
- event-detection — 柏讯事件驱动 · 事件识别与分类。当用户要求"这家公司最近有什么公告/大事""近三个月事件梳理""哪些公司发了业绩预告""把公告按事件类型分一下"时使用。三路检索（公告列表 / 分类字典 / 全文检索），把公告归入六组事件类型（业绩类、融资
- event-reading — 柏讯事件驱动 · 事件解读。当用户要求"这条公告到底说了什么""这个定增/减持/业绩预告怎么看""把公告关键条款摘出来"时使用。读公告正文（get_filing），抽取金额、比例、期限、主体、生效条件五类要素，把结论分成"正文要素直接支撑（
- event-history — 柏讯事件驱动 · 历史反应统计。当用户要求"这类事件历史上发生后表现如何""业绩预增公告后 20 天一般怎么走""帮我看看这个事件类型的历史分布"时使用。对同类事件做多窗口（默认 5/10/20 个交易日）的历史反应统计：样本量、分位数、均
- event-watch — 柏讯事件驱动 · 事件跟踪。当用户要求"帮我盯住这几家公司""每天把公告按类型筛一遍""按标的或事件类型给我一张事件跟踪表"时使用。按标的与事件类型筛选公告流，输出事件清单、分类计数与期间对比（本周 vs 上周等），并明确标注检索口径与数据

MCP server references (4): fd-cn-report, fd-quant, fd-daas-mcp, wire-build-mcp

## As of

Provenance: https://facet.finddatatech.cloud · As of: 2026-11-05
