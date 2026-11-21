# Wire · IC Debate / 柏讯 · 投委会

## What this is

柏讯投委会三件套：把 TradingAgents/FinRobot 写好但未接线的公司层级辩论程序做成可安装的模式——多头立论（ic-bull-case，数字只能引用证据集 evidence_id、不自造不估算、不替对手立论、把己方理由说尽）、空头立论（ic-bear-case，对称规则 + 不扭曲多头已陈述证据）、裁决（ic-adjudication，入口技能：调度双方后按四纪律给出 Rating 契约实例——冲突不给 hold 须指强弱、证据不足给 review 不降级、裁决不引用任何数字、change_my_mind 必填），并落账至决策账本（结论可被 P5 结算——这是上游两家都缺失的闭环）。诚实定位：单 agent 分角色形态，三个角色由同一模型扮演，不构成独立视角；升级形态（萬星 A2A 三 persona 串行委派，深度 3 / 并发 1 / 分钟计费）已写入技能文本属产品演进。辩论不宣称提高预测准确率，是否更准由账本结算回答。裁决为研究参考，不构成投资建议。

Wire IC Debate, a three-skill set: it turns the company-level debate procedure that TradingAgents/FinRobot spell out but never wire up into an installable pattern — a bull case (ic-bull-case: numbers may only cite evidence-set evidence_id, nothing self-invented or estimated, no arguing the opponent's side, your own case argued to its full extent), a bear case (ic-bear-case: symmetric rules, plus never distorting evidence the bull side has already stated), and an adjudication (ic-adjudication, the entry skill: after dispatching both sides it issues a Rating contract instance under four disciplines — a conflict never yields hold without stating which side is stronger and why, insufficient evidence yields review rather than a downgraded verdict, the verdict cites no numbers, change_my_mind is mandatory) — and then records the outcome to the decision ledger (conclusions can be settled by P5: the closed loop both upstream projects lack). Honest positioning: single-agent role-split form; the three roles are played by one model and are not independent perspectives; the upgrade path (Wanxing A2A serial delegation across three personas, depth 3 / concurrency 1 / per-minute billing) is written into the skill text as product evolution. The debate claims no gain in forecast accuracy — whether it is more accurate is answered by ledger settlement. Verdicts are research reference, not investment advice.

- Species: pack (plaza category enum v1)
- Official: yes — curated by FindData



## How to obtain

Three paths, all landing the same frozen version snapshot:

1. In 壹座 (Yizuo): open the market tab, search "Wire · IC Debate", subscribe and install.
2. In a CLI-capable editor (Claude Code, Cursor, Codex, Gemini CLI, ZCode):

       npx @finddatatechnology/facet install I5n-sRpbXuFu6WLbh6PfvQ

3. From the market page: https://agent.finddatatech.cloud/#/packs

## What it contains

Skills (3):
- ic-adjudication — 柏讯投委会 · 裁决（入口技能）。当用户要求"开投委会""对某只股票做一次多空辩论并给结论""裁决多头空头的分歧""把辩论结论落账"时使用。本技能是套件入口：调度 ic-bull-case 与 ic-bear-case 双方立论，然后按四条
- ic-bull-case — 柏讯投委会 · 多头立论。当用户要求对某只股票构建看多论证、写多头观点、准备投委会辩论的多方意见、把证据集收敛成"为什么该买"的最强论证，或作为 ic-adjudication 的立论阶段被调度时使用。本技能不取数、不计算、不裁决——数字只
- ic-bear-case — 柏讯投委会 · 空头立论（辩论三角色之一，与 ic-bull-case 完全对称）。当用户在投委会辩论流程中需要空头方论证、问「有什么理由不买」「多头论证哪里站不住」「估值凭什么下修」，或作为 ic-adjudication 的立论阶段被调

MCP server references (4): fd-cn-report, fd-daas-mcp, fd-quant, wire-build-mcp

## As of

Provenance: https://facet.finddatatech.cloud · As of: 2026-11-05
