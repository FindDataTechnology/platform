# Wire · Decision Review Suite / 柏讯 · 决策复盘套件

## What this is

把「当时的判定」变成可审计的历史：决策落账（追加式、幂等、修订留痕）→ 到期按基准结算真实 alpha → 提炼反思（只注入决策者，不广播）→ 持仓体检与最近判定的一致性核查。以账本为准，不美化历史；样本不足不下结论。与决策类 pack 的分工：决策 pack 产出 Rating/TargetWeights 实例，本套件负责统一落账与复盘（语义相同，不重复实现）。

Turns 'the call made at the time' into an auditable history: decision logging (append-only, idempotent, revisions leave traces) → settlement at expiry against a benchmark for realized alpha → distilled reflection (injected only into the decision-maker, never broadcast) → portfolio check-up and consistency check against the most recent calls. The ledger is the source of truth and history is never embellished; no conclusions on insufficient samples. Division of labor with decision packs: decision packs produce Rating/TargetWeights instances, this suite handles unified logging and review (same semantics, no duplicate implementation).

- Species: pack (plaza category enum v1)
- Official: yes — curated by FindData



## How to obtain

Three paths, all landing the same frozen version snapshot:

1. In 壹座 (Yizuo): open the market tab, search "Wire · Decision Review Suite", subscribe and install.
2. In a CLI-capable editor (Claude Code, Cursor, Codex, Gemini CLI, ZCode):

       npx @finddatatechnology/facet install wqpd5rPCFl3qIHg6oLDamg

3. From the market page: https://agent.finddatatech.cloud/#/packs

## What it contains

Skills (4):
- decision-review-log — 柏讯决策落账纪律（复盘套件入口）。当用户要求把一条判定（Rating）或目标权重（TargetWeights）记入决策账本、要求"再记一次"、要求修改或"更正"已落账的判定、或需要查回某标的的历史判定与教训时使用。账本是追加式的：幂等键 (
- decision-review-settlement — 柏讯到期结算复盘。当用户要求结算某条已落账的判定、想知道某判定"后来怎么样了"、要求汇总待结算记录、或要看原始收益与相对基准 alpha 时使用。流程为待结算汇总 → 取结算窗序列（价格走本地 DAAS 通道 B）→ 触发账本结算 → 三段
- decision-review-reflection — 柏讯决策反思提炼。当用户要求为一条已结算（或已落账）的判定写复盘反思、要求"总结这次教训"、或询问为什么反思不该出现在其他角色的输出里时使用。反思固定 2–4 句，针对决策本身而非市场走势，区分"判断错"与"运气差"，并含可执行的改进项；反
- decision-review-portfolio — 柏讯持仓体检。当用户要求体检当前模拟账户持仓、看集中度（HHI/前 N 权重）、期间回撤、行业暴露，或核查"持仓是否偏离了最近一次判定"时使用。持仓与账户取自柏讯模拟交易服务（paper-only，模拟盘，无真实资金），统计量一律交给 fd

MCP server references (5): fd-cn-report, fd-daas-mcp, fd-paper-trading, fd-quant, wire-build-mcp

## As of

Provenance: https://facet.finddatatech.cloud · As of: 2026-11-05
