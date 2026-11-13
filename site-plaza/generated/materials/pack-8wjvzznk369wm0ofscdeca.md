# Wanxing Fleet Ops / 萬星机群运营团队

## What this is

萬星团队运行面运营团队：监视位（fleets.db 只读直查，连续失败点名到 member）+归账位（wanxing 只读盘点，凭据缺位如实降级）+合成位（每日简报+治理提案）。治理写操作一律提案+拍板（allowTools 工具面级排除）。

Wanxing fleet-ops fleet: health patrol over fleets.db (read-only, names failing members), agent steward over the wanxing read face (degrades honestly without credentials), and an ops chief that composes the daily brief and escalates governance proposals.

- Species: pack (plaza category enum v1)
- Official: yes — curated by FindData



## How to obtain

Three paths, all landing the same frozen version snapshot:

1. In 壹座 (Yizuo): open the market tab, search "Wanxing Fleet Ops", subscribe and install.
2. In a CLI-capable editor (Claude Code, Cursor, Codex, Gemini CLI, ZCode):

       npx @finddatatechnology/facet install 8wJVZZnk369wm0oFScdecA

3. From the market page: https://agent.finddatatech.cloud/#/packs

## What it contains

Skills (2):
- fleet-readonly-db-patrol — fleets.db 只读巡检配方：表清单、成员态枚举、连续失败计数口径与 vacant 时长算法。
- fleet-governance-proposal-card — 治理提案卡：现象/证据/选项/影响面四栏，写面动作一律提案不自决。

MCP server references (1): wanxing-ops

## As of

Provenance: https://facet.finddatatech.cloud · As of: 2026-11-05
