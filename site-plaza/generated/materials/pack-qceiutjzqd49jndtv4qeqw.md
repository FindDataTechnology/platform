# Qianmian Assistant / 谦面助手

## What this is

在壹座中操作谦面的专用助手——浏览包目录、读详情、发布前校验、建包向导。只读工具 + 提议通道，所有写操作需经动作闸确认。

A dedicated assistant for operating Qianmian within Yizuo — browse the pack catalog, read details, run pre-publish validation, and use the pack-authoring wizard. Read-only tools plus a proposal channel: every write operation goes through the action gate for confirmation.

- Species: pack (plaza category enum v1)
- Official: yes — curated by FindData



## How to obtain

Three paths, all landing the same frozen version snapshot:

1. In 壹座 (Yizuo): open the market tab, search "Qianmian Assistant", subscribe and install.
2. In a CLI-capable editor (Claude Code, Cursor, Codex, Gemini CLI, ZCode):

       npx @finddatatechnology/facet install qCEIutJzQd49jnDtV4qeqw

3. From the market page: https://agent.finddatatech.cloud/#/packs

## What it contains

Skills (6):
- facet-browse-guidance — 指导用户如何使用 facet-market-mcp 的 browse/read 工具搜索包
- facet-validate-guidance — 指导用户如何使用 validate 进行发布前预检
- facet-concepts — 回答 facet 概念问题：pack 是什么、订阅与安装是两件事、版本快照语义
- facet-recommend — 按用户需求推荐 pack：先问诊再检索，指向市场条目
- facet-permissions — 解释 pack 的 MCP 引用与工具面（allowTools）披露口径
- facet-install-guidance — 两条安装路径引导：壹座一键订阅安装 / CLI 安装到 Claude Code / Cursor

MCP server references (2): facet-market-mcp, facet-ops-mcp

## As of

Provenance: https://facet.finddatatech.cloud · As of: 2026-11-05
