# Paper trading / 模拟交易

## What this is

纸面交易的账户、下单与持仓，配行情读取与策略回放，不涉及真实资金。

Accounts, orders, and positions on paper, with market reads and strategy replay; no real money involved.

- Species: mcp (plaza category enum v1)
- Official: no
- Public tools: 19


## How to obtain

MCP servers are connected, not installed. The public endpoint:

    https://mcp.finddatatech.cloud/fd-paper-trading/mcp

Connect it where your agent runs: in 壹座 (Extensions → MCP), or in any MCP-capable editor's config. The endpoint speaks the Model Context Protocol over streamable HTTP.

## As of

Provenance: https://facet.finddatatech.cloud/api/mcp-catalog · As of: 2026-11-05
