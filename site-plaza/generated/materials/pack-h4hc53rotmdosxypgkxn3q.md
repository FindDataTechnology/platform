# Cross-border Logistics Watch / 跨境电商物流值守团队

## What this is

跨境电商物流值守团队模板：值守岗读 fd-open-data-mcp 口岸观测（port.calls 当日快照，四枢纽港逐港报水位）→合成位按三判据出物流日报（超阈/断更/政策面冲突 escalate）→产出位落看板草稿。装包后经壹座「团队→从模板实例化」建队；岗位纪律来自共用层三包+值守岗包 crossborder-watch-roles（同 cell 安装）。边界：政策公告面归政策盯梢舰，本舰只管口岸水位。

Cross-border logistics watch cluster template: the monitor reads port observations via fd-open-data-mcp (port.calls daily snapshot, four hub ports reported port by port), the synthesizer builds the daily logistics brief on three criteria (threshold breach / feed freeze / policy-side conflict escalates), the producer lands the board draft. Install, then instantiate from the template; discipline comes from the shared packs plus crossborder-watch-roles (same cell). Boundary: policy notices belong to the policy watch cluster.

- Species: pack (plaza category enum v1)
- Official: yes — curated by FindData



## How to obtain

Three paths, all landing the same frozen version snapshot:

1. In 壹座 (Yizuo): open the market tab, search "Cross-border Logistics Watch", subscribe and install.
2. In a CLI-capable editor (Claude Code, Cursor, Codex, Gemini CLI, ZCode):

       npx @finddatatechnology/facet install h4Hc53roTMdoSxyPgKXN3Q

3. From the market page: https://agent.finddatatech.cloud/#/packs

## What it contains

Skills (1):
- xb-port-call-pressure-reading — 口岸水位读数纪律：port.calls 当日快照不回填，缺港按 series_state 双态归因，拥堵与吞吐分列不混算。

MCP server references (3): fd-open-data-mcp, wire-ops, wire-build-mcp

## As of

Provenance: https://facet.finddatatech.cloud · As of: 2026-11-05
