# Design: add-agent-memory-foundation

## Context

见 proposal.md - Why。代码核实过的现状约束：

- 落库形态是「markdown 真源 + 派生 SQLite」双轨（src/db.ts 建派生索引，页面正文落 markdown 文件）。metadata 必须同时进两轨：文件 frontmatter 承真源、SQLite 列承索引——只进任一侧都会造成真源与索引漂移。
- `fleet-memory` spec 已条款化「每成员一个以 `metadata.agentId` 命名的 project」——metadata 概念在该 spec 中已预设，但实现面没有任何 metadata 字段（grep 零命中）；本单是把它做成实现事实。
- 壹座舰队 capture（paas/server/fleet-memory.js）现以 `[${kind}][${memberId}] ${title}` 标题前缀承载结构信息，digest 的成员相关性 = 标题相关性查询。壹座侧改造归姊妹 change，本单必须保旧格式双轨可读。
- 令牌鉴权已是 Grant 表数据驱动（`grants(token, scope_kind, scope_ref, mode)`），每请求判定、无缓存宽限——oversight grant 有现成的判定管线可挂。
- d/ 根的 owner 归属目前没有显式记录（packId 唯一性由 registry 部署条目单例保证，但根本身不记 owner）——oversight 判定需要一个结构性锚点。

## Goals / Non-Goals

**Goals**：metadata 一等化（写/存/索引/筛）；读面结构化筛选与相关性正交；存量前缀回填；owner 审计式监督只读；memory_overview。全部保持 fail-open 与零破坏升级。

**Non-Goals**：不改四层模型与蒸馏管线；不做 metadata 全文检索（只做键值过滤）；不做跨 agent pull-read 授权（进阶层另立）；不动壹座侧 capture 路径（姊妹单）；不做 metadata 版本化/schema 演进框架（留 JSON 键值，够用再扩）。

## Decisions

**D1 · metadata 双轨承载：markdown frontmatter 为真源，SQLite 列为索引。**
备选 A：只进 SQLite——否决，真源残缺，重建索引即丢数据。备选 B：只进 frontmatter 读时解析——否决，筛选下推失效，回退全量扫描正是本单要消灭的形态。落法：写面同时落两侧；回填命令同样双写；读取以 SQLite 为准（索引筛选），frontmatter 仅在重建索引时消费。

**D2 · 筛选语义 = 键值等值 + 时间范围 + layer，不做表达式语言。**
备选：类 SQL where 表达式——否决，注入面与滥用面不成比例，agent 调用方只需要「按岗位/类型/时间取」。键值过滤对数组值取「包含」语义（`memberId` 在数组中即命中），与既有 search_keys 直觉一致。

**D3 · oversight 判定用显式 ownership 表，不用命名约定。**
d/ 根在首次由某 owner 体系铸造 deployment 令牌时记录 `root_owner`（platform 铸造面已有 namespace 上下文，落一行即可）；person oversight 判定 = `root_owner(person) == root`。备选：从 `u/<user>` 与 `d/<packId>` 的名称映射推导——否决，依赖约定即依赖漂移，spec 已钉死「MUST NOT 依赖名称约定」。审计行复用既有 admin/审计存储，不新开库。

**D4 · 回填命令独立触发、双轨读、不改写标题。**
回填是幂等的一次性迁移（解析 `[kind][memberId]` 前缀 → metadata），标题保留原样使旧调用方零感知；双轨淘汰由姊妹 change（壹座切净写面）完成后另行收口，本单不承诺删除前缀解析。

**D5 · memory_overview 复用既有授权判定，不新开权限面。**
overview = 「当前令牌可达分区」的聚合只读：deployment=own+shared、pod=shared、person=自有根（+oversight 只读分区），与 buildTools 既有 readProjects 判定同源——工具面新增绝不旁路 Grant 判定。返回体硬上限（页数计数 + 最近 ≤10 条标题），防概览工具变成全量拉取通道。

## Risks / Trade-offs

- [metadata 列使 SQLite 索引体积增长] → 只对 kind/memberId 两个高频键建索引，其余键值可查但不索引；观测页（L0 高频）量级可控。
- [frontmatter 与 SQLite 短暂不一致（写崩溃窗口）] → 沿用既有「markdown 真源 + 派生索引可重建」纪律，索引重建命令收敛一致性；写面先落真源后落索引。
- [oversight 引入「owner 可读成员私有记忆」的隐私面] → 这是对 owner 自有资产的监督权（壹座语义里成员是 owner 的员工），逐读审计行是制衡；不对跨 owner 开任何口子。
- [回填误解析非舰队前缀的标题] → 前缀模式严格匹配五类已知 kind 词表，解析不出的原样跳过并计数上报，宁漏不过。

## Migration Plan

1. 写面收 metadata（缺省等价）→ 2. 读面筛选参数（缺省等价）→ 3. 回填命令（幂等、独立触发）→ 4. oversight grant + 审计 → 5. memory_overview。每步独立可回退；回填只增 metadata 不改文本，回退零数据损坏。

## Open Questions

- root_owner 记录落在 registry 铸造侧还是 fd-memory 铸造面——倾向后者（fd-memory 自己的 platform 铸造面已有完整 namespace 上下文），姊妹 change 联调时实证定案。
