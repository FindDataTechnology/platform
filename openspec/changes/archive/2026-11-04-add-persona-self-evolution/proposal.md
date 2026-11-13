## Why

技能桶的自进化闭环已在产（`skill-self-evolution`：提议→A/B 评测门→人批晋升热载），但角色桶（persona）仍只能人手改——一个回合里被验证有效的角色调整（边界条款收放、语气校准、职责聚焦）随会话结束就散了。用户裁定：persona 桶同构立项。参照骨架全部现成：候选 store、评测 harness 纪律（`memory-eval`）、双钥匙纪律（blueprint）、防中毒纪律（fleet 自迭代四闸 + 模型漂移毒化教训）、fork 血缘（`add-agent-fork-lineage`）。落位面：`add-agent-builder-hub` 调优区已预留 persona 修订占位。

## What Changes

- **提议（agent 提，不直接生效）**：回合收束后 agent 可经工具 `persona_amend` 产出**persona 修订候选**——修订后的 persona 文本 + 依据（来源回合引用、该修订解决过什么、适用边界）。候选落候选 store，**永不直接写 custom_presets / pack / 任何在跑会话**；无证据候选 SHALL 被拒。提议受 per-owner 日预算门与同任务 debounce；候选 store 有上限。
- **评测门（AI 证据，非 AI 终审）**：候选晋升前 SHALL 过 persona A/B 对照——同场景任务、同模型同温、隔离 scratch root、臂名对 judge 匿名（全部沿 `memory-eval` harness 纪律），臂=现 persona vs 修订 persona。门判据=修订臂 judge 盲评不劣于现行臂且差异可解释；评测报告随候选存档。**模型判绿是证据，人接受是终审**（双钥匙）。
- **晋升（人批后按对象分流）**：
  - 自建预设的 persona：人接受后经既有 custom_presets CRUD 物化，旧文本留 lineage 审计（可溯可回退）；
  - pack 自带 persona（`originPackId`）:MUST NOT 直改——接受动作 SHALL 经既有 fork 管线开出**fork 草稿**进我的创作（走 `add-agent-fork-lineage` 既有端点），发布/安装走既有管线；
  - 人 SHALL 可随时驳回候选（驳回即终结、留审计）。
- **生效节奏边界**：修订物化后按 preset 既有节奏生效（新会话/重铸），MUST NOT 热改进行中会话的 persona（防回合内人格漂移，沿模型漂移毒化教训）；建议文本 SHALL 标注生效节奏不谎称即时。
- **防中毒闸**：候选 SHALL 携证据链（来源回合可溯）；修订文本 SHALL 过既有注入类闸（沿 fleet 自迭代防中毒四闸同款检查）；`persona_amend` 不携带执行语义（提了不做，做完才算）。
- **边界（不可违反）**：修订只产 persona 文本候选——MUST NOT 提改模型选择、技能、工具、运行时、安全边界、权限；他人资产不可提改（同 skill 版边界）。
- **落位**：评审面（修订列表/评测报告查看/接受/驳回）落壹座构建器**调优区**（hub 预留占位填实）；i18n 五语言。
- **非 BREAKING**：无候选时调优区维持空态（hub 契约已定）；preset/pack 既有生命周期零改。

## Capabilities

### New Capabilities

- `persona-self-evolution`: persona 修订候选的提议、A/B 评测门、人批晋升分流（自建预设物化 / pack persona 走 fork）、生效节奏边界与 lineage——角色桶自进化的闭环。

### Modified Capabilities

<!-- 无：评审面落位由 add-agent-builder-hub 的调优区契约承载（其 spec 已写明占位与填实关系）；
     custom-presets / pack 管线零需求变化（修订经既有 CRUD 与 fork 端点）。 -->

## Impact

- **server**：新表 `persona_candidates`（迁移 v+1：id/target(kind+ref)/amended_persona/evidence/status(候选|过门|已晋升|已驳回)/eval_report/created_at）；新工具 `persona_amend`（进既有工具面注册，无执行语义）；候选 CRUD/评测触发/晋升路由（owner 鉴权 + 分流逻辑）。
- **评测**：复用 `memory-eval` harness——paas 侧新增「persona 臂」装配器（场景任务 prompt + 臂注入差异=现 persona vs 修订 persona）；隔离 root 纪律同技能臂。
- **前端**：构建器调优区 persona 修订分区（列表/报告/接受/驳回/分流去向说明）；i18n 五语言。
- **测试**：提议预算/debounce、臂隔离与匿名、门判定（平局/劣化不晋升）、晋升分流（自建预设物化 vs pack→fork 草稿）、驳回终结、生效节奏（进行中会话 persona 不变）、防中毒闸（无证据拒/注入检查）、他人资产不可提改。
- **不影响**：`skill-self-evolution` 的候选/臂形状、fleet 级自迭代（`agent-self-iteration`）、pack 发布安装管线、cell 会话驻留（parked 会话 persona 不被热改）。
