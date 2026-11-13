## Purpose

L2 蒸馏：把零 LLM 的 L0 观测 / L1 交接在后台限额地蒸馏为可跨会话复用的事实（fact）与经验（experience），引擎可替换（契约层对齐开源引擎，不耦合其代码）、永不删页只 supersede、全程可溯源可回滚。

## ADDED Requirements

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

蒸馏产物 SHALL 以新页写入（fact / experience 页型），当产物是对既有条目的修正时 MUST 写新页并携带 `supersedes[]` 指向被修正页，被修正页保持原样（历史可溯）；蒸馏 MUST NOT 删除或改写任何既有页。产物正文与 `details`（原文直取，上限 4000 字符）MUST 过既有四类脱敏后才落盘；`sources[]` MUST 引用产出它的 item 坐标。蒸馏失败、超限或引擎不可达 MUST NOT 阻塞 L0 capture / L1 交接 / MCP 面——L2 是纯后台车道。

#### Scenario: 修正以 supersede 表达

- **WHEN** 引擎对既有经验 E1 判 UPDATE，产出新经验 E2
- **THEN** E2 写入并携带 supersedes 指向 E1，E1 仍在原处且内容未变

#### Scenario: L2 停摆不影响 L0/L1

- **WHEN** 蒸馏 sidecar 不可达或预算耗尽
- **THEN** capture、交接、查询全部照常，缺口被记录，恢复后从原 cursor 续跑

#### Scenario: 产物脱敏

- **WHEN** 会话观测里含密钥类内容并被蒸馏
- **THEN** 落盘的 fact / experience 页面正文与 details 均为脱敏后文本

### Requirement: 调度按会话边界触发且去抖，预算按 owner 限额

调度器 SHALL 在会话边界（session-end / stop 批末）标记待蒸馏 scope 并去抖合并，辅以定时批兜底扫描 cursor 落后的 scope；同一 scope MUST NOT 并发蒸馏。每 owner 的蒸馏用量 SHALL 按日限额（可经部署配置调整），用量按 owner 归因入账；超限即停、记录缺口，次日自动续。计费真源不变（sub2api / 词元车道账单），本预算为护栏非对账。

#### Scenario: 会话结束去抖触发

- **WHEN** 同一 scope 短时间内多个会话相继结束
- **THEN** 去抖窗口内的会话合并为一次蒸馏，cursor 一次前进

#### Scenario: 日预算超限即停次日续

- **WHEN** 某 owner 当日蒸馏用量达到限额
- **THEN** 该 owner 的蒸馏停止并记录缺口，L0/L1 不受影响，次日从保留的 cursor 自动继续

### Requirement: 引擎 #1 是受 pin 的开源 sidecar，三集成条件生效

引擎 #1 SHALL 为独立 sidecar 服务（与 fd-memory 同 namespace 部署），pin 开源 Hy-Memory 版本、仅取其纯函数面（抽取 / reconcile / 提示词 / 解析器）， Chroma / Kuzu 等存储依赖装而不用；LLM 调用仅经词元车道（不直连任何第三方端点）。S1 裁决的三条集成条件 MUST 生效：C1——模型原文先经 json_repair 再解析（解析失败不得静默丢段）；C2——`task` / `search_keys` 与会话同语言（提示词钉 + 产物后检）；C3——每次 LLM 调用记录在案（`llm_calls` / `tokens` / `errors` 上报，引擎吞掉的失败由 sidecar 显性化）。

#### Scenario: json 损坏段不丢

- **WHEN** 模型输出含未转义引号等可修复的 JSON 损坏（S1 遍 1 s02 形状）
- **THEN** json_repair 后解析成功，该段经验不丢失

#### Scenario: task 语言与会话一致

- **WHEN** 中文会话被蒸馏
- **THEN** 产出的 experience.task 与 search_keys 为中文（评测以「task 语言 = 会话语言」断言钉住）

#### Scenario: 网关抖动显性化

- **WHEN** 词元车道超时连续失败（S1 遍 1 s08 形状）
- **THEN** DistillResult.errors 记录失败、cursor 保留，而非静默返回空产出

### Requirement: 评测 v1 进 CI 且引擎变更必跑

评测 SHALL 在 v0（交接召回率）之上扩展为 v1：蒸馏产物的任务关键词命中、`task` 语言断言、事实 QA 抽样；引擎版本、提示词或候选检索变更 MUST 跑评测后才可合入。CI 常跑零 LLM 档（确定性断言：页型、layer/sources、预算闸、supersede、forget）；LLM 档在有车道凭据的环境按需跑并输出基线数字。

#### Scenario: 零 LLM 档进 CI

- **WHEN** CI 运行 fd-memory 测试
- **THEN** 页型 / supersede / 预算 / 可见性断言全部确定性执行，不依赖任何 LLM

#### Scenario: 引擎升级过评测门

- **WHEN** hy-memory pin 版本或提示词补丁变更
- **THEN** LLM 档评测跑出基线对比数字后才可上产
