# Wire · Strategy Lab / 柏讯 · 策略工坊

## What this is

柏讯策略工坊四件套：策略设计（权重语义与 universe 验证）、回测解读（五条要求与三条禁止项）、风控参数（含义/量级/局限）、模拟盘督导（运行事件/权重快照/数据缺口）。与柏讯模拟交易套件的分工：那边是操作面——开账户、下单、撤单、订单历史，由对话操作技能承接；本套件是思考面——想清楚权重怎么定、回测结果怎么读、风控参数意味着什么，一切成交仍走模拟交易服务。paper-only：无真实资金；回测与模拟盘不预示未来。

Wire Strategy Lab, a four-skill set: strategy design (weight semantics and universe validation), backtest interpretation (five requirements and three prohibitions), risk-control parameters (meaning / magnitude / limitations), and paper-run supervision (run events / weight snapshots / data gaps). Division of labor with the Wire Paper Trading suite: that one is the operations plane — open accounts, place orders, cancel orders, order history, handled by conversational operation skills; this suite is the thinking plane — getting clear on how weights should be set, how to read backtest results, what risk parameters mean; every fill still goes through the paper trading service. Paper-only: no real money; backtests and paper runs do not foreshadow the future.

- Species: pack (plaza category enum v1)
- Official: yes — curated by FindData



## How to obtain

Three paths, all landing the same frozen version snapshot:

1. In 壹座 (Yizuo): open the market tab, search "Wire · Strategy Lab", subscribe and install.
2. In a CLI-capable editor (Claude Code, Cursor, Codex, Gemini CLI, ZCode):

       npx @finddatatechnology/facet install _FN7pti9TH5JMg3YnQut0w

3. From the market page: https://agent.finddatatech.cloud/#/packs

## What it contains

Skills (4):
- strategy-design — 柏讯策略工坊 · 策略设计。当用户想把一个投资想法变成可回测的多标的策略（universe + 目标权重 + 调仓频率）、想理解权重语义（和为 1、非负、余量现金）、想取舍调仓频率与换手、或想知道哪些表达不被支持（做空/杠杆/盘中调仓）时使
- strategy-backtest-interpretation — 柏讯策略工坊 · 回测解读。当用户拿到一份回测结果（尤其 walk-forward 分窗、开启成本模型、带基准对比、参数扫描）想知道"这个数字说明什么"、要求解读权益曲线与统计、或问"这能当作未来收益预期吗"时使用。核心纪律：历史模拟不预示
- strategy-risk-controls — 柏讯策略工坊 · 风控参数。当用户问"单票最多买多少""止损设多少""换手太高怎么办""设了会自动执行吗"——即想理解单票上限/集中度/换手/止损/冷却期这些风控参数的含义、量级参考、代价与局限时使用。核心纪律：风控参数是策略层参数，不是引
- strategy-paper-supervision — 柏讯策略工坊 · 模拟盘督导。当用户已启动权重模式的纸面实盘（paper run），想知道"为什么没下单""权重怎么和目标对不上""缩量是什么意思""停了会平仓吗"、需要查看运行事件与权重快照、或要区分信号未触发与数据缺口时使用。

MCP server references (3): fd-paper-trading, fd-quant, wire-build-mcp

## As of

Provenance: https://facet.finddatatech.cloud · As of: 2026-11-05
