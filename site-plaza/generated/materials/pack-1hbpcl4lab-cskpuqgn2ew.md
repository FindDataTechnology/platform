# Lex Zhengxin Watch / 识律政心监测团队

## What this is

识律政心监测团队模板：监视位分域巡检 V-Dem/MARPOR 真库（fd-zhengxin-reference 读面）→合成位周报交叉核对（重大异动 escalate）→产出位落图集草稿。装包后经壹座「团队→从模板实例化」建队；岗位纪律来自共用层智能体（需同 cell 安装）：fleet-data-qa/fleet-brief-report/fleet-board-contribution。

Lex Zhengxin watch cluster template: the monitor patrols the real V-Dem/MARPOR libraries by domain (fd-zhengxin-reference read face), the synthesizer cross-checks the weekly report (major shifts escalate), and the producer lands the atlas draft. Install, then instantiate from the template; discipline comes from the shared packs (same cell): fleet-data-qa / fleet-brief-report / fleet-board-contribution.

- Species: pack (plaza category enum v1)
- Official: yes — curated by FindData



## How to obtain

Three paths, all landing the same frozen version snapshot:

1. In 壹座 (Yizuo): open the market tab, search "Lex Zhengxin Watch", subscribe and install.
2. In a CLI-capable editor (Claude Code, Cursor, Codex, Gemini CLI, ZCode):

       npx @finddatatechnology/facet install 1HbpcL4LaB-csKpUQgN2Ew

3. From the market page: https://agent.finddatatech.cloud/#/packs

## What it contains

Skills (2):
- zx-source-readiness-gate — 六源就绪门：source_status 判就绪/延迟/未就绪三档，未就绪整源跳过并如实记录。
- zx-timeseries-anomaly-card — 异动卡五栏：国家/指标/年份对/差值/快照版本，阈值来源必须可复核。

MCP server references (2): fd-zhengxin-reference, wire-build-mcp

## As of

Provenance: https://facet.finddatatech.cloud · As of: 2026-11-05
