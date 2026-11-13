# vertical packs 内容所有权（2026-10-06 起）

| pack | 内容所有权 | 发布通道 |
|---|---|---|
| legal-contract-workflow / legal-case-workflow | **识律线（lex-platform-v1）**——内容演进由识律侧主导，本仓保留同步副本 | facet 功能集市场（发布即 vN+1，走 creators 流程） |
| stock-research / china-macro-brief | 谦面/数据线（现状不变） | 同上 |
| registry-groups.json | 网关分组映射：server/skill → groups（legal=LawBench+识律法律检索；analysts=数据线） | 改动随本仓提交 |

背景：lex-platform-v1 3.1/3.2 落地后，法律检索能力由 `fd-legal-search-mcp`
（registry 已注册，legal 组可见）供给；legal-case-workflow 技能的类案检索声明
已更新为实指（原「暂缺」声明废除）。所有权迁移依据见 lex-platform-v1 design D10。
