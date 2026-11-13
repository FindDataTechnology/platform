# Health config / 健康巡检配置

## What this is

读取中央库健康巡检的总闸与限流配置，只读。

Read the central health-check master switch and rate-limit configuration; read-only.

- Species: mcp (plaza category enum v1)
- Official: no
- Public tools: 1


## How to obtain

MCP servers are connected, not installed. The public endpoint:

    https://mcp.finddatatech.cloud/fd-health-config/mcp

Connect it where your agent runs: in 壹座 (Extensions → MCP), or in any MCP-capable editor's config. The endpoint speaks the Model Context Protocol over streamable HTTP.

## As of

Provenance: https://facet.finddatatech.cloud/api/mcp-catalog · As of: 2026-11-05
