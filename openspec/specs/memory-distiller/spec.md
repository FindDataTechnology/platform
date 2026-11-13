## Purpose

L2 蒸馏：把零 LLM 的 L0 观测 / L1 交接在后台限额地蒸馏为可跨会话复用的事实（fact）与经验（experience），引擎可替换（契约层对齐开源引擎，不耦合其代码）、永不删页只 supersede、全程可溯源可回滚。

> 实现归属：fd-memory 服务仓——本 spec 为跨仓行为契约，审计时按文件间一致性核对。

## Requirements

### Requirement: Distiller 契约是幂等且可替换的

蒸馏 SHALL 经由语言中立的服务契约进行：`DistillRequest{scope, cursor, items[], candidates[]}` → `DistillResult{facts[], experiences[], cursor_next, llm_calls, tokens, errors[]}`。`items` 为该 scope 自 cursor 起的观测 / 交接 / 笔记页，`candidates` 为按 task / search_keys 检索的既有 fact / experience。cursor SHALL 单调：同 cursor 重跑产出等价结果，失败会话 MUST 保留 cursor 不前进（无进度即无损失）；产物页 MUST 携带 `generated.by = engine:<name>/<version>` 溯源，引擎更换后新产物可与新引擎名区分。引擎 MUST 可替换——契约之外的引擎内部形状（Python 类、提示词、解析器）不得出现在 fd-memory 侧代码里。

#### Scenario: 同 cursor 重跑等价

- **WHEN** 同一 DistillRequest 以相同 cursor 提交两次
- **THEN** 两次产出的 fact / experience 集合等价，且第二次不产生重复页

#### Scenario: 失败保留 cursor

- **WHEN** 一次蒸馏因调用失败或超时而中止
- **THEN** 该 scope 的 cursor 不变（下次从同处重试），errors[] 记录失败原因，「没抽到」与「调用失败」在账目上分开

#### Scenario: 引擎溯源

- **WHEN** 更换蒸馏引擎后新产物落库
- **THEN** 每页 generated.by 标明新引擎名与版本，旧引擎产物不受影响

### Requirement: L2 写入纪律——永不删页、只 supersede、脱敏、预算内

蒸馏产物 SHALL 以新页写入（fact / experience 页型），当产物是对既有条目的修正时 MUST 写新页并携带 `supersedes[]` 指向被修正页，被修正页保持原样（历史可溯）；蒸馏 MUST NOT 删除或改写任何既有页。**事实层与经验层同纪律**：fact 草稿经事实层 reconcile 关联到既有 fact 时 MUST 以 supersedes 合并（一条新页可并列指向多条被并的旧页），无关联才新增；单次蒸馏的 fact 产出 MUST 受上限约束（超出丢弃并记审计 warning），抑制薄记录累积。产物正文与 `details`（原文直取，上限 4000 字符）MUST 过既有四类脱敏后才落盘；`sources[]` MUST 引用产出它的 item 坐标。蒸馏失败、超限或引擎不可达 MUST NOT 阻塞 L0 capture / L1 交接 / MCP 面——L2 是纯后台车道。

#### Scenario: 修正以 supersede 表达

- **WHEN** 引擎对既有经验 E1 判 UPDATE，产出新经验 E2
- **THEN** E2 写入并携带 supersedes 指向 E1，E1 仍在原处且内容未变

#### Scenario: 事实层合并同主体薄记录

- **WHEN** 一段新会话产出的 fact 草稿经 reconcile 关联到既有 fact F1（同主体）
- **THEN** 落一条新 fact 页携带 supersedes 指向 F1，F1 原样保留；该批不再额外新增无关联 fact 超出上限

#### Scenario: 薄 fact 限流可审计

- **WHEN** 单次蒸馏的 fact 草稿超过上限
- **THEN** 仅保留上限内的条目，超出部分以 llm_calls 审计 warning 记录，无静默丢弃

#### Scenario: L2 停摆不影响 L0/L1

- **WHEN** 蒸馏 sidecar 不可达或预算耗尽
- **THEN** capture、交接、查询全部照常，缺口被记录，恢复后从原 cursor 续跑

#### Scenario: 产物脱敏

- **WHEN** 会话观测里含密钥类内容并被蒸馏
- **THEN** 落盘的 fact / experience 页面正文与 details 均为脱敏后文本
### Requirement: 调度按会话边界触发且去抖，预算按 owner 限额

调度器 SHALL 在会话边界（session-end / stop 批末）标记待蒸馏 scope 并去抖合并，辅以定时批兜底扫描 cursor 落后的 scope；同一 scope MUST NOT 并发蒸馏。每 owner 的蒸馏用量 SHALL 按日限额（可经部署配置调整），用量按 owner 归因入账；超限即停、记录缺口，次日自动续。计费真源不变（sub2api / 词元车道账单），本预算为护栏非对账。

蒸馏范围 SHALL 覆盖包根（`d-`）与人根（`u-`）：人根受部署级开关 `FD_MEMORY_DISTILL_U`（`=0` 时完全不进触发与扫描，行为与未启用字节等同，默认启用）。蒸馏原料 SHALL 含会话观测、handoff、以及人根的 note 页（以 observation 形状合成条目，`tool=memory_write_page`，含标题与正文摘录），note 游标随蒸馏推进、不重蒸馏。兜底扫描对无观测的人根 SHALL 经页索引发现 project。

MCP 写面成功写入蒸馏原料（note 页、handoff）SHALL 即时通知调度器标记该 project 待蒸馏（进程内可选回调，未接线方零行为变化），人根走短去抖（约 60 秒，对比包根会话边界的 5 分钟）——写后蒸馏在约 2 分钟内可用；通知与兜底扫描相互独立（通知丢失不丢原料，游标幂等防重蒸馏）。

#### Scenario: 会话结束去抖触发

- **WHEN** 同一 scope 短时间内多个会话相继结束
- **THEN** 去抖窗口内的会话合并为一次蒸馏，cursor 一次前进

#### Scenario: 日预算超限即停次日续

- **WHEN** 某 owner 当日蒸馏用量达到限额
- **THEN** 该 owner 的蒸馏停止并记录缺口，L0/L1 不受影响，次日从保留的 cursor 自动继续

#### Scenario: 人根 note 进蒸馏且不重蒸馏

- **WHEN** 某人根 project 存在 note 页（含蒸馏后新写的 note）且兜底扫描周期到达
- **THEN** 新 note 以 observation 形状条目进入蒸馏原料，产出 L2 后 note_cursor 前进；再次扫描不重复提交已游标过的 note

#### Scenario: 部署开关关闭零行为

- **WHEN** `FD_MEMORY_DISTILL_U=0` 时兜底扫描与触发到达
- **THEN** 人根不进入待蒸馏集合（无蒸馏调用、无 token 消耗），包根蒸馏行为不变

#### Scenario: 写触发短去抖

- **WHEN** 某 u- 根经 MCP 成功写入一条 note
- **THEN** 该 project 在去抖窗口（约 60 秒）后被标记待蒸馏并在约 2 分钟内蒸馏（对比兜底扫描的 10 分钟周期）；60 秒窗口内的连续写入合并为一次蒸馏

### Requirement: 引擎 #1 是受 pin 的开源 sidecar，三集成条件生效

引擎 #1 SHALL 为独立 sidecar 服务（与 fd-memory 同 namespace 部署），pin 开源 Hy-Memory 版本、仅取其纯函数面（抽取 / reconcile / 提示词 / 解析器）， Chroma / Kuzu 等存储依赖装而不用；LLM 调用仅经词元车道（不直连任何第三方端点）。S1 裁决的三条集成条件 MUST 生效：C1——模型原文先经 json_repair 再解析（解析失败不得静默丢段）；C2——`task` / `search_keys` 与会话同语言（提示词钉 + 产物后检）；C3——每次 LLM 调用记录在案（`llm_calls` / `tokens` / `errors` 上报，引擎吞掉的失败由 sidecar 显性化）。

sidecar SHALL 另暴露 `POST /embed`（与 /distill 同一共享令牌互信）：批量输入（上限 64 条文本）返回向量数组，调用记入调用方的 `llm_calls`（stage=`embed`）、tokens 计入 distill 预算口径；嵌入模型 SHALL 钉扎（env 配置，当前 `Qwen/Qwen3-Embedding-8B`，dim 4096），响应携带模型名。

#### Scenario: json 损坏段不丢

- **WHEN** 模型输出含未转义引号等可修复的 JSON 损坏（S1 遍 1 s02 形状）
- **THEN** json_repair 后解析成功，该段经验不丢失

#### Scenario: task 语言与会话一致

- **WHEN** 中文会话被蒸馏
- **THEN** 产出的 experience.task 与 search_keys 为中文（评测以「task 语言 = 会话语言」断言钉住）

#### Scenario: 网关抖动显性化

- **WHEN** 词元车道超时连续失败（S1 遍 1 s08 形状）
- **THEN** DistillResult.errors 记录失败、cursor 保留，而非静默返回空产出

#### Scenario: 批量嵌入留痕计费

- **WHEN** 调度器以 5 条文本调用 /embed
- **THEN** 返回 5 条向量（带模型名），调用方 llm_calls 出现 stage=embed 的行，tokens 计入当日预算
### Requirement: 评测 v1 进 CI 且引擎变更必跑

评测 SHALL 在 v0（交接召回率）之上扩展为 v1：蒸馏产物的任务关键词命中、`task` 语言断言、事实 QA 抽样；引擎版本、提示词或候选检索变更 MUST 跑评测后才可合入。CI 常跑零 LLM 档（确定性断言：页型、layer/sources、预算闸、supersede、forget）；LLM 档在有车道凭据的环境按需跑并输出基线数字。

#### Scenario: 零 LLM 档进 CI

- **WHEN** CI 运行 fd-memory 测试
- **THEN** 页型 / supersede / 预算 / 可见性断言全部确定性执行，不依赖任何 LLM

#### Scenario: 引擎升级过评测门

- **WHEN** hy-memory pin 版本或提示词补丁变更
- **THEN** LLM 档评测跑出基线对比数字后才可上产

### Requirement: subject 覆盖判定走规范化等值与语义判定双路

事实层 reconcile 的主体覆盖判定 SHALL 先经规范化等值（大小写、空白、全半角、首尾标点归一）——机器标识符类 subject 在此路即判同；不等时 SHALL 经同一车道的一次结构化 LLM 判定（提示词以边界补丁注入，判定结果可从 llm_calls 审计还原）；两路都不过才判为不同主体。判定 MUST 只影响 reconcile 的归并决策，MUST NOT 改写产物的 subject 字段。

#### Scenario: 机器标识符走等值路

- **WHEN** 两个 subject 仅为大小写或空白差异（如路径、域名、邮箱）
- **THEN** 规范化后判同主体，不发起 LLM 判定调用

#### Scenario: 中文短语漂移走语义判定

- **WHEN** 两个 subject 指同一实体但措辞不同（S1 原例：`cheap-2 deploy/agent-api` vs `cheap-2 上的 deploy/agent-api (namespace serving)`）
- **THEN** LLM 判定判同主体，reconcile 归并为一条 supersede 链

#### Scenario: 判定不改写产物

- **WHEN** 语义判定把两个 subject 判同
- **THEN** 新页保留引擎原产出的 subject 字符串，supersedes 指向旧页

### Requirement: 候选检索向量优先、关键词兜底、模型钉扎

蒸馏候选检索 SHALL 优先向量余弦：查询文本（近期观测摘要）经 sidecar 嵌入后，与既有候选的伴随向量（蒸馏落库时由 sidecar 随 DistillResult 产出、fd-memory 存 SQLite 伴随表——markdown 真源与派生索引不变）计算余弦取 top-8；无向量的候选（历史页 / 嵌入失败）MUST 按现有关键词路径并入兜底，两条路径的结果合并去重。向量 MUST 带模型标注：候选向量与查询向量的模型或维度不一致时该候选 MUST 落关键词兜底并记 gap，MUST NOT 跨模型比余弦。重嵌 SHALL 经提供的一次性脚本按模型过滤执行，MUST NOT 自动全量重嵌。

#### Scenario: 同义不同词命中向量检索

- **WHEN** 新观测的任务描述与既有经验语义相同但关键词不重叠（如「推镜像失败」vs「registry 上传被拒」）
- **THEN** 向量路径将该经验排入候选集，reconcile 得以判 UPDATE 而非重复 ADD

#### Scenario: 无向量候选走关键词兜底

- **WHEN** 候选集中部分页无伴随向量（v2.2 之前的存量页）
- **THEN** 这些页经关键词路径参与候选，与向量结果合并去重，检索不因向量缺席而漏召回

#### Scenario: 模型不一致不比余弦

- **WHEN** 查询嵌入模型与某候选的伴随向量模型不同（换模后）
- **THEN** 该候选落关键词兜底并记 gap，绝不跨模型计算余弦

### Requirement: 产物打标支线（tags 与 tier 候选）

fd-memory 蒸馏器 SHALL 对 reference 类条目给 tags 提议（≤5 个语义标签）与 tier 晋级候选判断；所有打标产物 MUST 标记为「AI 提议」来源；打标 MUST 受主人维度的日预算门控制（超门即延迟到下一窗口，不抗拒质量），且已在 ADR 预算门纪律之内；不依赖新外部服务。

**晋升候选的选材范围**：tier 晋级候选 SHALL 覆盖蒸馏产出的 L2 页型（fact、experience）与 reference 页型；选材 MUST NOT 以「是否已有 tag」为排除条件（已有 tag 的页仍可能该晋级），MUST 排除已达 `stable` 及以上的页。原「只对无 tag 的 reference 页提议」的范围限制取消——生产实测该范围仅覆盖 10 个 reference 页（其中 9 个已有 tag），使 tier 阶梯 99.8% 的页永远停留在 draft。

**AI 提议不直接晋级**：AI 产出的 Tier 晋级判断 MUST 作为「待确认提议」登记，MUST NOT 直接改写页的 tier；提议落定需人接受。AI 判断的最高落定层级为 `stable`，指向 `canonical` 时 MUST 降级为 `stable`；`tier_origin = human` 的页 MUST NOT 被 AI 提议覆盖（与既有封顶纪律一致，本次不放松）。

#### Scenario: auto capture 的草稿第二天有 tags

- **WHEN** 一新建 reference 页过打标窗口且无人类修正
- **THEN** 页上 tags 已就位、来源记 AI 提议，budget 摘要归因

#### Scenario: 预算门触发时的姿态

- **WHEN** 当 owner 日打标预算耗尽
- **THEN** 当批 reference 只登记不打标，下一窗口重补，不重跑已标条目

#### Scenario: 已打 tag 的 fact 进入晋升候选

- **WHEN** 一个 fact 页已有 tags 且 tier 仍为 draft
- **THEN** 该页进入晋升候选，不因其已有 tag 被排除

#### Scenario: 已达 stable 的页不再提议

- **WHEN** 一个 experience 页 tier 已是 stable
- **THEN** 它不进入晋升候选，避免重复提议

#### Scenario: AI 不直接提升 draft

- **WHEN** AI 判定某 draft 页值得升 stable
- **THEN** 该页 tier 保持 draft 直到人接受提议，提议本身记 AI 来源
### Requirement: 修正回灌学习词表

人类/AI 对 tag 或 tier 的修正 SHALL 写为 correction note（含改前改后与来源）；后续打标 SHALL 在读同一 owner 的近期 correction 后适配词表与判定，避免重写同样的判读；蒸馏产物可向下修正但禁止覆盖人类确认位未推翻的决定。

#### Scenario: 用户改 tag 后新知识生效

- **WHEN** 用户把 tag「合同」改为「章程」后同主题新 reference 打标
- **THEN** 新 tags 贴近用户词表（优先「章程」），原修正 note 仍可查
