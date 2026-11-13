# Micro-Business · Catering Signal Pack / 生意体检 · 餐饮信号包

## What this is

餐饮行业环境信号包（需与「生意体检 · 内核套件」叠加安装）：食材成本趋势（大连商品交易所期货：生猪/豆粕/玉米/棕榈油，餐饮最大变动成本项的趋势预警，不等于菜市场现货价）、商圈活跃度代理（专资办电影票房日榜/周榜，2017 起可回溯，反映商圈消费活跃度而非本店客流）、堂食外卖切换代理（中央气象台天气，34 省 2529 站时级，结构性提示而非客流预测），并可选查同业密度（工商登记区县 + 行业小类）。每个信号均标注代理性质与局限；信号源不可用时标注「未连接」且不填模型记忆值。工商类信号带批次年份与「历史格局、非实时」标注，且明示无注销/吊销口径、不做关店量。

Catering industry environmental signal pack (install alongside the Micro-Business · Core Checkup Suite): food-cost trend (Dalian Commodity Exchange futures — live hogs/soybean meal/corn/palm oil — trend warnings for catering's largest variable-cost item, not market spot prices), a commercial-district activity proxy (national film box office daily/weekly charts, traceable back to 2017; reflects district consumption activity, not your store's footfall), and a dine-in/delivery shift proxy (Central Meteorological Observatory weather, hourly across 34 provinces and 2,529 stations; a structural hint, not a footfall forecast), plus optional peer-density lookup (business registry at county + sub-industry granularity). Every signal is labeled with its proxy nature and its limits; when a source is unavailable it is marked 'not connected' and never filled with model-memory values. Registry-based signals carry their batch year with a 'historical snapshot, not real-time' label, and explicitly state that there is no deregistration/revocation scope and no closure counts.

- Species: pack (plaza category enum v1)
- Official: yes — curated by FindData



## How to obtain

Three paths, all landing the same frozen version snapshot:

1. In 壹座 (Yizuo): open the market tab, search "Micro-Business · Catering Signal Pack", subscribe and install.
2. In a CLI-capable editor (Claude Code, Cursor, Codex, Gemini CLI, ZCode):

       npx @finddatatechnology/facet install BniA5thfDdb3oG-FT0CkJA

3. From the market page: https://agent.finddatatech.cloud/#/packs

## What it contains

Skills (1):
- mb-signal-catering — 餐饮行业环境信号包（谦面·生意体检姊妹件，需与内核套件 mb-core 叠加安装）。读三类信号：食材成本趋势（大商所期货生猪/豆粕/玉米/棕榈油，餐饮最大变动成本项）、商圈活跃度代理（专资办电影票房日榜/周榜）、堂食外卖切换代理（中央气象台

MCP server references (2): fd-find-data-business-mcp, fd-open-data-mcp

## As of

Provenance: https://facet.finddatatech.cloud · As of: 2026-11-05
