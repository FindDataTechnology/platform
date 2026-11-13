# Data · Indicator Workshop / 数据 · 指标工坊

## What this is

谦面指标工坊创作五件套：规则驱动实体集、指标持久化、指标集策展、统一规则（json/script/position/llm）与单文件 HTML 看板——把业务口径沉淀为可复用的数据资产

The five-piece Qianmian indicator-workshop creation suite: rule-driven entity sets, indicator persistence, indicator-set curation, unified rules (json/script/position/llm), and one-file HTML dashboards.

- Species: pack (plaza category enum v1)
- Official: yes — curated by FindData



## How to obtain

Three paths, all landing the same frozen version snapshot:

1. In 壹座 (Yizuo): open the market tab, search "Data · Indicator Workshop", subscribe and install.
2. In a CLI-capable editor (Claude Code, Cursor, Codex, Gemini CLI, ZCode):

       npx @finddatatechnology/facet install oGURb41bdyAotVGOeBHZUA

3. From the market page: https://agent.finddatatech.cloud/#/packs

## What it contains

Skills (5):
- fd-daas-entities-collection-creator — 创建规则驱动的实体集（自选股/组合）：声明式 JSON 规则，跨表/动态逻辑落 Python 规则脚本可重跑
- fd-daas-indicators-creator — 端到端建指标并持久化：扩展取数流程落 scraw_<slug> 存储表并把序列数据存进表（刷新为手动重跑）
- fd-daas-indicators-collection-creator — 策展指标集：把指标组成命名集合、按三级解析给出各成员 resolved score，导出机器可读 CSV + 人类可读简介
- fd-daas-rules-creator — 统一规则创作（json/script/position/llm 四型）：daas_create_rule 落库、daas_test_rule 试跑，可挂实体/指标集合并同步
- fd-daas-dashboard-creator — 把 daas 数据做成单文件独立 HTML 看板：ECharts + 实体/时间交互筛选，注册进 dashboards 表并迭代修改

MCP server references (1): fd-daas-mcp

## As of

Provenance: https://facet.finddatatech.cloud · As of: 2026-11-05
