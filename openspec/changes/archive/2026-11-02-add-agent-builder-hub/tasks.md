## 1. 词条与门面骨架

- [x] 1.1 `packages/core/src/lib/surfaces.ts`：AGENTS_TAB_SURFACES 扩为 build/supply/creations/tuning（保留 agents/market 兼容读），NAV_SURFACES agents 行不变；验证：`tsc` 零错误 + surfaces 单测绿
- [x] 1.2 i18n 五语言：`nav.agents` 与四区标签（构建/供给/我的创作/调优）五语言录入，zh-CN 主轨「智能体构建器」；验证：五语言 common.json 各含全组 key 且 en/zh 并比无缺键（跑既有 i18n 完整性门）
- [x] 1.3 词表登记：`docs/roadmap-agents-native-teams.md` 词表 v4 附录增「智能体构建器」五语言行；验证：与 common.json 词条逐语言一致
- [x] 1.4 `App.tsx`：D5 映射常量表（`?tab=market`→供给区市场柜、`?tab=agents`→我的创作）+ `/studio` 路由保持；验证：访问 `/settings/packs`、`/settings/presets` 重定向落在对应区柜（Playwright 断言）

## 2. 四区面板

- [x] 2.1 `AgentsPage.tsx` 重组四区 tab 结构，默认落构建区（构建区 = /studio 直达卡 + 入口说明）；验证：e2e 点 sidebar「智能体构建器」落在构建区、切区不离开 /agents
- [x] 2.2 供给区三柜：pack 市场柜（现 market tab 内容迁挂）、技能柜、MCP 柜（`McpInstalledView`/`McpMarketView`/技能视图换挂点）；验证：三柜切换渲染对应面板，浏览/安装/管理动作与迁入前一致（对照 e2e）
- [x] 2.3 我的创作区：pack 草稿/manifest 编辑器入口 + 自建预设管理入口；验证：新建/编辑/发布走既有端点（e2e 冒烟）
- [x] 2.4 调优区：技能候选评审面挂载（候选列表/评测报告/接受/驳回，接 `add-skill-self-evolution` 的候选 API）+ persona 修订占位空态卡；验证：无候选时空态可见、有候选时列表可比对报告（单测 + e2e 各一）
- [x] 2.5 深链：`/agents?tab=supply|creations|tuning` 直达对应区；验证：Playwright 三深链断言

## 3. 收编前可达性与协调

六既有构建入口逐条可达验证（吸收 `add-agent-studio` 6.3）：PacksPage 内容、CustomPresetsPage 内容、蓝图工作面（`/studio?from=blueprint`）、市场详情、预设发布流、草稿编辑器；验证：e2e 六断言全绿
- [x] 3.2 `add-skill-self-evolution` 对表：其任务书前端落位注记改为构建器调优区；验证：该单 tasks.md 注记更新且其 spec 无需改（位置未钉）
- [x] 3.3 Settings 别名不分叉验证：同一台 server 在 Settings MCP 区与供给区 MCP 柜渲染同组件同状态；验证：e2e 双入口比对断言

## 4. 真机走查与出片

- [x] 4.1 【本地浏览器走查 12 腿全过（scripts/walkthrough-builder-hub.mjs，截图 gui-test-screenshots/builder-hub/）——四区/注释卡/五语言词条/索引 API/legacy 归一；生产真机走查随出片班】真机走查五语言：zh-CN/en/ja/es/fr 逐语言过四区（标签无缺键、无溢出）；验证：走查截图入台账（2026-11-02 本窗口执行：ALL LEGS PASSED 12/12，截图 22 张入 gui-test-screenshots/builder-hub/；hermetic 无市场柜，柜切换以 MCP/技能柜验证）
- [x] 4.2 隐藏布局回归：layout-configuration 隐藏 Agents tab 后 `/agents` 深链仍解析；验证：e2e 断言
- [ ] 4.3 出片走查（按 paas-release 线）+ 台账记录；验证：生产 sha 面上眼见四区 + 词表行 【归档挂账 2026-11-02：代码面已全部合入当前线（c96154be/c708b86d），4.1 本地走查 12/12 已过；本条为纯滚版后生产眼见动作，随下一班出片走查移交台账执行】
