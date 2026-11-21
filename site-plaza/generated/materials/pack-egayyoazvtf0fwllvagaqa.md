# Baixun · Three-Lens Investment Research / 柏讯 · 投研三镜头

## What this is

三员投研团队：宏观分析（环境）、估值分析（价值）、投委会多空质询（博弈）三个独立镜头审读同一问题。团队任务下扇出聚合；单聊可切换任一角色。舆情/风控等更多角色可入动态团队叠加。

A three-role investment research team that examines one question through three independent lenses: macro analysis (the environment), valuation analysis (the value), and investment-committee bull-bear debate (the contest). Team tasks fan out across the lenses and aggregate the results; in a solo chat you can switch to any role. More roles, such as sentiment monitoring or risk control, can be layered into the dynamic team.

- Species: pack (plaza category enum v1)
- Official: yes — curated by FindData



## How to obtain

Three paths, all landing the same frozen version snapshot:

1. In 壹座 (Yizuo): open the market tab, search "Baixun · Three-Lens Investment Research", subscribe and install.
2. In a CLI-capable editor (Claude Code, Cursor, Codex, Gemini CLI, ZCode):

       npx @finddatatechnology/facet install egaYyOaZVTf0FWlLvaGAQA

3. From the market page: https://agent.finddatatech.cloud/#/packs

## What it contains

Skills (7):
- macro-cycle-analysis — 宏观周期与景气分析。当用户要求判断当前经济周期位置（复苏/过热/滞胀/衰退）、做六域景气扫描（增长/通胀/货币信用/财政/外贸/地产消费）、做领先-同步-滞后指标分层、识别景气拐点、梳理宏观变量到其业务问题的传导链，或做省际补充与国际对比时
- statistical-inference — 统计检验与探索性分析。当用户要求做描述统计与分布诊断、选假设检验（t/ANOVA/卡方/非参）、判断两组或城市间差异是否显著、做相关性与配对分析、诊断时序平稳性与单位根、做多重比较校正，或对已有的本地 CSV/表格做探索性分析时使用。走柏讯
- equity-valuation — 股票估值（DCF + 可比公司 + 三表联动）。当用户要求给某家 A 股/港股公司做内在价值或相对估值、算 WACC 与终值、跑敏感性与情景表、给目标价区间、做同业倍数对照与反推市场隐含预期时使用。财务数据走柏讯服务端通道 A，价格与市值走
- earnings-cycle-analysis — 财报周期分析（前瞻 + 复盘）。当用户要求对一家公司做财报前瞻（本次披露类型与时间、该盯哪些科目、超预期/低于预期可能从哪来）、做财报复盘（实际 vs 上年同期、差异由哪个科目驱动、盈利质量如何、对后续季度意味着什么），或梳理连续数期经营动
- ic-adjudication — 柏讯投委会 · 裁决（入口技能）。当用户要求"开投委会""对某只股票做一次多空辩论并给结论""裁决多头空头的分歧""把辩论结论落账"时使用。本技能是套件入口：调度 ic-bull-case 与 ic-bear-case 双方立论，然后按四条
- ic-bull-case — 柏讯投委会 · 多头立论。当用户要求对某只股票构建看多论证、写多头观点、准备投委会辩论的多方意见、把证据集收敛成"为什么该买"的最强论证，或作为 ic-adjudication 的立论阶段被调度时使用。本技能不取数、不计算、不裁决——数字只
- ic-bear-case — 柏讯投委会 · 空头立论（辩论三角色之一，与 ic-bull-case 完全对称）。当用户在投委会辩论流程中需要空头方论证、问「有什么理由不买」「多头论证哪里站不住」「估值凭什么下修」，或作为 ic-adjudication 的立论阶段被调

MCP server references (5): fd-cn-report, fd-daas-mcp, fd-quant, fd-find-data-business-mcp, fd-open-data-mcp

## As of

Provenance: https://facet.finddatatech.cloud · As of: 2026-11-05
