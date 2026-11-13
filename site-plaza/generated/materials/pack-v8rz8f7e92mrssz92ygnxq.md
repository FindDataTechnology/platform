# FindData Product Introduction / 壹座产品介绍

## What this is

对外产品介绍团队：前台「产品向导」+ 五条产品线专家（寻数·壹座/识律/柏讯/谦面/萬星），编导为前台→各专家的 dispatch 星型（会话型团队，无 cron 节奏——装上即等访客提问）。知识来源：www.finddatatech.cloud 官网中文页 /zh/（原始抓取，抓取日期 2026-10-30）与本仓公开 README（github.com/FindDataTechnology/platform）；官网改版时人工同步本种子并重跑守恒与红线测试。结构注：六岗全部自载（maxAgents 50，2026-10-30 用户裁决放宽，75df6914）——包自带完整团队，外来安装者零预创建、无降级路径。KPI 槽位：会话型团队无运营语义，不设（kpiSlots: []）。预校验兼容性结论（2026-10-30 实证）：无 cadence/显式 cadence:null 的岗位直接通过 parseFleetTemplate——design D2 的值守 cron 回退方案无需启用。本包声明 publicFacing=true（对外团队）：其岗位运行时只挂公开工具面（fleet 桥 + 市场公开面），禁用工作区文件工具与名册枚举工具——内部车道名不得进入访客可见的回答。红线：全部 persona 只含公开信息，词表 v4（智能体团队/小组/智能体/智能体市场），禁内部运营信息——scripts/test-product-intro-seed.mjs 以文本断言钉住。五线名以官网中文页原文为准（寻数·壹座/识律/柏讯/谦面/萬星）。

External-facing product-introduction team: one front-desk “Product Guide” plus five product-line specialists (FindData·Base / Lex / Wire / Facet / Constellation). Orchestration is a dispatch star from the guide to each specialist (a conversational team with no cron cadence — once installed it simply waits for visitor questions). Knowledge source: the official Chinese site www.finddatatech.cloud /zh/ (fetched verbatim on 2026-10-30) and the public README (github.com/FindDataTechnology/platform); when the site changes, sync this seed by hand and re-run the conservation and red-line tests. Structure note: all six posts are self-carried (maxAgents 50) — the pack ships the complete team, so an outside installer needs zero pre-creation and has no degraded path. KPI slots: a conversational team carries no operations semantics, so none are declared (kpiSlots: []). This pack declares publicFacing=true: at runtime its posts mount only the public tool surface (fleet bridge + public market), with workspace file tools and roster-enumeration tools disabled — internal lane names must never reach a visitor-visible answer. Red line: every persona contains public information only, uses vocabulary v4 (agent team / squad / agent / agent market), and never internal operations detail — pinned by text assertions in scripts/test-product-intro-seed.mjs. Product-line names follow the official Chinese site verbatim.

- Species: pack (plaza category enum v1)
- Official: yes — curated by FindData



## How to obtain

Three paths, all landing the same frozen version snapshot:

1. In 壹座 (Yizuo): open the market tab, search "FindData Product Introduction", subscribe and install.
2. In a CLI-capable editor (Claude Code, Cursor, Codex, Gemini CLI, ZCode):

       npx @finddatatechnology/facet install v8rZ8F7E92MrssZ92ygnXQ

3. From the market page: https://agent.finddatatech.cloud/#/packs

## What it contains

Skills (2):
- public-info-discipline — 对外介绍公开信息纪律：只官网与公开仓库口径，内部名零出现，不确定如实说。
- intro-triage-routing — 前台分诊路由卡：话题到专家的映射与转介话术。

## As of

Provenance: https://facet.finddatatech.cloud · As of: 2026-11-05
