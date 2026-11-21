# Wire · Data Governance / 柏讯 · 数据治理

## What this is

柏讯数据治理套件：读表单收上来的数据、改错一条记录、撤销改错、查改错历史、导出 CSV。写修正必须带来源标记（source）且不得代填；撤销只置回滚标记，原始行永不改写；导出带 truncated 字段，被行数闸截断时如实告知。失败原样转述，禁止以空列表冒充无数据。

Wire data governance suite: read the data collected through forms, correct one record, undo a correction, review correction history, and export CSV. Written corrections must carry a source marker (source) and never fill values on the user's behalf; undoing only sets a rollback marker and the original row is never rewritten; exports carry a truncated field, and truncation by the row cap is reported as-is rather than passed off as complete. Failures are relayed verbatim; an empty list must never pose as 'no data'.

- Species: pack (plaza category enum v1)
- Official: yes — curated by FindData



## How to obtain

Three paths, all landing the same frozen version snapshot:

1. In 壹座 (Yizuo): open the market tab, search "Wire · Data Governance", subscribe and install.
2. In a CLI-capable editor (Claude Code, Cursor, Codex, Gemini CLI, ZCode):

       npx @finddatatechnology/facet install 8edSwnv3lIXcuSAkzS9vvA

3. From the market page: https://agent.finddatatech.cloud/#/packs

## What it contains

Skills (1):
- wire-data-steward — 柏讯数据治理。当用户要读表单收上来的数据、改错一条记录、撤销一次改错、查改错历史或导出 CSV 时使用。写修正必须带来源标记（source），不得代填；撤销只置回滚标记、原始行永不改写；导出结果带 truncated 字段，true 表示被

MCP server references (1): wire-build-mcp

## As of

Provenance: https://facet.finddatatech.cloud · As of: 2026-11-05
