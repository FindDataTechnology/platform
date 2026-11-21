# Infrastructure telemetry / 基础设施遥测

## What this is

只读遥测：GitOps 漂移、工作负载健康、服务存活、爬取汇总与成本，每项结果带数据时点。

Read-only telemetry: GitOps drift, workload health, service liveness, crawl summary, and cost, each with an as-of timestamp.

- Species: mcp (plaza category enum v1)
- Official: no
- Public tools: 5


## How to obtain

MCP servers are connected, not installed. The public endpoint:

    https://mcp.finddatatech.cloud/infra-telemetry/mcp

Connect it where your agent runs: in 壹座 (Extensions → MCP), or in any MCP-capable editor's config. The endpoint speaks the Model Context Protocol over streamable HTTP.

## As of

Provenance: https://facet.finddatatech.cloud/api/mcp-catalog · As of: 2026-11-05
