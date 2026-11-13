# Design: chat-interaction-round2

## Context

见 proposal.md（Why）。两块工作面：① 纯规格对账——`chat-composer-controls` 的重启需求与 2026-10-14 后的 live `model/set` 语义矛盾，生产代码已按 live 语义运行（0.2.0 桥声明 `model/set`，wire-dsh-live-runtime-control 已上产验证）；② 外装技能更新流——2026-10-15 `add-external-skill-install` 记录在案「不做自动更新（快照 + originUrl，想更新就再装一次）」，本刀做有界反转。技能面现状：安装链 = server 端拉取 → DB 行 + `skill-materialize` 多文件树物化 → watched-directory 热重载；重装同源同 slug 走 `replaced` 覆盖语义。

## Goals / Non-Goals

Goals：composer spec 与 model-selection 对齐且行为有验证证据；已装外装技能获得显式更新动作（预览差异 → 确认 → 原地替换 → 热重载）；todo_write 采纳探针出数并留档。

Non-Goals（proposal 已列，此处只补设计层）：不引入任何版本比较/排序语义（上游版本号只透传展示）；不做后台检查/角标提醒；不动 registry 市场安装链路；不做依赖自动安装与 license 门；diff 不做逐行文本对比。

## Decisions

### D1 对账方向：composer spec 向 model-selection 对齐，而非反向

live `model/set` 是已上产且经生产验证的行为（流中切换、无 pendingConfig 窗）；把 model-selection 拉回重启语义等于用文档推翻已发货行为。修改后的重启需求保留两条腿：桥声明 `model/set` 时模型切换 live 化；未声明时保留重启路径（老 dsh 兼容）。effort 维持重启（model-selection:173 自认天花板，等 dsh 上游）。

### D2 更新流复用安装链，新增的只有「preview」一个只读端点

- **preview**（新，只读）：按已装技能的 `(source, slug)` 重新拉取上游包，在内存中与已装快照做 diff，返回摘要；不写库、不物化。
- **apply**（复用）：确认后走既有 install/replace 写路径（DB 行更新 + 物化树替换 + 热重载），零新写路径。
- 备选「独立 update 端点全链新写」被否：与 install 形成 Replaced 双写路径，重复真源。

### D3 diff 计算 = 路径集合 + per-file sha256

新增/删除/变更三桶：路径集合对比定增删，同路径 hash 对比定变更；整体 hash 对比作为「上游是否真有变化」的一眼判据。不做逐行 diff（引大依赖、对技能文件收益低）。上游版本号只在 provenance 里透传展示，不参与逻辑。

### D4 UI 落点：已装技能列表中带外装 provenance 的条目加「更新」动作

入口只在已装列表（外链货架详情页不加，避免「未安装也能更新」的歧义）。点击 → preview 弹窗（diff 摘要 + 「未经审校」标保持）→ 确认/取消。无角标、无自动提示，与「不自动检查」一致。

### D5 todo_write 探针：一条 SQL，判定阈值先定好再跑

生产 trace_events 上统计 `todo/write` 事件计数（挂账查询原文 `SELECT COUNT(*) FROM trace_events WHERE event_type='todo/write'`，建议带 30 天窗口与总量对照）。判定：窗口内近零（< 1% 会话出现过）→ 另立 nudge 提案（不混入本刀）；有明显采纳 → 记录数据并关闭该挂账。结果无论哪边都写进本 change 的 tasks 注记。

## Risks / Trade-offs

- 上游包结构漂移导致 diff 全量「变更」——可接受，摘要如实呈现；不试图做重命名检测。
- preview 拉取的时限与体积：复用安装链既有的拉取超时/体积上限，不另设。
- 更新与用户本地手改已装技能冲突：replace 语义本就覆盖（与重装一致），preview 的 diff 会让覆盖可见——够用，不做三方合并。
- composer 对账零代码：唯一风险是「以为 live 实际没 live」，由 1.x 验证任务堵（桥能力声明 + 流中切换实测）。

## Open Questions

（无——autoUpdater/⑨b/effort live 化均已在 proposal 排除，不构成本设计的前置。）
