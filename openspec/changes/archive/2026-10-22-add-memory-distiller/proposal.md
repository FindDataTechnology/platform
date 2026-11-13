## Why

L0 观测与 L1 交接是零 LLM 的即时记录，但集群长期运行后「agent 学到了什么」仍散在成百上千条观测里，下一会话无法直接复用；10-19 底稿 D6 把 L2 蒸馏排在最后，ADR-0030 D2 定案引擎开源可插拔，首选 Hy-Memory working 场景抽取器——`CodingMemoryExtractor.extract()` 是不碰存储的纯函数（`hy_memory/coding/extractor.py:785-816`），输入 OpenAI 格式 messages、输出事实草稿与经验草稿，依赖仅 stdlib + openai，提示词中英双语自动路由。把它作为无状态 sidecar 跑在词元 LLM 车道上，产物写回我们的 OKF 页型，就得到「底座自有、引擎开源」的 L2。

**门：Spike S1（2 天硬上限）过门才 apply**——用 20 段真实转录（spider-heal 与集群回合，脱敏）跑 Hy-Memory 抽取器，量抽取质量、每会话 token 成本、中文命中、`subject` 覆盖判定稳定性；裁决写入本 change 的 design.md。不过门则评估备选（mem0 单遍 / TencentDB memory-core 按 owner instanceId）。

## What Changes

- **Distiller 契约**（fd-memory）：`DistillRequest{scope, cursor, items(自 cursor 起的 observation/handoff/note 页), candidates(按 subject/search_keys 检索的既有 fact/experience)}` → `DistillResult{facts[], experiences[], cursor_next, llm_calls, tokens}`；幂等（cursor 单调，同 cursor 重跑产出等价）、永不删页只写新页 + `supersedes[]`、失败不阻塞 L0/L1、产物 `generated.by = engine:<name>/<ver>`。
- **新页型**：`fact{statement, subject, files[], details(原文直取 ≤4000), sources[], supersedes[], confidence, expires_at?}` 与 `experience{task, search_keys[], solution, boundary_envs, confidence, sources[], supersedes[]}`；`reindex` 识别；`memory_query` / `memory_recent` 结果带 `layer`（L0-L2）与 `sources[]`。
- **引擎 #1 sidecar**：Python 容器 `fd-memory-distiller`，pin `hy-memory` 版本，仅 import `coding.extractor` + `agent.llm_provider` + `config` + `pipelines.base`（Chroma/Kuzu 装而不用）；reconcile 用 `build_experience_reconcile_prompt()` + `_parse_ops` 对我方 candidates 出 ADD/UPDATE/DELETE/SKIP → 映射为 supersedes；LLM 走词元车道（`LLM_API_KEY` 路由，DeepSeek 端点），专训 30B-A3B 不上。
- **调度与预算**：会话结束触发 + 定时批（去抖）；每 owner 日 token 预算表，超限即停并记录缺口；用量按 owner 归因，计费真源仍是 sub2api。
- **可见性**（API 侧）：owner 范围的 scope / 层 / 时间筛读接口与 `forget`（逻辑删 + 索引剔除）；萬星 console UI 为 fd-wanxing 姊妹 change。
- **评测 v1**：在 `add-memory-scopes-and-cluster-sharing` 的 v0（交接召回率）上加事实 QA 正确率与接续成功率（LLM-judge + 人工抽样）；引擎/提示词/检索变更必跑。
- **明确不做**：L3 画像/schema evolve（v4）；向量检索（v2.2，但页型已为其预留）；memory-proxy 式 LLM 热路径拦截；任何跨 owner 可见性。

## Capabilities

### New Capabilities

- `memory-distiller`: L2 蒸馏引擎契约——输入输出形状、幂等与 supersede 纪律、每 owner 预算与降级、引擎可替换与产物溯源。
- `memory-visibility`: 部署者对自己 owner 根下记忆的读取面与 forget——按 scope / 层 / 时间，审计可查，agent 默认不读 owner 级。

### Modified Capabilities

- `fleet-memory`: 「零 LLM 边界」→ L0/L1 零 LLM 不变，L2 仅经 Distiller 契约在后台限额写入；「存储为 OKF 兼容真源且派生索引可重建」→ 新增 fact / experience 页型，reindex 覆盖；「MCP 工具面按 namespace 收窄」→ 读结果带 layer 与 sources。

## Impact

- 新服务：`fd-memory-distiller`（Python，出片走通用池 + `fd-build-channel` 纪律，cheap 集群与 fd-memory 同 ns）；fd-memory 增 candidates 检索、预算表、调度器、可见性路由。
- 外部依赖：`hy-memory`（Apache-2.0，公开仓库仅 10-15 起、63 commits——pin 版本、fork 纪律同 sub2api-fork-patches：只在契约层对齐，不在代码层耦合）；词元 LLM 车道用量上升（每会话 3-4 次调用、中文提示约 1 万字）。
- 安全：L2 产物过既有四类脱敏；`details` 原文直取同样脱敏；LLM 端点只经词元车道，不直连第三方。
- 顺序：依赖 `add-memory-scopes-and-cluster-sharing`（Scope、审计表、评测 v0）；S1 裁决前不 apply。
- 回滚：停 distiller 部署即止；已写 L2 页按 `generated.by` 批量删除 + `reindex`。
