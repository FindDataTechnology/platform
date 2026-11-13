# Design: add-save-to-library-tool

## Context

资源库现无任何模型可调的写入口：唯一模型可见平台工具是 `chart_bind`（`dsh-profile-template/platform-chart-bind-bridge.js`，loopback POST `/api/resources/bind-declared`），用户保存走会话鉴权的 `POST /api/resources`。`auth.js` 已有三座 loopback-only 桥（cron / chart-bind / delegation），信任模型一致：loopback 即凭证、非 loopback 照过全门、路由只作用于当前回合。`storeFileCopy`（`resources.js`）已实现完整门（realpath 包含、大小上限、sha256 去重、write-tmp-then-rename）。本设计的决策全部来自 2026-10-16 探索/grill 会话。

## Goals / Non-Goals

**Goals:**

- 模型在回合内显式把工作区文件入藏，绕开自动捕获启发式的盲区（脚本内部写文件）
- 与用户手动保存共用同一套门与字节路径，内容去重天然幂等
- 逐路径结果回报，模型能向用户转述成功/已存在/拒因

**Non-Goals:**

- 镜像路径缺 blocks 导致的捕获缺口（worker 池 / 远端 fork——另立 change）
- 产物规则（produced-file rule）扩规；图表经工具入藏；确认门；feature flag
- 库 UI 的任何变化

## Decisions

**D1 工具形状：`save_to_library`，参数 `paths: string[]`，无标题参数。** 相对或绝对路径均可（门里有 realpath 归一）；每次调用 ≤10 条，超出的**逐条拒收回报**、不静默丢弃（grill 定案）；标题取 basename——重命名能力已存在，不值得为标题加参数面。备选单路径工具被否：多文件交付时要连调多次。描述文案教「交付即调、重复无害」，与 artifact-contract 增量 (e) 条一致。

**D2 `source` 取新值 `"model"`。** 现有 `auto`（平台捕获）/ `manual`（用户保存）之外的第三值；SQLite 列为自由文本，无迁移，API 类型联合扩一项。UI 不按 source 分支展示，纯溯源字段。

**D3 路由 `POST /api/resources/save-declared`，第四座 loopback-only 桥。** `auth.js` 加 `isInternalSaveBridge` 谓词，逐字仿 `isInternalChartBridge`（`req.path === "/api/resources/save-declared" && isLoopback(...)`）。归属当前回合：`ctx.dshSessionId` + `db.getSessionMeta(sessionId).title` 快照；**不回填 message_id**——assistant 消息回合结束才落库，入藏发生在回合中，等落库会造成时序耦合。备选「桥自己传 sessionId」被否：chart_bind 先例证明服务端解析当前回合更安全（桥无法指名别的会话）。

**D4 桥插件 `dsh-profile-template/platform-save-library-bridge.js`。** `bridgeOrigin()` 与 chart-bind 桥同推导（HOST/PORT env，bind-any 归 loopback）；`defineTool` + `ctx.tools.register`，经 `dsh-profile.js` 现有模板组装挂载；结果用 `textBlocks` 逐路径渲染（chart_bind 的 `renderResult` 模式：告诉模型向用户说什么）。10 条上限在桥与路由**双层校验**（桥挡友好错误，路由是真相层）。

**D5 存储完全复用 `storeFileCopy`。** 仅需接受 `source: "model"` 与 `messageId: null`；realpath 包含、`RESOURCE_MAX_FILE_BYTES`（默认 20MB）、sha256 去重、write-tmp-then-rename 全部原样。目录拒收在路由入口 stat 判定（capture 路径已有 isFile 判定，抽用同一逻辑），拒因独立可辨。去重命中时不复制字节（hash 先于 copy），所以模型重复调用零存储成本。

**D6 教学落在 artifact-contract，一句为限。** `skills/platform-output-contract/SKILL.md` 加交付即调条款 + 「saved/already-saved 后同回合勿重调」；契约保持 baseline-skill 体量（spec 硬约束）。自动捕获不撤——降级为模型忘调时的保险带。

**D7 不挂 feature flag，同镜像直上。** 路由（server）与桥模板（dsh-profile-template）同仓同镜像，cell 内无版本错位；桌面端对 tool_use 块通用渲染、不解析工具语义；`chart_bind` 当年同样无 flag。与 add-packaged-skills 的 flag 先例不同：那是新旧数据格式兼容问题，这里纯增量、失败模式是单次工具调用报错，无持久化错读风险。

**D8 并发与幂等。** 同内容并发入藏：`content_hash` UNIQUE 约束保证只立一行，后到者按 already-saved 回报并刷新 `last_seen_at`；回合内模型对同一文件先自动捕获后工具调用的竞态同理消解。

## Risks / Trade-offs

- [模型为随手提到的文件滥调（库变垃圾场）] → 契约限定「markdown 链接交付的文件」；中间产物不交付不链接，触发面天然收窄；即使误调，去重与 20MB 门兜底
- [第四座 loopback 豁免扩大同机伪造面] → 与既有三桥同信任模型；路由只作用于当前回合的会话（无法指名他人会话）、只收工作区内 regular file；非 loopback 照过全门
- [20MB 拒收让模型「答应了却没存进」] → 拒因逐路径回报，模型可当场转述并建议（如压缩/分段）；这是门的一致性而非新增限制
- [老 cell + 新模板的窗口期工具 404] → 同镜像部署下不存在；托管多 cell 滚产窗口内最坏情形是该工具单次调用失败并可重试，无数据风险

## Migration Plan

一个镜像同时带路由与桥，常规版本上线；无 schema 变更、无回填。回滚 = 还原镜像，已入藏的 `source="model"` 行按普通资源留存（合法状态，无需清理）。

## Open Questions

- 无
