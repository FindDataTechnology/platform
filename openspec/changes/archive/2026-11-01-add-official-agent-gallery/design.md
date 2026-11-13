## Context

See `proposal.md` — Why. Implementation-relevant state:

- `official-pack-showcase` 已上产：官方判定=部署侧名单（env 注入）、`GET /api/packs/official` 三段聚合匿名可读、壹座市场 official 筛选 chip + 登录墙前段呈现。
- `official-starter-teams` 的说明卡语义（与种子 manifest 同源、v4 词表、匿名可读）与 `packGuides.ts` 的 starter 序列/HelpDialog 序列是本 gallery 的内容输入。
- 共享规格书（`add-agent-spec-sheet`）与 fork（`add-agent-fork-lineage`）为本 gallery 的两块消费件。
- 匿名读面的敏感结构纪律（`pack-visibility`「探测教不出东西」）是匿名呈现的硬边界。

## Goals / Non-Goals

**Goals:**
- 官方集合从「筛选维度」升级为「看懂平台的入口」：规格书 + 克隆 + 序列。
- 端点零改；呈现层消费已落地的共享件。

**Non-Goals:**
- 官方判定源、三段聚合契约、推荐/排行算法、匿名面数据扩权——全部不动。

## Decisions

### D1 — Gallery 是呈现层升级，不是新端点
复用 `/api/packs/official` 三段聚合；匿名面给什么投影就渲染什么（规格书在匿名态可能只有摘要桶——这是纪律不是缺陷）。
- *Why*: 端点契约稳定，防匿名面被「要渲染规格书」倒逼扩权。
- *Alternative rejected*: 为 gallery 扩匿名 manifest 下发——违反 pack-visibility 纪律。

### D2 — 序列标记走呈现层注记
starter 序列（1→5）不进端点契约，由前端按 `official-starter-teams` 的序列定义注记（序列定义已是前端常量/文档）。
- *Why*: 端点零改；序列是运营叙事，非数据结构。

### D3 — 克隆入口复用 fork 契约，不新做「官方克隆」
gallery 卡上的克隆就是 `agent-fork-lineage` 的 fork（含血缘与官方语义不变式：克隆官方不获官方）。
- *Why*: 一套克隆语义；「官方克隆」若另立会分叉血缘与权限。

### D4 — 官方资产 dogfood：流程约定，无代码
官方资产改由 Agent Studio 编排产出（manifest 真源 + `scripts/test-*-seed.mjs` 钉住不变）；本 change 不引入产出工具代码。
- *Why*: 「官方资产用自家构建器」是运营纪律；种子测试继续钉住清单形状。

## Risks / Trade-offs

- **匿名规格书信息量低**（投影受限）→ Mitigation: 匿名态呈现以「看懂结构」为目标（桶的存在与构成可读），完整细节沿登录墙；这是纪律边界的如实呈现，不是体验缺陷。
- **依赖三个在途 change**（spec-sheet / fork / guides）→ Mitigation: 本 change 排最后；delta 只依赖契约不依赖实现；归档序在提案 Impact 注明。
- **starter 说明卡双源风险** → Mitigation: 序列标记仅注记，卡内容仍走 manifest 同源通道（`move-pack-guides-to-manifest` 收口后零第二真源）。

## Migration Plan

- 纯呈现层升级 + 三个消费件接入；无数据迁移。
- Rollback: 呈现层 revert 回筛选+徽章；端点与数据零风险。

## Open Questions

- gallery 入口位置（市场内 official 筛选升级为页签 vs 独立路由）——实现期定；两者契约相同。
