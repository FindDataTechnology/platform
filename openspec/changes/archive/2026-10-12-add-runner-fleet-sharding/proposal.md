# Proposal: add-runner-fleet-sharding

## Why

萬星蓝图的硬前提（2026-10-11 用户拍板）：agents 必须**多机部署**且能**相互协同**。协同面已建好（agent 互调全部经 facade 的 A2A/委派/mission 派发，HTTP 中介，天然跨机）；多机面卡在 registry.js 自己注释里写明的 v1 假设——「每个 runner 托管全量 agent」（descriptor 无 runner 归属字段）。今天起第二台 runner 只会全量重复托管，不是分工。M2 容量实测已证明单机（cheap-1，768MB 诚实预算）只能承载 3-5 个并发任务；分片是多机扩容与夜间批量的唯一路径。

## What Changes

- **归属字段**：部署 descriptor 新增 `metadata.runner_id`——注册处 metadata 本就是 `dict[str, Any]`（已核 pydantic），零注册处改动。
- **runner 过滤**：`listServedAgents` 只托管分给自己的条目；`AGENT_RUNNER_DEFAULT_ID`（缺省=自身 FLEET_ID）让存量 runner 无感兼容——未标注条目仍归默认 runner，存量 6 agent 零迁移。
- **部署侧**：平台 packs 库新增 `agent_runners` 表（id/base_url/port_base/port_span），boot 时按 env 种子 cheap-1 行；deploy API 接受可选 `runnerId`，按所选 runner 计算 per-agent 服务 URL（该 runner 的 base/span）并打 `runner_id` 标。
- **内部面**：`GET /api/packs/internal/runners`（服务凭据门）供 console/facade 读机群。
- **第二台 runner**：fd-infra-deploy 新增 `agent-runner-b`（k8s hostNetwork Deployment，独立端口段 8851-8882、独立内存上限），与 cheap-1 组成双机机群。
- **协同实证**：分片后跨机调用（facade 路由到 runner-b 的 agent）+ planner（cheap-1）跨机派发可通——蓝图的「多机 × 协同」两根柱子同时落地。

## Capabilities

### Modified Capabilities

- `a2a-agent-serving`：新增 requirement——部署带 runner 归属（表+种子+API+URL 计算）。
- `agent-runner`：新增 requirement——runner 只托管分给自己的条目（缺省兼容语义）。

## References

- registry.js:26-28 的 v1 注释（本 change 的直接动因）
- M2 容量实测（2026-10-11）：单机 768MB≈3-5 并发
- ADR-0018（runner ships in platform image——本 change 不改镜像载体，新增独立部署单元）
