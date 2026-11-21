# Customer Support Crew / 客服班组

## What this is

官方团队模板：高频客服护航——客服组长每 4 小时带队巡检工单，一线客服处理、质检员抽检；组长对疑难工单用 escalate 合并上报（演示对抗每日防洪上限的上报纪律）与 CRM 客服工具面（凭据未配置时如实空转，不整体失败）。恰 3 岗满编无引用岗；编导段演示入站唤醒：event 边 bot:{{SERVICE_BOT}} 入站唤醒一线客服（客服 bot 为运营期配置的通道实例，缺位由运行期如实判定），一线 report 上行组长、组长可 dispatch 直接派单一线。铸造上架时 packId/agents/占位符按铸造脚本补齐；本文件是清单真源，测试钉住其必须通过 fleet 段预校验。

Official team template for high-volume support — the support lead sweeps the ticket queue with the team every 4 hours, front-line agents handle tickets, and the QA inspector spot-checks; tough tickets are batched up with escalate (demonstrating reporting discipline against the daily flood cap) on the CRM support tool surface (when credentials are unconfigured it idles truthfully instead of failing the whole run). Exactly 3 roles, fully staffed, no reference roles; the choreographed segment demonstrates inbound wake-up: the event edge bot:{{SERVICE_BOT}} wakes the front-line agent on inbound traffic (the support bot is a channel instance configured during operations; its absence is determined truthfully at runtime); the front line reports up to the lead, who can dispatch tickets directly back to the front line. When minted for listing, packId/agents/placeholders are completed by the minting script; this file is the true source of the manifest, and tests pin that it must pass the fleet-section pre-validation.

- Species: pack (plaza category enum v1)
- Official: yes — curated by FindData



## How to obtain

Three paths, all landing the same frozen version snapshot:

1. In 壹座 (Yizuo): open the market tab, search "Customer Support Crew", subscribe and install.
2. In a CLI-capable editor (Claude Code, Cursor, Codex, Gemini CLI, ZCode):

       npx @finddatatechnology/facet install EMGW14N8voa1b36LSuTxxw

3. From the market page: https://agent.finddatatech.cloud/#/packs

## What it contains

Skills (2):
- ticket-triage-five-steps — 一线客服处理工单的标准分诊流程：读原文、分类、排序、答复、升级。
- cs-reply-etiquette — 客服答复与升级件的标准措辞纪律：确认、方案、时限三段式与禁止项。

## As of

Provenance: https://facet.finddatatech.cloud · As of: 2026-11-05
