# Wire · Paper Trading Suite / 柏讯 · 模拟交易套件

## What this is

柏讯模拟交易（paper trading）三件套：对话操作（账户/持仓/下单/撤单）、策略工作流（模板与沙箱自定义代码、回测解读、纸面实盘）、行情检查（搜索/历史K线/覆盖边界诚实呈现）。paper-only：模拟盘、无真实资金；调用者身份逐请求鉴别，只操作自己的账户；行情覆盖由部署的概念族决定，技能以诚实呈现覆盖边界为第一纪律。

Wire paper trading three-skill suite: conversational operations (accounts/positions/orders/cancellations), strategy workflow (templates and sandboxed custom code, backtest interpretation, paper-live runs) and market-data inspection (search/historical candlesticks/coverage boundaries stated honestly). Paper-only: simulated account, no real money; the caller's identity is authenticated per request and only their own accounts are touched; market-data coverage is set by the deployed concept families, and the skills' first discipline is to present coverage limits honestly.

- Species: pack (plaza category enum v1)
- Official: yes — curated by FindData



## How to obtain

Three paths, all landing the same frozen version snapshot:

1. In 壹座 (Yizuo): open the market tab, search "Wire · Paper Trading Suite", subscribe and install.
2. In a CLI-capable editor (Claude Code, Cursor, Codex, Gemini CLI, ZCode):

       npx @finddatatechnology/facet install DydB2cal-M9l91IMJYHshA

3. From the market page: https://agent.finddatatech.cloud/#/packs

## What it contains

Skills (3):
- paper-trading-conversation — 柏讯模拟交易（paper trading）对话操作。当用户要求查看纸面账户与余额、开新模拟账户、查持仓明细（数量/成本/浮盈亏）、下单买入或卖出（市价/限价）、撤单、查订单历史，或询问某标的当前价格时使用。走柏讯模拟交易服务（paper-o
- paper-trading-strategy — 柏讯模拟交易策略工作流。当用户要求创建量化策略（SMA 交叉/RSI 反转/布林突破/MACD 交叉/定投等模板，或自定义 on_bar 代码）、跑历史回测并解读权益曲线与统计（收益/回撤/夏普/胜率）、在模拟账户上启动或停止纸面实盘运行、
- paper-trading-market-inspection — 柏讯模拟交易行情检查。当用户要求搜索某个可交易标的（按代码或名称）、查看某标的的历史 K 线（OHLCV）、了解当前部署行情面覆盖哪些标的类型、或为下单/回测确认某标的数据是否可用时使用。行情来自柏讯模拟交易服务的行情面（概念族可配，默认基

MCP server references (2): fd-paper-trading, wire-build-mcp

## As of

Provenance: https://facet.finddatatech.cloud · As of: 2026-11-05
