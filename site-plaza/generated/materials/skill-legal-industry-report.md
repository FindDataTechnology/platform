# legal-industry-report

## What this is

输入一个行业（可选区域与业务方向），输出一份可交付的精排 A4 PDF 行业法律调研报告。设计风格采用律所蓝皮书体例（深蓝主色 + 白色页面 + 衬线大标题 + 顶部品牌带），内置 report-profile.md 个性化配置（律所抬头 / 配色 / 主办律师 / 封面变体 / 联系方式），数据源来自企查查 MCP（企业名录 + 司法/经营风险标签）+ 网络检索（政策文件、产业园名录、产业链结构）。建议在用户说"做一份行业调研报告 / 见客户前先了解下 XX 行业 / 这周要去 XX 行业跑客户帮我准备背景资料 / 开拓新行业之前知己知彼"时使用；不要用于：客户名下的具体法律意见、对单一企业的尽调（用 opc-legal-counsel）、按周推送的对外研报（用 weekly-legal-briefing）。

Takes an industry as input (with optional region and business focus) and produces a deliverable, finely typeset A4 PDF industry legal research report. The design follows the law-firm blue-paper style (dark blue as the primary color + white pages + large serif headlines + top brand banner), includes a built-in report-profile.md personalization config (law-firm letterhead / color scheme / lead attorney / cover variants / contact details), and draws data from Qichacha MCP (company directory + judicial/operational risk tags) plus web search (policy documents, industrial park directories, industry chain structure). Recommended when the user says "prepare an industry research report / help me get to know industry XX before meeting a client / I'll be visiting clients in industry XX this week, prepare background material for me / know yourself and the other side before expanding into a new industry". Do not use for: specific legal opinions under a client's matter, due diligence on a single company (use opc-legal-counsel), or externally distributed research pushed weekly (use weekly-legal-briefing).

- Species: skill (plaza category enum v1)
- Official: no



## How to obtain

1. In 壹座 (Yizuo): Extensions → Skills — subscribe from the skills face.
2. Inside editors: skills reach your editor bundled with a pack that references them — install that pack with:

       npx @finddatatechnology/facet install <packId>

3. Deployed agent services receive registry skills through the registry supply channel.
Source repository: https://github.com/cat-xierluo/legal-skills


## As of

Provenance: https://facet.finddatatech.cloud/api/skills-catalog · As of: 2026-11-05
