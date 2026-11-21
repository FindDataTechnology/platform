# Facet Market Assistant / 谦面市场助手

## What this is

用 AI 直接操作谦面市场与网关：浏览/检索功集与网关条目、发布新功集与新版本、上下架、切可见性、策展分类、发布前查重。装包即得 facet_market_* 与 facet_agent_* 十二个工具（凭据走壹座既有连接：registry + 谦面市场配对），配两份手册技能讲清『怎么写 manifest、怎么过发布门、怎么安全写操作』。

Operate the Facet market and gateway with AI directly: browse/search skills and gateway entries, publish new skills and versions, list/unlist, toggle visibility, curate categories, and publish ops — every write names its target and reads detail first.

- Species: pack (plaza category enum v1)
- Official: yes — curated by FindData



## How to obtain

Three paths, all landing the same frozen version snapshot:

1. In 壹座 (Yizuo): open the market tab, search "Facet Market Assistant", subscribe and install.
2. In a CLI-capable editor (Claude Code, Cursor, Codex, Gemini CLI, ZCode):

       npx @finddatatechnology/facet install 0RdQE184anPUaMhIvFwndA

3. From the market page: https://agent.finddatatech.cloud/#/packs

## What it contains

Skills (2):
- facet-market-publishing — 谦面功集发布实操手册：manifest 写法、校验门、工具声明门、配额与版本纪律，发布失败逐条排障。
- facet-gateway-ops — 谦面网关（registry）操作手册：AgentCard 目录浏览/登记/更新/启停/查重的安全用法与错误语义。

MCP server references (2): facet-market-mcp, facet-ops-mcp

## As of

Provenance: https://facet.finddatatech.cloud · As of: 2026-11-05
