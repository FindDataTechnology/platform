# Lex Statute Update / 法规追踪团队

## What this is

识律法规更新团队模板：监视位每日扫新颁/修订/废止（fd-legal-search-mcp 权威法规面，32,296 口径单一事实源）→合成位更新简报+生效影响标注（法条引用文号+条款定位可回查）→产出位落简报草稿；无更新日报空。装包后经壹座「团队→从模板实例化」建队；纪律来自共用层智能体（同 cell 装）：fleet-intel-gather/fleet-brief-report/fleet-board-contribution。

Lex statute-update cluster template: the monitor scans new/amended/repealed statutes daily (fd-legal-search-mcp authoritative statute face, 32,296 as the single source of truth), the synthesizer writes the update brief with effective-date impact notes (citation number + article locator, re-checkable), and the producer lands the brief draft; no updates means an empty daily report. Install, then instantiate from the template; discipline comes from the shared packs (same cell): fleet-intel-gather / fleet-brief-report / fleet-board-contribution.

- Species: pack (plaza category enum v1)
- Official: yes — curated by FindData



## How to obtain

Three paths, all landing the same frozen version snapshot:

1. In 壹座 (Yizuo): open the market tab, search "Lex Statute Update", subscribe and install.
2. In a CLI-capable editor (Claude Code, Cursor, Codex, Gemini CLI, ZCode):

       npx @finddatatechnology/facet install ZCot-b6HsnJRTTDKr_aunQ

3. From the market page: https://agent.finddatatech.cloud/#/packs

## What it contains

Skills (2):
- statute-scan-status-taxonomy — 新颁/修订/废止三分类机械判据：题名关键词+状态字段，判据可复核。
- statute-reference-resolution — 条级定位解析：law_reference 解析「某法第 N 条」到文号+law_id+条号，失败标不可解。

MCP server references (2): fd-legal-search-mcp, wire-build-mcp

## As of

Provenance: https://facet.finddatatech.cloud · As of: 2026-11-05
