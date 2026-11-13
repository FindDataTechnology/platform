# Wire · Expectation Gap / 柏讯 · 预期差

## What this is

柏讯预期差四件套：互动问答提取（info-stream 的 sse-interaction 条目结构化为「投资者问题 + 公司答复」，逐条带 item_id、逐字片段与正文状态分流）、预期线索解读（指引/确认/否认/回避/措辞变化五类线索，每条带可回原文的证据，措辞变化须双条并排，线索是公司口径不是事实）、与业绩预告对照（T_qa vs T_pre vs T_act 三段时间轴逐报告期对照，数值算术只走 fd-quant 计算面，预告区间三口径并列）、缺口陈述（已验证/未验证/不可评三档合成，每条带证据链与样本量，缺样本标注「不作依据」）。覆盖边界（上游实调 2026-10-23）：上证 e 互动可用、深交所互动易上游不可用（旧 API 405、新版面 SPA 化），本套件覆盖=SSE 上市公司，深市公司不在能力内，每次输出必须声明该缺口。核心纪律：引用任何问答前先查来源健康度；禁止模型记忆补问答；结论带样本量与时间窗；不评分、不排序、不推荐、不预测。与 info-shock 套件的分工：那边做信息条目的价格影响窗口，本套件只做公司口径与自身披露的对照，不涉及价格。不构成投资建议。

Wire Expectation Gap four-skill set: interactive Q&A extraction (structures info-stream sse-interaction items into 'investor question + company answer' pairs, each with item_id, verbatim quotes and body-status triage), expectation-clue reading (five clue classes — guidance / confirmation / denial / evasion / wording change — each backed by evidence traceable to the original text; wording changes always shown as a side-by-side pair; a clue is company positioning, not fact), preannouncement cross-check (a three-segment timeline per report period — Q&A date vs preannouncement/express report vs actuals; all arithmetic goes through the fd-quant compute face; preannouncement ranges shown as lower/upper/mid), and gap statement (synthesis in three tiers — verified / unverified / not assessable — each statement with an evidence chain and sample size; missing samples are marked 'not to be relied on'). Coverage boundary (upstream live probe 2026-10-23): SSE e-interaction is available; the SZSE interaction platform is unreachable upstream (legacy API 405, new portal SPA-walled), so coverage = SSE-listed companies only, SZSE names are out of scope, and every output must state this gap. Core discipline: check source health before citing any Q&A; never fill Q&A from model memory; conclusions carry sample size and time window; no scoring, no ranking, no recommendations, no forecasts. Division of labor with the info-shock suite: that one handles price-impact windows of information items, this one only contrasts company positioning against the company's own disclosures and touches no prices. Not investment advice.

- Species: pack (plaza category enum v1)
- Official: yes — curated by FindData



## How to obtain

Three paths, all landing the same frozen version snapshot:

1. In 壹座 (Yizuo): open the market tab, search "Wire · Expectation Gap", subscribe and install.
2. In a CLI-capable editor (Claude Code, Cursor, Codex, Gemini CLI, ZCode):

       npx @finddatatechnology/facet install DNYnRrjjAWINzqR_ArmbjQ

3. From the market page: https://agent.finddatatech.cloud/#/packs

## What it contains

Skills (4):
- gap-qa-extraction — 柏讯预期差 · 互动问答提取。当用户要求"这家公司在互动平台上被问了什么、怎么答的""把某段时间的投资者问答整理出来""公司在 e 互动上说过什么"时使用。从 info-stream 拉 source=sse-interaction 的条目
- gap-signal-reading — 柏讯预期差 · 预期线索解读。当用户要求"公司答复里有没有业绩指引""口径跟以前比变没变""哪些问题公司在回避""公司在互动平台上确认过什么"时使用。从互动问答的公司答复中抽取五类预期线索：指引类（业绩/订单/产能/时间表）、确认、否认、回
- gap-forecast-check — 柏讯预期差 · 与业绩预告对照。当用户要求"公司在互动平台的说法和后来的业绩预告对得上吗""问答是在预告前还是预告后""公司答复口径与实际业绩差多少"时使用。把问答时间点放到披露时间轴上：问答发布日 vs 业绩预告/快报披露日 vs 实际值
- gap-statement — 柏讯预期差 · 缺口陈述。当用户要求"这家公司的预期差结论""问答口径和业绩对得上一句话怎么说""给一份预期差摘要"时使用。把前三技能的产出（问答清单、线索表、对照表）合成为限定性预期差陈述：每条陈述必须同时带证据链（问答 item_id 

MCP server references (4): fd-info, fd-cn-report, fd-quant, wire-build-mcp

## As of

Provenance: https://facet.finddatatech.cloud · As of: 2026-11-05
