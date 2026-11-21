# Investment Research Morning Meeting / 投研晨会

## What this is

官方团队模板：三层级联的投研晨会——首席分析师汇总宏观/行业研究员晨报并拍板上行，风控官为被动岗（受委托或拍板批复唤醒）。演示：三层组织（{{fleetContext}} 只注入直接下级，中间层向上浓缩）、交易日节奏、escalate 驱动的被动岗；编导段为 trigger+handoff 级联（两研究员晨检完成接棒首席）与首席 dispatch 委托风控官。铸造上架时 packId/agents 按铸造脚本补齐；本文件是清单真源，测试钉住其必须通过 fleet 段预校验。

Official team template: a three-tier cascading investment-research morning meeting — the Chief Analyst consolidates the macro/sector researchers' morning briefs, makes the final call and reports up; the Risk Officer is a passive seat (awakened by delegation or by approval of an escalation). Demonstrates: three-tier organization ({{fleetContext}} injects only direct subordinates, the middle tier condenses upward), trading-day cadence, and escalate-driven passive seats; the scripted segments are the trigger+handoff cascade (the two researchers hand off to the Chief once their morning checks finish) and the Chief dispatching a delegation to the Risk Officer. When minted for listing, packId/agents are completed by the mint script; this file is the manifest source of truth, and tests pin that it must pass the fleet-section pre-validation.

- Species: pack (plaza category enum v1)
- Official: yes — curated by FindData



## How to obtain

Three paths, all landing the same frozen version snapshot:

1. In 壹座 (Yizuo): open the market tab, search "Investment Research Morning Meeting", subscribe and install.
2. In a CLI-capable editor (Claude Code, Cursor, Codex, Gemini CLI, ZCode):

       npx @finddatatechnology/facet install YMSt-hRNiNWXrlLYC8PSiA

3. From the market page: https://agent.finddatatech.cloud/#/packs

## What it contains

Skills (2):
- invest-view-card — 研究员与首席的标准观点格式：观点、证据、反方、置信度四件套。
- morning-note-template — 首席合成晨会产出的标准模板：共识、分歧、待拍板、观察清单。

MCP server references (2): fd-daas-mcp, fd-quant

## As of

Provenance: https://facet.finddatatech.cloud · As of: 2026-11-05
