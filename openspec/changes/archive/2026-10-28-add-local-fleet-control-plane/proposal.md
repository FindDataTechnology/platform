# add-local-fleet-control-plane — 本地多智能体集群控制面（Win/Mac）

## Why

「用户能在 Windows/Mac 本地运行**和管理**多智能体集群」是已拍板的本期目标（2026-10-28 五决策：A/B 两系都做、离线供给纳入、常驻纳入、双平台见证）。现状盘点（explore 2026-10-28）坐实：执行面已在桌面建制内（`desktop-fleet-runner`：预装插件、`WANXING_PLUGIN_ENABLED=1` 即成本机席位），**管理面是唯一的硬缺口**——roster 真源在公共 registry、部署写动作走云端、配对是唯一管理入口，stock 桌面不开 registry 时 runner 是零编目空席位；舰队页自封 read face（「目录只读不含部署动作，待设备管理面解锁」）。本 change 就是那个「设备管理面」：把 roster 真源与写动作收回 cell 本机，让本地集群脱离云端闭环可用。

## What Changes

- **本机 roster 真源（新）**：cell server 新增本地 registry 兼容 feed——从「已安装 pack 的 serving 声明 + 本机部署记录表」合成条目，以 agent-runner registry 客户端已消费的端点形状与分页语义透出，runner **零改造**、只换指针。
- **零配置默认**：`wanxingEnabled` 且未设 `AGENT_SERVING_REGISTRY_URL` 时，supervisor descriptor 注入本机 feed 地址与 first-run mint 的本机令牌；stock 桌面开插件=有编目，不再是空席位。外部 registry 配置存在时行为一个字节不变。
- **舰队页 read face → write face**：`/api/wanxing/fleet/` 新增部署写面（deploy / stop / start / remove），FleetPage 目录区部署入口解锁（解除原 spec 的禁用态要求）；UI 明确分区「本机集群（可写）/ 已配对云席位（只读桥）」。
- **配对降级为可选桥**：6 位码配对保留，但从「唯一管理入口」降为「云席位只读桥」；未配对不再意味着本地集群不可管。
- **容量闸诚实化**：runner `AGENT_RUNNER_MAX_CHILDREN`（默认 4）进入部署契约——超限部署返回结构化 `capacity_exceeded`，UI 引导卸载腾出，不静默排队。

关联姊妹 change（同批立案）：`add-offline-pack-supply`（供给离线化，本 change 的 e2e 样例包来源）、`add-desktop-residency-hardening`（常驻兜底）、`polish-desktop-fleet-parity`（A 系桌面收尾）。双平台验收乘 `automate-nonweb-acceptance` 的在途 installer-e2e 轨，不新建车道。

## Capabilities

### New Capabilities

- `local-agent-registry-feed`: cell 侧本机 roster feed 的契约——端点形状与鉴权、条目从安装态+部署表合成、`runner_id`/`desktop_seat` 打标、摘除与恢复语义、与云 registry 的读面同构。

### Modified Capabilities

- `desktop-fleet-runner`: 新增「本地 roster 源」要求——插件启用且未配置外部 registry 时，runner 指向 cell 本机 feed 而非零编目；seat id 既有纪律不变。
- `desktop-fleet-console`: 「目录只读不含部署动作」要求改写为写面要求——部署/启停/移除经 cell 本地写面闭环，目录默认吃本地 feed，配对从必经降为可选；read face 既有降级语义保留。

## Impact

- **代码**：`server/routes/wanxing-fleet.js`（写面路由）、新 `server/local-agent-feed.js`（feed 端点）、`db.js`（部署记录表迁移）、`lib/agent-serving.js`（条目合成复用，不改其行为面）、`supervisor/descriptors.js`（本地 feed 注入）、`web/src/pages/FleetPage.tsx`（写面 UI）。
- **契约**：cell 新增 `/api/agents` 兼容端点（本机令牌鉴权）与 `/api/wanxing/fleet/deployments*` 写端点；agent-runner 零依赖变更（仍是 registry 客户端）。
- **既有行为**：配置外部 registry 的部署零变化；云席位分片防呆（`cloud-default` 永不匹配本机 seat id）不变。
- **测试**：新增 feed/写面合同测试；e2e 乘在途 installer-e2e 轨加本地集群一幕。
