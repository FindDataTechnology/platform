# Morning Intel Station / 晨报情报站

## What this is

官方团队模板：每日晨报情报站——科技与市场情报员每日清晨分头巡检，情报主编 8 点合成晨报；另含团队引用岗（existing-cluster，每周一做深度聚合，演示团队 fan-out 引用与派生报数）。演示：双情报源并行、晨报流、cluster 引用岗（公司种子只演示了 a2a）；编导段为 trigger+handoff 链（两情报员巡检完成接棒主编合成）与团队 report 上行。铸造上架时 packId/agents 按铸造脚本补齐；本文件是清单真源，测试钉住其必须通过 fleet 段预校验。

Official team template: the Daily Morning Intel Station — the tech and market intel agents each sweep their sources every morning, and the intel chief editor compiles the morning brief at 8:00; also includes a team reference role (existing-cluster, doing deep aggregation every Monday, demonstrating team fan-out references and derived reporting). Demos: dual intel sources in parallel, the morning-brief flow, and the cluster reference role (the company seed only demonstrated a2a); the orchestrated segment is a trigger+handoff chain (both agents finish their sweeps and hand off to the chief editor for synthesis) plus the team report upstream. When minting and publishing, packId/agents are filled in by the minting script; this file is the source of truth for the manifest, and tests pin that it must pass the fleet-section pre-validation.

- Species: pack (plaza category enum v1)
- Official: yes — curated by FindData



## How to obtain

Three paths, all landing the same frozen version snapshot:

1. In 壹座 (Yizuo): open the market tab, search "Morning Intel Station", subscribe and install.
2. In a CLI-capable editor (Claude Code, Cursor, Codex, Gemini CLI, ZCode):

       npx @finddatatechnology/facet install 56opYgliV9FYAmhmsDIJOw

3. From the market page: https://agent.finddatatech.cloud/#/packs

## What it contains

Skills (2):
- intel-item-five-elements — 情报员采集与初筛的标准格式：事实、信源、影响面、置信度、建议动作。
- brief-synthesis-template — 主编合成晨报的标准结构：头条、要点、风险预警、信源覆盖度。

MCP server references (1): fd-info

## As of

Provenance: https://facet.finddatatech.cloud · As of: 2026-11-05
