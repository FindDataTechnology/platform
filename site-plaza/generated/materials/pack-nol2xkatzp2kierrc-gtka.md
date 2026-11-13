# Wire · Adaptive Rotation Suite / 柏讯 · 自适应轮动套件

## What this is

自适应行业轮动：从市场状态判定（慢速趋势/回撤/波动率 Z + 快速冲击）到组强度排序（申万 L1 成分股合成的行业指数）、组内排序（残差动量 + 稳健 Z + 例外框架）、风险预算建仓（产出 TargetWeights 契约实例）与闭环运行（权重模式回测 + 模拟盘 + 快照解读）。对齐 FinRL-X 的七个策略模块，但输入已按 A 股适配：波动率用已实现波动率（QVIX/iVIX 在柏讯可及环境不可达），组用申万成分股合成（官方指数序列未采），参数按实测分位重标（原 Z≥3.0 → 采用 |Z|≥2.0，因实测 3.0 只占 0.47%）。价格走通道 B（本地 DAAS，需先播种 A 股），统计一律由 fd-quant 计算面产出。与「策略工坊」的分工：工坊给通用纪律（权重语义、回测解读、风控归属），本套件给**具体策略与参数**（选哪些组、组内选谁、预算怎么分）；督导不重复实现。终产物是可执行权重与运行记录，不是买入建议。

Adaptive industry rotation: from market-regime classification (slow trend/drawdown/volatility Z plus a fast shock check) to group-strength ranking (industry indices synthesized from SW Level-1 constituents), intra-group ranking (residual momentum + robust Z + an exception framework), risk-budgeted position building (emitting TargetWeights contract instances) and closed-loop operation (weight-mode backtests + paper trading + snapshot reading). Aligned with FinRL-X's seven strategy modules, but inputs are adapted to A-shares: volatility uses realized volatility (QVIX/iVIX are unreachable from Wire's reachable environment), groups are synthesized from SW constituents (official index series not sampled), and parameters are re-calibrated to measured quantiles (original Z≥3.0 → adopted |Z|≥2.0, since measured 3.0 covers only 0.47%). Prices go through channel B (local DAAS; A-shares must be seeded first); statistics are always produced by the fd-quant compute face. Division of labor with the strategy-lab suite: the lab provides general discipline (weight semantics, backtest interpretation, risk-control ownership), this suite provides the concrete strategy and parameters (which groups, which names within a group, how the budget splits); supervision does not re-implement. The end product is executable weights and run records, not buy advice.

- Species: pack (plaza category enum v1)
- Official: yes — curated by FindData



## How to obtain

Three paths, all landing the same frozen version snapshot:

1. In 壹座 (Yizuo): open the market tab, search "Wire · Adaptive Rotation Suite", subscribe and install.
2. In a CLI-capable editor (Claude Code, Cursor, Codex, Gemini CLI, ZCode):

       npx @finddatatechnology/facet install noL2XKaTZP2kiERrC_gtKA

3. From the market page: https://agent.finddatatech.cloud/#/packs

## What it contains

Skills (4):
- rotation-regime — 柏讯自适应轮动 · 市场状态判定（套件入口）。当用户要求判断当前 A 股市场处于进攻/中性/防守状态、要求给出轮动的择时前提、或问"现在该不该加仓/降仓"时使用。产出：带证据的 risk_on / neutral / risk_off 判定
- rotation-ranking — 柏讯自适应轮动 · 组与组内排序。当用户要求"哪些行业值得配""组内选哪几只""为什么这个组落选"时使用。组 = 申万 L1（31 类）成分股合成的行业指数；组强度用信息比排序，组内用残差动量 + 稳健 Z。产出：组排序表 + 组内排序表 
- rotation-portfolio — 柏讯自适应轮动 · 风险预算建仓与风控参数。当用户要求"按排序结果给个仓位方案""组之间怎么分配""止损怎么设"时使用。产出：TargetWeights 契约实例（组权重 → 资产权重）+ 风险预算依据 + 风控参数（并明确止损须在策略内表
- rotation-run — 柏讯自适应轮动 · 闭环运行与解读。当用户要"把这份权重跑一下""回测结果怎么看""模拟盘为什么没成交/权重为什么偏了"时使用。产出：权重模式回测结果（含成本与基准）+ 权重快照解读 + 偏离归因。终产物是可执行权重与运行记录，不是一段买入

MCP server references (5): fd-quant, fd-paper-trading, fd-daas-mcp, fd-cn-report, wire-build-mcp

## As of

Provenance: https://facet.finddatatech.cloud · As of: 2026-11-05
