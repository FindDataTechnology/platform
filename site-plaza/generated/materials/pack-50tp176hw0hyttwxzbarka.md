# Data · Self-serve Analytics / 数据 · 自助分析

## What this is

谦面自助分析消费八件套：取数（工作流清单/AkShare）、实体与集合管理、指标查询、看板检视、PDF 语义检索、头脑风暴与一键研究——业务人自助完成数据消费全流程

The eight-piece Qianmian self-serve analytics consumption suite: data fetch (workflow playbooks / AkShare), entity and collection management, indicator queries, dashboard inspection, PDF semantic retrieval, research pipeline, brainstorm-to-plan, and rule creation.

- Species: pack (plaza category enum v1)
- Official: yes — curated by FindData



## How to obtain

Three paths, all landing the same frozen version snapshot:

1. In 壹座 (Yizuo): open the market tab, search "Data · Self-serve Analytics", subscribe and install.
2. In a CLI-capable editor (Claude Code, Cursor, Codex, Gemini CLI, ZCode):

       npx @finddatatechnology/facet install 50Tp176hW0HYTTWXZbarKA

3. From the market page: https://agent.finddatatech.cloud/#/packs

## What it contains

Skills (8):
- fd-daas-based-data-fetch — 按 data-fetch 工作流清单取数：经 fd-open-data-mcp 解析实体并按日期读概念值，返回数据行与来源标识，可选落库
- fd-daas-fetch-data — 在 daas 注册表查实体、定位覆盖它的数据源，并在源数据上定义指标（daas_* 工具 + indicators 工作流清单）
- fd-datasource-akshare — 用 scraw-akshare 抓 A 股行情与财务数据：全部 spider 命令、CLI 参数、库表结构与已知坑位速查，跑任何抓取前先读它
- fd-daas-research — 跑完整研究管线（实体→指标→看板→报告）：经 research 工作流清单检索概念、落研究包并生成 markdown 报告
- fd-daas-brainstorm — 研究目标头脑风暴：把模糊想法聊成具体研究计划（可锚定名家投资方法论），只产出计划再交棒研究管线
- fd-daas-dashboard — 查找/打开/检视既有独立 HTML 看板：列出、按关键词搜索、看简介与数据血缘、浏览器打开并查询底层数据（只读）
- fd-daas-pdf — PDF/文本本地向量化与语义检索：抽取分块、sentence-transformers 嵌入存 daas.db，KNN 问答带文档页码引用，不出网
- fd-daas-entities-collection — 实体与实体集日常管理：发现实体、集合增删改查、成员增删排序、审计历史与规则集合同步（不含新建规则）

MCP server references (1): fd-daas-mcp

## As of

Provenance: https://facet.finddatatech.cloud · As of: 2026-11-05
