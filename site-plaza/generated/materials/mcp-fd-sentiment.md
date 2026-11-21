# Document sentiment scoring / 文档情绪打分

## What this is

对公告与新闻等文本做情绪强度与方向打分，支持批量任务与金标评测。

Score tone strength and direction in announcements and news, with batch jobs and gold-standard evaluation.

- Species: mcp (plaza category enum v1)
- Official: no
- Public tools: 10


## How to obtain

MCP servers are connected, not installed. The public endpoint:

    https://mcp.finddatatech.cloud/fd-sentiment/mcp

Connect it where your agent runs: in 壹座 (Extensions → MCP), or in any MCP-capable editor's config. The endpoint speaks the Model Context Protocol over streamable HTTP.

## As of

Provenance: https://facet.finddatatech.cloud/api/mcp-catalog · As of: 2026-11-05
