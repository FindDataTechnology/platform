# AI Company / AI 公司

## What this is

官方团队模板样板：CEO 巡视（{{fleetContext}} 注入）+ 三真数据岗（开源/投资）+ 助理引用岗 + 两连接器空态岗（电商/内容，演示待补岗降级）+ 萬星团队 a2a optional 成员（演示依赖缺位降级）。pack 自带 agents 上限 3（铸造实证），故助理为 existing-persona 引用岗；编导段为 supervisor 式 dispatch——CEO 可向各部门派活（显式 dispatch 边，非全舰 implicit）。铸造上架时 packId/占位符按铸造脚本补齐；本文件是清单真源，测试钉住其必须通过 fleet 段预校验。

Official team-template showcase: CEO patrol ({{fleetContext}} injected) + three real-data roles (open source / investment) + an assistant reference role + two connector empty-state roles (e-commerce / content, demonstrating pending-role degradation) + a Wanxing team a2a optional member (demonstrating missing-dependency degradation). The pack ships with an agents cap of 3 (forge-verified), so the assistant is an existing-persona reference role; the scripted section uses supervisor-style dispatch — the CEO can assign work to departments (explicit dispatch edges, not fleet-wide implicit). At forge-and-list time the packId and placeholders are completed by the forge script; this file is the manifest's source of truth, and tests pin that it must pass the fleet-section pre-validation.

- Species: pack (plaza category enum v1)
- Official: yes — curated by FindData



## How to obtain

Three paths, all landing the same frozen version snapshot:

1. In 壹座 (Yizuo): open the market tab, search "AI Company", subscribe and install.
2. In a CLI-capable editor (Claude Code, Cursor, Codex, Gemini CLI, ZCode):

       npx @finddatatechnology/facet install aofNf6o2LR61lPK8IVVkJw

3. From the market page: https://agent.finddatatech.cloud/#/packs

## What it contains

Skills (2):
- dept-patrol-report-framework — 公司式舰队各部门向 CEO 汇报的标准框架：数字先行、异常归因、裁决事项。
- escalation-decision-card — CEO 与各部门提交升级事项的标准格式：背景、事实、选项与代价、建议。

## As of

Provenance: https://facet.finddatatech.cloud · As of: 2026-11-05
