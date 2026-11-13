# Design: add-runner-fleet-sharding

## Context

现行拓扑（2026-10-11 核实）：生产唯一 runner = cheap-1 的 `agent-runner-dsh` 容器（FLEET_ID=cheap-1，端口段 8791+32，托管全部 6 个 serving agent）。部署链：平台 deploy 路由（gateway/packs.js）→ `deployToRegistry`（lib/agent-serving.js）以 env `AGENT_SERVING_RUNNER_URL` 为唯一 runner 基址，按 `agentPortFor(path)`（默认 8791/32）算 per-agent URL 写进注册条目，descriptor 随 `metadata` 自由透传（pydantic `dict[str, Any]` 已核）。runner 侧 `listServedAgents` 拉全量、无过滤（registry.js v1 注释）。

## Decisions

### D1 归属字段与过滤语义

- descriptor 增 `runner_id`（部署时写入 metadata）。**缺省语义**：无 `runner_id` 的条目归「默认 runner」（= 机群里那条种子行，cheap-1）。
- runner 配置 `AGENT_RUNNER_DEFAULT_ID`（config 缺省 = 自身 `AGENT_RUNNER_FLEET_ID`）——**存量 runner（cheap-1）不配任何新 env 即兼容**：未标注条目仍归它。**新 runner 必须显式设 `AGENT_RUNNER_DEFAULT_ID=<机群默认 id>`**（否则缺省=自身 id 会把未标注条目也吞进来——两台都设默认时未标注会双托管，部署 runner-b 时以此 env 一票定归属）。
- 过滤式：`(a.metadata.runner_id ?? defaultRunnerId) === runnerId`。

### D2 机群登记与部署寻址

- packs 库新表 `agent_runners(id TEXT PRIMARY KEY, base_url TEXT NOT NULL, port_base INTEGER DEFAULT 8791, port_span INTEGER DEFAULT 32, note TEXT DEFAULT '', created_at INTEGER)`。
- boot 种子：表空且 env `AGENT_SERVING_RUNNER_URL` 在 → 插 `id = AGENT_SERVING_DEFAULT_RUNNER_ID || "cheap-1"`（与该 runner 的 FLEET_ID 对齐——部署默认行为的 URL 与今天逐字节不变）。
- deploy 路由：body 可选 `runnerId`（缺省=种子/首行）；命中行→ `runnerBaseUrl=row.base_url`、`agentPortFor(path, {base: row.port_base, span: row.port_span})`、descriptor 打 `runner_id=row.id`。表空回退 env 路径（升级窗口不断部署）。
- 内部面 `GET /api/packs/internal/runners`（registry token 门）。

### D3 第二台 runner（agent-runner-b）

- fd-infra-deploy 新 Deployment：镜像 platform 同版、command `node agent-runner/index.js`、**hostNetwork**（注册处经节点 tailscale IP 直连 per-agent 端口，与 cheap-1 同法）、端口段 `AGENT_RUNNER_PORT_BASE=8851/SPAN=32`（与 cheap-1 的 8791-8822 不相交）、`AGENT_RUNNER_FLEET_ID=runner-b`、内存上限 2G、env/凭据从 cheap-1 的 runner env 平移（registry/backend/fleet token、LLM 网关键、PACKS_URL）。
- 落位节点：选余量 ≥2.5G 的 k8s 节点。

### D4 协同跨机不变式

agent 互调全部经注册处代理→目标 runner 的 per-agent 端口（HTTP），mission 派发/委派/search_agents 同理——分片不改任何协同路径，只改代理落点。实证=board 出现双 runner + 一个部署到 runner-b 的 agent 被 cheap-1 上的 planner 经 facade 调通。

## Risks / Trade-offs

- **端口冲突**：两 runner 若同节点且段相交——B 段独立（8851+32）规避；部署原子性由注册条目单写保证。
- **种子对齐**：种子 id 必须等于 cheap-1 的 FLEET_ID，否则存量未标注条目被新默认行为误迁——D2 已锁（缺省 env 与字面量都指向 cheap-1）。
- **runner-b 的 LLM 键**：与 cheap-1 同源（运营网关键）——成本面不变，额度共享。

## Migration Plan

代码全向后兼容：过滤对 cheap-1 无行为变化（未标注=归它）；表+种子让部署默认逐字节不变；runner-b 为纯新增部署。上线序：镜像（含过滤+部署改动）→ cheap-1 容器同版重建（无行为差）→ agent-runner-b 上线 → 一个 agent 指到 runner-b 实证。
