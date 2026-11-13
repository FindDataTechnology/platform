# close-supply-loop-interfaces Design

## Context

章程 D4 定形：三个闭环接口按「单向 + 出处 + 诚实降级」收口，形状复用 L2 凭据轨。现势（2026-11-07 勘验）：

- **实例回报**：契约表（`supply-domain-roadmap.md` §5）记「萬星→脊柱 facade 实例状态/出处入登记处（新）」，零代码。壹座侧已有读源：`server/routes/wanxing-fleet.js` 的 `localFleetSnapshot()`（部署状态/runner/容量，本地库）；脊柱写闸客户端形状在 registry 仓已实证（`POST {base}/api/supply-store/mcp-servers/{upsert|patch|delete}`，actor/source 审计）。
- **晋升**：`fleets.js:2703 promote` 已实现单向闸——fork 范围 preset/配置/skills，`_promotion` provenance 随文档（sourceFleetId/promotedAt/forkScope/excluded=[记忆,会话历史]）；蓝图 API 无回写 fleet 路径（3.5 回归钉）。Q2（fork 范围裁决）悬置。
- **通知**：in-app 走 `scheduled-task-notifications` 既有语义；微信订阅模板悬置。

## Decisions

- **D1 实例回报 = 登记不驱动，写闸新 instances 族而非复用 mcp-servers 族。** 备选「塞进 mcp_servers.metadata」被否：实例是运行态资产（有 TTL/状态迁移），与 server 登记物（静态声明）生命周期不同源；同库不同表（`spine_instances`）同闸同审计。单向铁律的机制保证=脊柱侧**无** instances 读面驱动代码（写闸只收登记；投影只读），且壹座侧回报器只 `fire-and-forget`（失败日志+计数，绝不阻塞部署写路径、绝不重试风暴——TTL 过期即自然消失，不需删除风暴）。
- **D2 回报触发点 = 部署写路径后置 hook，非 cron 轮询。** 备选「定时全量对账」被否：部署事件低频且 `localFleetSnapshot` 已是全量真源，事件后置 upsert（status/runner/pack/provenance）足够；全量对账留给未来 reconcile 需求（如出现）另立。回报器 `try/catch` 全包——部署成功但登记失败时，用户视角零感知（诚实降级）。
- **D3 Q2 裁决 = 维持现 fork 范围（preset/配置/skills），记忆/会话历史不 fork。** 备选「开放记忆摘要 fork」被否：记忆属用户私有运行态（跨隐私边界），且与单向闸同构冲突（草稿≠运行态投影的语义会松动）；后续开放须另立单走隐私评审+用户拍板。裁决落地方式=promote 的 `_promotion.forkScope/excluded` 从实现注释升为 `fleet-blueprint-studio` spec 条文（MODIFIED）——裁决成文、回归钉不变。
- **D4 通知触达 = 降级条文成文，零代码。** in-app 沿用既有；微信订阅模板=「依赖用户行动（模板申请）」的显式挂账态写入 spec——MUST NOT 伪装已通（硬纪律：缺数据如实降级）。
- **D5 facade 侧开关 `SPINE_INSTANCES_ENABLED` 缺省关。** 新路由族上产不即生效——萬星侧显式开启才接通，回报失败静默降级；避免两侧同步上产的耦合（壹座先上，萬星随时可开）。

## Risks / Trade-offs

- **[实例登记漂移]** TTL 过期 vs 实际还在跑 → TTL 设 24h、部署写路径每次变更都重 upsert（心跳随事件走）；漂移窗口如实存在，读面标 `as_of`。
- **[脊柱 schema 扩张]** instances 族加表 → 与 mcp_servers/skills 同库同闸，facade 迁移脚本同构；上游（facet 脊柱）变更须过其 openspec（本单只定契约与客户端，schema DDL 落 facade 侧实施）。
- **[Q2 裁决被翻案]** 未来开放记忆 fork → 本单 spec 条文 MODIFIED 即可，单向闸机制不动。

## Migration Plan

1. facade 侧：instances 路由族 + schema（开关缺省关）→ 上产。
2. 壹座侧：回报器 + 部署 hook + 开关接通 → 脊柱投影读 instances 段验证 provenance。
3. spec 成文（instance-report 新 capability + fleet-blueprint-studio MODIFIED）→ strict → 归档。
4. 章程 3.1-3.3 双账勾选。

**Rollback**：壹座侧关 `SPINE_INSTANCES_ENABLED`（hook 静默空转）；facade 侧路由族无读面无下游，revert 即净。

## Open Questions

- **Q-A 脊柱投影 instances 段的读面消费者**：本单只保证「登记处可读+provenance」，主人视图（C1 owner-cross-line-view）消费属 4.x 单——不夹带。
- **Q-B TTL 时长**：24h 起步（部署变更即续），是否需要按 runner 心跳加密——实施时按 facade 侧数据密度定，不阻塞契约。
- **Q-C 通知触达挂账（章程 3.3）**：in-app 侧沿用 `scheduled-task-notifications` 既有语义（零改动）；微信小程序订阅模板**依赖用户行动**（模板申请，工程侧无法定时）——如实挂账，MUST NOT 伪装已通；模板获批后接入走既有通知面，不另立通道。
