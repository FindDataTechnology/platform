# 生态素材审校台账（Ecosystem Curation Ledger）

首批白名单定稿 2026-10-07，依据：许可证桌面调研（2026-10-07 agent 报告，8 搜索 + 2 仓核）+ `docs/ecosystem-curation.md` runbook。**台面轴（S1 许可证 / Q1 维护活性 / Q2 传输）本台账已过**；**入库轴（S2–S7 / Q3–Q5 + egress 决议）在 1.4 托管 / 1.5 技能入库时逐条执行**——需要代码与容器在手，runbook 既定分期。

## 0. 背景事实（调研结论，影响全局）

- SKILL.md 已是跨 harness 开放标准（agentskills.io，2025-12-18 发布；Codex 2026-01、Gemini CLI 2026-04 采纳，~30 个 agent 读同格式）——单一格式策展成立。
- 官方参考 server 分两仓：活跃 `modelcontextprotocol/servers`（MIT/Apache 双许可）与冻结 `servers-archived`（MIT 但不维护）——**只收活跃仓**。
- 三条硬地雷：① anthropics 文档技能族（docx/pdf/pptx/xlsx）source-available 非开源；② firecrawl 引擎 AGPL+附加条款（其 MIT MCP wrapper 指云端是安全形态，但引入商业依赖，首批不收）；③ awesome 索引类条目许可证逐条核，无 LICENSE 即拒。

## 1. 首批 MCP server 白名单（12 条，上限内）

| # | Server | 上游 | 许可证 | 传输 | 台面轴 | 备注 |
|---|---|---|---|---|---|---|
| 1 | filesystem | modelcontextprotocol/servers | MIT/Apache | stdio | ✅✅✅ | 沙箱文件读写，agent 基线 |
| 2 | fetch | modelcontextprotocol/servers | MIT/Apache | stdio | ✅✅✅ | 网页取读；egress=open 候选 |
| 3 | playwright-mcp | microsoft/playwright-mcp | Apache-2.0 | stdio+HTTP | ✅✅✅ | 浏览器自动化，替代已档 puppeteer；egress=open 候选 |
| 4 | github-mcp-server | github/github-mcp-server | MIT | 原生 streamable HTTP | ✅✅✅ | **免托管**（GitHub 官方远端），只需注册处登记+凭据通道 |
| 5 | git | modelcontextprotocol/servers | MIT/Apache | stdio | ✅✅✅ | 本地 git 操作 |
| 6 | memory | modelcontextprotocol/servers | MIT/Apache | stdio | ✅✅✅ | 跨会话知识图谱 |
| 7 | sequential-thinking | modelcontextprotocol/servers | MIT/Apache | stdio | ✅✅✅ | 结构化推理脚手架 |
| 8 | excel-mcp-server | haris-musa/excel-mcp-server | MIT | stdio+HTTP | ✅✅✅ | xlsx 全读写；金融/法务工作簿核心 |
| 9 | postgres-mcp | crystaldba/postgres-mcp | MIT | stdio(Docker) | ✅✅✅ | 只读模式加固；接平台 fd-postgres 场景 |
| 10 | tavily-mcp | tavily-ai/tavily-mcp | MIT | 远端 HTTP | ✅✅✅ | 搜索/抽取；**需 Tavily 商业 API key**——托管前过 S6（凭据从平台侧注入 vs 用户自带）决议 |
| 11 | yfinance-mcp | narumiruna/yfinance-mcp | MIT | stdio | ✅✅⚠️ | 代码 MIT，**Yahoo 数据 ToS 是约束非许可问题**——台账记 ToS 合规义务 |
| 12 | CourtListener MCP | freelawproject | 宽松（入库时逐仓核 LICENSE 原文） | 远端+API | ✅✅⚠️ | 美国判例/案卷唯一严肃开源源；免费 API key |

可选第 13：time（官方，MIT，stdio）——日期类错误消除器，量小时顺带。

**明确不收（首批）**：sqlite/postgres/puppeteer 官方版（archived 冻结）；firecrawl（引擎 AGPL）；browserbase（商业云依赖）；brave/exa（API key 型，等需求再议——同 tavily 模式可后补）。

## 2. 首批技能集（~40 条，三源）

| 源 | 许可证 | 取用子集 | 台面轴 |
|---|---|---|---|
| anthropics/skills | 示例技能 Apache-2.0；**文档技能族 source-available 排除** | skill-creator、mcp-builder、artifacts-builder、canvas-design、frontend-design、webapp-testing、brand-guidelines 等 ~10 | ✅✅✅ |
| obra/superpowers | MIT | brainstorming、writing/executing-plans、TDD、systematic-debugging、verification-before-completion、code-review 族、subagent-driven-development、git-worktrees 等 ~18 | ✅✅✅ |
| VoltAgent/awesome-agent-skills | 逐条（索引） | data-analysis / web-research / documents 类精选 ~10；**硬门：只收链接仓库带显式宽松许可证的条目** | ✅⚠️✅ |

## 3. 台账条目（runbook §1 格式，逐条可追加）

### filesystem / fetch / git / memory / sequential-thinking（官方参考族）— 2026-10-07
- 上游: modelcontextprotocol/servers（活跃仓，commit 钉点入库时定）
- 许可证: MIT/Apache 双许可
- 状态: 入库待托管（1.4）
- 审校: S1✓ Q1✓ Q2✓（stdio——1.4 时按 runbook Q2 评估容器化/代理面）；S2–S7、egress 待容器审

### playwright-mcp — 2026-10-07
- 上游: microsoft/playwright-mcp
- 许可证: Apache-2.0
- 状态: 入库待托管（1.4）
- 审校: S1✓ Q1✓ Q2✓（HTTP 形态）；egress=open 候选（语义即浏览，S7 必过）

### github-mcp-server — 2026-10-07
- 上游: github/github-mcp-server（官方远端 streamable HTTP）
- 许可证: MIT
- 状态: 入库待注册（1.4 简化路径：免自托管，登记远端+egress vault 凭据模式）
- 审校: S1✓ Q1✓ Q2✓（原生 HTTP）；S6 决议=用户各自 GitHub PAT，不落平台凭据

### excel-mcp-server — 2026-10-07
- 上游: haris-musa/excel-mcp-server
- 许可证: MIT
- 状态: 入库待托管（1.4）
- 审校: S1✓ Q1✓ Q2✓；egress=none 候选（纯本地文件处理）

### postgres-mcp — 2026-10-07
- 上游: crystaldba/postgres-mcp
- 许可证: MIT
- 状态: 入库待托管（1.4）
- 审校: S1✓ Q1✓ Q2✓；egress=none + 只读模式强制；S6 决议=连接串归属（用户自带 vs 平台样本库）

### tavily-mcp — 2026-10-07
- 上游: tavily-ai/tavily-mcp
- 许可证: MIT（server）
- 状态: 考察中（商业 API 依赖待运营拍板）
- 审校: S1✓ Q1✓ Q2✓；S6 决议未定：平台注入 Tavily key（计费/额度谁担）vs 用户自带

### yfinance-mcp — 2026-10-07
- 上游: narumiruna/yfinance-mcp
- 许可证: MIT
- 状态: 入库待托管（1.4，带 ToS 合规注记）
- 审校: S1✓ Q1✓ Q2✓；Yahoo ToS 义务记档：频率克制、不转售数据

### CourtListener MCP — 2026-10-07
- 上游: freelawproject（具体 repo 入库时钉）
- 许可证: 宽松族（**入库时逐仓核 LICENSE 原文**）
- 状态: 考察中（免费 API key 流程待验）
- 审校: S1⚠️ Q1✓ Q2✓

### anthropics/skills（Apache 子集）— 2026-10-07
- 上游: anthropics/skills
- 许可证: Apache-2.0（仅示例技能；文档族 source-available **已排除**）
- 状态: 入库待整理（1.5）
- 审校: S1✓ Q1✓ Q2✓（内容型）；S5 注入面逐条过 SKILL.md 正文

### obra/superpowers — 2026-10-07
- 上游: obra/superpowers
- 许可证: MIT
- 状态: 入库待整理（1.5，~18 条）
- 审校: S1✓ Q1✓ Q2✓；S5 逐条

### VoltAgent/awesome-agent-skills 精选 — 2026-10-07
- 上游: 逐条目仓库（索引非源）
- 许可证: 逐条——**无 LICENSE 即拒（硬门）**
- 状态: 考察中（精选 ~10 条待逐条定）
- 审校: S1 逐条 Q1 逐条 Q2✓；这是无证条目渗入的高危面
