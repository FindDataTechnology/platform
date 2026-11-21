# Micro-Business · Core Checkup Suite / 生意体检 · 内核套件

## What this is

面向中国传统微型企业与个体户的经营体检内核：四段式工作流（问诊建档 → 单店算账 → 行业信号对照 → 行动清单）为入口技能，配套盈亏平衡、毛利结构、现金流账期三个计算器。所有金额与比率一律经计算器产出并附计算公式 + 输入基数 + 来源（来源名/地区/年份/口径时间），外部统计基数取不到时该项中止并明示「基数数据源未连接/未定码」，禁止用模型记忆的行业数字填充。未安装行业信号包时如实标注「未安装行业信号包」且不中断分析。单店生意档案可建立在 DAAS 实体模型上（一家店=一个实体，指标持久化 + 告警规则）。内核按小老板能听懂的标准书写，专业术语附日常解释；机构与政务渠道共用同一内核，仅外壳与推送方式不同。

Operating-checkup core for China's micro-enterprises and sole proprietors: a four-stage workflow (intake interview → single-store accounting → industry-signal comparison → action list) as the entry skill, with three companion calculators for break-even, gross-margin structure, and cash flow/payment terms. Every amount and ratio is produced by a calculator and carries its formula, input base, and source (source name/region/year/as-of date); when an external statistical base cannot be fetched, that item halts with an explicit 'base data source not connected/uncoded' notice, and filling gaps from the model's memory of industry figures is forbidden. When no industry signal pack is installed, this is honestly labeled and the analysis continues. Single-store business profiles can be persisted on the DAAS entity model (one store = one entity, with persistent indicators and alert rules). The core is written so small-business owners can understand it, with plain-language explanations for technical terms; institutional and government channels share the same core and differ only in shell and delivery.

- Species: pack (plaza category enum v1)
- Official: yes — curated by FindData



## How to obtain

Three paths, all landing the same frozen version snapshot:

1. In 壹座 (Yizuo): open the market tab, search "Micro-Business · Core Checkup Suite", subscribe and install.
2. In a CLI-capable editor (Claude Code, Cursor, Codex, Gemini CLI, ZCode):

       npx @finddatatechnology/facet install MBcXTHtyyMOxDHmSUYvDdQ

3. From the market page: https://agent.finddatatech.cloud/#/packs

## What it contains

Skills (4):
- mb-business-checkup — 生意体检（谦面·面向个体户与微型企业的内核入口技能）。当小老板描述自己的店（餐馆/便利店/花店/网店）、或代账、银行普惠客户经理、园区运营要为商户做经营诊断时使用。四段式：问诊建档 → 单店算账（点名盈亏平衡/毛利结构/现金流账期三计算器）
- mb-breakeven-calculator — 盈亏平衡计算器（谦面·面向个体户与微型企业的三个原子计算器之一）。当小老板或代账要算「一个月卖到多少才不亏」「每天要来多少客人/多少单才保本」「离保本线还有多远」「按现在的流水多少天能 cover 固定成本」时使用。产出月盈亏平衡流水、保本
- mb-margin-structure-calculator — 毛利结构计算器（谦面·面向个体户与微型企业的三个原子计算器之一）。当小老板或代账要算「毛利有多少」「哪块成本占得最重」「房租人工占流水几成」「涨价能多赚多少」时使用。产出固定/变动成本拆分、各项成本占流水比、毛利率与边际贡献率、成本结构诊断
- mb-cashflow-terms-calculator — 现金流与账期计算器（谦面·面向个体户与微型企业的三个原子计算器之一）。当小老板或代账要算「手里要留多少周转金」「什么时候会缺钱」「供应商账期和客户账期对不上怎么办」「旺季备货钱够不够」时使用。产出最少周转金、现金流缺口时段与金额、账期占款、

MCP server references (2): fd-find-data-business-mcp, fd-daas-mcp

## As of

Provenance: https://facet.finddatatech.cloud · As of: 2026-11-05
