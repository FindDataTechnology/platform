# Wire Intel & Sentiment / 情报舆情团队

## What this is

柏讯情报舆情团队模板：监视位→闸位双路并行→合成位交叉核对→产出位落看板草稿（trigger×3+handoff×3 编导）。装包后经壹座「团队→从模板实例化」建队；岗位纪律来自共用层四包（需同 cell 安装）：fleet-intel-gather/fleet-data-qa/fleet-brief-report/fleet-board-contribution。

Wire intel/sentiment fleet template: intel patrol + sentiment sentinel run in parallel, the chief cross-checks both and composes the morning brief, the contribution post lands a board draft. Install, then instantiate from the template; post discipline comes from the shared fleet packs (install in the same cell).

- Species: pack (plaza category enum v1)
- Official: yes — curated by FindData



## How to obtain

Three paths, all landing the same frozen version snapshot:

1. In 壹座 (Yizuo): open the market tab, search "Wire Intel & Sentiment", subscribe and install.
2. In a CLI-capable editor (Claude Code, Cursor, Codex, Gemini CLI, ZCode):

       npx @finddatatechnology/facet install IVCGxpg9itGnLpHxT1khWQ

3. From the market page: https://agent.finddatatech.cloud/#/packs

## What it contains

Skills (3):
- intel-item-five-elements — 情报条目五要素：原文标题、时间、来源、实体、可回溯 ID，缺一不立条。
- intel-source-health-triage — 源健康先行：stream_health 判红黄绿三档，坏源不硬取，失败按四分类上报。
- intel-sentiment-threshold-card — 情绪阈值卡：基线算法、窗宽、阈值来源与连续同向判据的可复核口径。

MCP server references (4): fd-info, wire-ops, wire-build-mcp, fd-sentiment

## As of

Provenance: https://facet.finddatatech.cloud · As of: 2026-11-05
