# Micro-Business · Retail Signal Pack / 生意体检 · 零售信号包

## What this is

零售行业环境信号包（需与「生意体检 · 内核套件」叠加安装）：批发价参考（昆明国际花卉拍卖中心 kifa.net 日度拍卖价与行情分析，对花店/生鲜类是进货成本直接参考，不泛化为所有零售商品）、城市基本面（中国城市面板 209 变量 × 297 城 × 2000–2024，判断社区消费力与选址）、同业密度（工商登记，支持省份+城市+区县与行业小类颗粒度，可用 company_type 筛选个体工商户）、快递大盘景气（国家邮政局快递月报，36 期连续，兼营电商/社区团购的小店参考）。**硬边界**：工商数据最新批次 2023，滞后约 3 年，一律标注「历史格局、非实时」；数据源只有新增注册口径、无注销/吊销，「关了多少家」类问题明示做不了并给存量状态分布替代，禁止编造关店数量或估算退出率。

Retail industry environmental signal pack (install alongside the Micro-Business · Core Checkup Suite): wholesale price reference (Kunming International Flower Auction Center, kifa.net, daily auction prices and market analysis — a direct purchase-cost reference for florists and fresh-produce shops, not generalizable to all retail goods), city fundamentals (China city panel, 209 variables × 297 cities × 2000–2024, for judging neighborhood purchasing power and site selection), peer density (business registry with province + city + county granularity down to sub-industry, and company_type filtering for individually-owned businesses), and express-delivery climate (State Post Bureau monthly reports, 36 consecutive issues, a reference for small shops that also sell online or via community group buying). **Hard boundaries**: the newest registry batch is 2023 — roughly a 3-year lag — so every output is labeled 'historical snapshot, not real-time'; the source covers only new registrations with no deregistration/revocation scope, 'how many shops closed' questions are explicitly declined with a stock status distribution offered instead, and fabricating closure counts or estimating exit rates is forbidden.

- Species: pack (plaza category enum v1)
- Official: yes — curated by FindData



## How to obtain

Three paths, all landing the same frozen version snapshot:

1. In 壹座 (Yizuo): open the market tab, search "Micro-Business · Retail Signal Pack", subscribe and install.
2. In a CLI-capable editor (Claude Code, Cursor, Codex, Gemini CLI, ZCode):

       npx @finddatatechnology/facet install UXWcHRYPeyNue1Z4qQl-Tw

3. From the market page: https://agent.finddatatech.cloud/#/packs

## What it contains

Skills (1):
- mb-signal-retail — 零售行业环境信号包（谦面·生意体检姊妹件，需与内核套件 mb-core 叠加安装）。读四类信号：批发价参考（昆明花拍日度价，花店/生鲜进货直接参考）、城市基本面（中国城市面板 209 变量×297 城，判断社区消费力与选址）、同业密度（工商

MCP server references (2): fd-find-data-business-mcp, fd-open-data-mcp

## As of

Provenance: https://facet.finddatatech.cloud · As of: 2026-11-05
