# Proposal: chat-interaction-round2

## Why

聊天面十份 spec 刚完成 Purpose 回填；把每一条记录在案的 deferral 逐一与代码对拍后发现，多数「v2 欠账」其实早已兑现（assistant 轮复制/重新生成 `AssistantTurn.tsx:218-235`、最后一条用户消息编辑重发 `UserTurn.tsx:34`、首条消息自动标题 `chat-history.js:117`、`rename_session` `server/ws.js:1066`）。真正存活的是三件：① **spec 互相矛盾**——`chat-composer-controls` spec.md:59 仍规定「Model, effort, and workspace changes all restart the dsh runtime」并带 pending 禁发窗，而 2026-10-14 之后的 `model-selection`（wire-dsh-live-runtime-control）规定桥声明 `model/set` 时切换免重启且「SHALL NOT 再产生 pendingConfig 禁发窗口」——两份文本必有一份在撒谎，后续任何动这两份 spec 的迭代都会继承这个谎；② **外装技能没有更新路径**——记录在案的边界是「快照 + originUrl，用户想更新就再装一次」（2026-10-15 add-external-skill-install 明确不做），用户实际要手工重装；③ tool-use-rendering 的 todo_write nudge 决策挂在一个从未跑过的采纳率查询上（add-plan-progress-panel tasks 21）。

## What Changes

- **规格对账（纯 spec，零代码）**：MODIFIED `chat-composer-controls`「Control strip reports runtime restarts」——模型切换在桥声明 `model/set` 能力时免重启、不产生 pending 禁发窗（与 `model-selection` 对齐）；effort 与 workspace 切换维持重启路径（effort 仍整进程重启是 model-selection:173 自认的天花板）。生产代码已按 live 语义运行（0.2.0 桥已声明 `model/set`），tasks 补一条行为验证即收口。
- **外装技能更新流（本刀唯一代码面）**：MODIFIED `external-skill-sources`——已装外部技能新增显式「检查更新/更新」动作：按 `originUrl` 重新拉取 → 展示内容差异摘要（源版本/内容哈希）→ 确认后覆盖物化（沿用既有 `replaced` 覆盖语义与多文件树物化 + 热重载路径）→ 失败保持既有快照不动（吃既有 stale-on-failure 姿态）。这是对 2026-10-15「不做自动更新」边界的**有界反转**：只把「再装一次」升级为显式更新动作，不引入版本跟随、不自动检查、不后台轮询；依赖自动安装（`dependency:` 只展示）与 license 门维持不做。
- **决策探针（无 spec delta）**：在生产 trace_events 跑一次 todo_write 采纳计数（挂账查询：`SELECT COUNT(*) FROM trace_events WHERE event_type='todo/write'`），结果记入本 change；仍近零则另立 nudge change，不混入本刀。
- **明确不做**：⑨b 诚实合同重建与 concurrent 默认翻转（独立刀，生产现在 env-only 支撑）；effort 免重启（等 dsh 上游把 `model/set` 扩到 effort）；`/tool:` 进斜杠补全（2026-08-24 已裁定 out of scope——工具由 dsh 自动允许，不重开）；消息级右键菜单/自动会话标题（对拍证实已兑现，本文记录在案防再误报）；composer 重启防抖（记录为「值得观察」，仍不到动的时候）。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `chat-composer-controls`: 「Control strip reports runtime restarts」需求按 live `model/set` 语义改写——模型切换免重启化，effort/workspace 维持重启
- `external-skill-sources`: 新增已装外部技能显式更新要求（拉取 → 差异摘要 → 确认 → 覆盖物化 → 失败保持快照；无版本跟随/无自动检查）

## Impact

- `chat-composer-controls` 对账：spec-only，生产行为已是 live 语义，补一条验证任务。
- 技能更新流：server 安装/物化链（外装拉取路由、`skill-materialize` 多文件树物化、热重载）+ 技能面 UI（外装技能列表/详情加更新入口与差异展示）；不动 registry 市场安装链路、不动 pack 链路。
- todo_write 探针：一条只读 SQL 打生产 trace_events。
