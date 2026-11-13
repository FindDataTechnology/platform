# Wire · Portfolio Risk / 柏讯 · 组合风险

## What this is

柏讯组合风险四件套：风险预算（单票与板块上限 + 超限按比例重分配 + 迭代上限显式 + 未收敛如实报告，产出合规 TargetWeights）、回撤与波动体检（最大回撤起止/年化波动/HHI/前 N 占比/行业集中度/有效标的数 + 基准超额与跟踪误差，指标走计算面，体检不预测）、止损纪律（量级起点 -5%/-10%/20 日冷却 + 按标的波动重标 + 三处明示引擎不自动执行 + 触发检查只呈现状态不新增判断）、再平衡方案（逐标的差额/方向/股数 + 佣金印花税滑点分项成本 + 可送权重模式回测 + 不含择时）。与决策复盘套件的分工：复盘看现状（集中度/回撤/偏离），本套件定纪律（预算怎么分、止损怎么设、什么时候该动手），一静一动。与策略工坊的分工：工坊讲通用参数含义，本套件把纪律应用到用户的实际持仓上。paper-only：无真实资金；所有指标是历史与当前状态描述，不构成投资建议。

Wire Portfolio Risk, a four-skill set: risk budgeting (per-position and sector caps + proportional reallocation on breach + an explicit iteration cap + honest reporting when it fails to converge, producing a compliant TargetWeights instance), drawdown and volatility checkup (max drawdown start/end, annualized volatility, HHI, top-N weight, sector concentration, effective number of holdings, plus benchmark excess return and tracking error — indicators come from the compute plane and a checkup predicts nothing), stop-loss discipline (magnitude anchors -5%/-10% and a 20-day cooldown + volatility-based re-scaling per holding + three explicit statements that the engine never auto-executes + trigger checks that present status without adding judgments), and a rebalancing plan (per-holding delta / direction / share counts + itemized commission, stamp tax and slippage costs + a weight rule submittable to weight-mode backtest + no market timing). Division of labor with the Decision Review suite: review looks at the present state (concentration / drawdown / drift); this suite sets the discipline (how to split the budget, where stops go, when to act) — one static, one active. Division of labor with the Strategy Lab: the lab explains generic parameter meanings; this suite applies the discipline to the user's actual holdings. Paper-only: no real money; every indicator describes history and current state and does not constitute investment advice.

- Species: pack (plaza category enum v1)
- Official: yes — curated by FindData



## How to obtain

Three paths, all landing the same frozen version snapshot:

1. In 壹座 (Yizuo): open the market tab, search "Wire · Portfolio Risk", subscribe and install.
2. In a CLI-capable editor (Claude Code, Cursor, Codex, Gemini CLI, ZCode):

       npx @finddatatechnology/facet install mFYxWUfp5oHsPcpRDhxAhw

3. From the market page: https://agent.finddatatech.cloud/#/packs

## What it contains

Skills (4):
- portfolio-budget — 柏讯组合风险 · 风险预算。当用户要求"资金怎么分到这些标的/行业""单票最多放多少""按上限重新分配一遍"时使用。产出：一份**生成即合规**的 TargetWeights 契约实例（单票上限 + 板块上限 + 迭代重分配，迭代上限显式，
- portfolio-drawdown-review — 柏讯组合风险 · 回撤与波动体检。当用户要求"看看这个组合的回撤有多深""波动多大""是不是太集中了""和沪深300比怎么样"时使用。产出：组合级指标（最大回撤含峰谷日、年化波动、HHI、前 N 占比、板块集中度、有效标的数）+ 基准对比（
- portfolio-stop-discipline — 柏讯组合风险 · 止损纪律。当用户要求"止损设多少""移动止损怎么定""止损设了会自动执行吗""帮我看看哪些已经跌破线了"时使用。产出：一份用户既定的止损规则（绝对止损 / 移动止损 / 冷却期，含量级起点与按波动重标的方法与依据）+ 触发
- portfolio-rebalance-plan — 柏讯组合风险 · 再平衡方案。当用户要求"从现在的持仓调到这个目标权重，具体买什么卖什么""每只调多少股""调仓成本大概多少""这套再平衡规则历史上表现如何"时使用。产出：逐标的差额 / 方向 / 整数股数（向下取整，与权重模式引擎同口径）

MCP server references (4): fd-paper-trading, fd-quant, fd-daas-mcp, wire-build-mcp

## As of

Provenance: https://facet.finddatatech.cloud · As of: 2026-11-05
