# Design: add-dsh-pod-adapter

> 依据：docs/wanxing-multi-harness-runtime-explore.md（切片②）＋本轮源码复读
> （agent-runner/{manager,child,compose,a2a,config}.js、dsh-profile-template/
> platform-preset-bridge.js、platform-tool-scope.js、dsh-matrix 0.2.0-rc.2 的
> dsh-sdk-jsonrpc-server/lib/index.js）。未决问题 4（密度档）在此给保守起步答案；
> 1/2/3 归切片 ③/⑤。

## D1 判读订正：收尾串行化是进程级的（pod 纪律的根据）

底稿「结构性解 = 每会话一个 agent 上下文」不成立，两件源码/实证：

1. stock `HarnessSdkJsonRpcServer.createSession` 与我们的桥 `#createSessionInner`
   **都是每会话一个 agent 上下文**（各自 `ctx.agents.create({sessionId…})`，
   dsh-matrix 0.2.0-rc.2 源码 218-231 行 + 桥 254-265 行）。
2. probe-concurrent-turn-close 的 A/B 两会话**本就各持独立 agent 上下文**，
   0.2.0-rc.2 / 0.2.1-a1 上 B 的收尾照样饿死。

结论：回合收尾的串行面在**进程**，不在 agent 上下文。推论：

- pod **不能**承诺成员回合独立收敛——一成员的慢回合会队首阻塞其他成员回合的收尾
  （派发并发、收尾串行；释放后干净收敛，无楔死——探针实证）。
- 后台续跑（切走不取消）**不因 pod 解锁**；它等的上游改动是会话驱动层，不是形态层。
- pod 的吞吐纪律因此是设计的一部分：**每 pod 在途回合上限，默认 1**
  （`AGENT_RUNNER_POD_MAX_INFLIGHT`），排队不失败、不抢占。solo 模式今天就是
  多会话共进程，生产行为不变。
- 密度档（未决问题 4）v1 答案：**默认 solo（pod 模式 runner 级 opt-in、默认关）**，
  面向长尾 pack；高流量/高隔离 agent 永远有 solo 档。默认翻转待生产实证。

docs/wanxing-multi-harness-runtime-explore.md 随本 change 补此订正。

## D2 共宿键与资格门（fail-open 到 solo，永不拒绝部署）

- **共宿键 = pack 部署**（同 runner 轮询切片内、`descriptor.packId` 相同的 serving
  entries 一组）。podKey = `pod-<packId>`（目录名与 children 键同源）。
  **跨 owner / 跨 pack 永不共宿**（硬约束，spec 钉死）。
- **资格门**（分组时逐 pack 检查，任一不过 → 全员 solo 回退）：
  1. billing key 一致：成员的 `billing_key_ref` 全同或全无（`applyBillingKey` 是
     整仓覆写式单写，两把 key 无法共存一个 home）。
  2. secret 同名同 ref：跨成员同名 `secret_refs` 必须同引用（否则最后写者胜=错）。
  3. runtime 能力：spawn 后 `platform/capabilities` 须含 `preset/set`、`model/set`、
     `session/cancel`（老 child 缺法 → 该 pack 回退 solo，pod 停止）。
- 资格门在 reconcile 分组与 spawn 后各判一次（前者省事、后者防 capabilities 漂移）；
  判定结果落 health 与日志（`pod-ineligible:<reason>`），部署面零感知。

## D3 桥 per-session persona：`preset/set`（parked-only）

镜像 `model/set` 已有的 parked 机制，新增 live method：

- `preset/set {sessionId, presetId}`：校验 presetId 非空字符串；若 `sessions` 已有该
  会话的活 agent → 结构化错误（「persona is creation-time composition; start a new
  session」）；否则存入 `#pendingPresets`。
- `#createSessionInner` 解析顺序：`#pendingPresets.take(sessionId)` →
  `this.agentPresetId`（initialize）→ 注册表默认。resolve 失败（未知 id）在创建前
  抛错、整体回滚——与现有 initialize-time preset 同一合同（探针合同⑩已钉）。
- 会话头 `meta.agentPreset` 记实际挂载 id（现有行为，parked 亦然）。
- `LIVE_METHODS` 增加 `preset/set`；`platform/capabilities` 自动带出。
- **不做**活会话换 persona：dsh 的受支持 mount 点是创建期 `setup`；如需「换人设」
  语义=开新会话（上层 contextId 变更即得）。

## D4 pack home 物化：`materializePackHome`

新函数（compose.js），复用现有 writer、零格式漂移：

- home = `<homeRoot>/pod-<packId>`；scaffold 种子与 solo 相同。
- **presets**：N 行 persona preset（现 `extraPresets` 参数本就收数组；每成员
  `rosterPresetId('srv-<packId>-<agentId>')`，与 solo 同名同 id——升级迁移时
  同一 agent 的 preset id 不变）；`default` 取第一成员或 `standard`。
- **skills/MCP 并集**：同 pack 内 skill 名与 registryName 本就 pack 级唯一，直接并；
  MCP 行按 name 去重（同 pack 引用同一定义）。
- **secrets 并集**：D2 门保证同名同 ref；fetch 全员后一次 `applyDeploymentSecrets`。
- **billing key**：成员一致时取该 ref 一次、单写。
- **tool-filter 扩展 per-preset 段**（platform-tool-scope.js + writeToolFilterPatch）：
  文件形状增可选项 `{ mcpTools: <并集>, byPreset: { <presetId>: { mcpTools: … } } }`。
  进程级 guard/shadow 读并集（upper bound：不挡任何成员需要的工具）；
  `applyMcpToolRestrict(agentCtx)` 在 setup 内按该会话实际挂载的 presetId 取
  `byPreset` 段算 deny（成员精确面）。旧形状（无 byPreset）语义不变=全 home 单过滤。
- **workspace**：任一成员声明即建 `<home>/data`，env 注入同现状（pod 级共享数据卷，
  同 pack 语义成立；quota 取成员声明最大值）。cwd 规则同现状。
- 升级：`rmSync` 仅 skillsRoot 重写并集；presets/mcp/filter 全量重写（幂等）。

## D5 会话命名空间与外部上下文 reap

- child 面（pod child，见 D6）：wire 会话 id = `<agentKey>--<sessionId>`
  （`agentKeyFor` 产物本就是 `[A-Za-z0-9._-]`，`--` 作分隔符；`sessionKeyFor`
  产物以 `srv-` 开头，前缀后仍可判别）。确定性映射：同 (member, contextId) 恒同 id，
  跨 pod 重建续话（home/会话盘存）不受影响。
- `isActive`/collectors 以 wire id 为键（child.js 现有 Map 语义不变）。
- **reap 含匹配坑**：`reapExternalContexts` 现以 `startsWith("srv-wx-")` 识别外部
  上下文，前缀化后变成 `packs-x-a--srv-wx-…` 会被漏掉。改为「名字含 `srv-wx-` 段」
  匹配（split `--` 取尾段 startsWith），TTL/`parseReapWindow` 对尾段判——
  solo 目录名不含 `--`，行为不变（`srv-wx-…` 全名即尾段）。

## D6 manager pod 粒度（pod 模式分支，solo 路径不动）

- **分组**：reconcile 后按 `descriptor.packId` 分组（pod 模式且过 D2 前置门才成组）；
  `children` 键 = podKey；成员表 `pod.members: Map<agentKey, entry>`。
- **身份哈希**：成员身份（现 per-entry identity JSON）按键序合并为一个 pod identity；
  任一成员变 → 整 pod 排水重建（升级粒度=pack，spec 如实钉住）。排水窗口
  `drainMs` 照旧；重建后成员会话由盘存 resume（桥 `#isPersisted` 探测已备）。
- **acquire(entry)**：pod 模式定位 `pod-<packId>`；无则 `#spawnPod(members)`。
  冷启动重试阶梯（-32004）沿用，单位=pod——一成员冷启失败全员重试（如实记入风险）。
- **paused 成员**：`pausedKeys` 判定不变（回合入口拒 -32010）；pod 不因单成员暂停
  排水（其余成员照常）。
- **health**：成员条目 state 派生 = pod child 状态（starting/serving/resident/draining）
  ×成员自身 activeTurns；无 pod = warm。`port` 照旧 per-entry 派生（D8）。
- **fleet 事件**：`woken`（pod 起、逐成员发，reason 首触/回温按成员 everSpawned）、
  `reaped`（pod 降级、逐成员发）。meter 行 per-member 照旧（`turn()` 有 entry）。
- **child.js 扩展**：`AgentChild` 增 pod 用法——构造带 `members: Map<agentKey,
  {presetId, model, turnTimeoutMs, budgetLabel}>`；`turn(sessionId…)` 增可选
  `{agentKey}`，内部映射 wire id、首见会话先 `preset/set`+`model/set`（parked）再
  prompt；每成员预算覆盖 per-call；`activeTurns` 按 wire 会话计数（现逻辑即按
  collector，天然成立）。solo 用法（无 members）零变化。

## D7 回合纪律与预算取消

- **在途上限**：pod 模式 `manager.turn` 入口按 pod 计在途（pod.activeTurns），
  超过 `podMaxInflight`（默认 1）排入既有 slot-waiter 式等待——排队不失败、不抢占。
  delegation 槽（per-agent）照旧叠加。
- **预算**：pod 成员超时 → timer 触发即 `request("session/cancel", {sessionId: wire})`
  （桥 agent.cancel→whenIdle，10s 有界），随后回合以 -32001 结算、meter 记
  budgetKill；cancel 不收敛（10s 仍 running）→ 标记 budgetKilled，manager 兜底
  停 pod（最后手段）。solo 模式行为不变（进程停）。
- `-32005` 零输出、`-32003` 自报失败、`-32002` child 退出等结算路径对 wire id
  透明，无需分支。

## D8 端口与 serving 面：零改动（非目标，写明理由）

- v1 保留 **每 agent 一个 HTTP 监听**（a2a.js `createAgentApp` 照旧 per entry），
  端口派生/`port_override`/fleet 防撞全部不动——同一 pod 的成员各自监听、
  `manager.turn(entry)` 汇入同一 pod child。
- 「端口按 pod」需 registry A2A 代理保留 `/agent/{path}` 路径（现 drops path、
  一 agent 一 origin，upstream #1734），跨仓改动，留待后续切片；届时 span 天花板
  随 pod 数而非 agent 数计。v1 的 span 提升走既有 `AGENT_RUNNER_PORT_SPAN` 旋钮。

## D9 配置面（config.js）

| 键 | 默认 | 语义 |
|---|---|---|
| `AGENT_RUNNER_POD_MODE` | `0` | 0=solo（字节级现状）；1=同 pack 共宿（资格门内） |
| `AGENT_RUNNER_POD_COST_MB` | `160` | pod 地板价（warm-zone 预算回退值；M2 实测 boot 峰 172-185MB、稳态 89-116MB） |
| `AGENT_RUNNER_POD_MAX_INFLIGHT` | `1` | 每 pod 在途回合上限（D1 纪律） |

`maxChildren` 在 pod 模式语义 = 最大 pod 数（D6）；`agentCostMb` 仍用于 solo 记账。

## D10 验证策略

1. **单测**：manager 分组/资格门/合并身份排水/pod 记账；compose pack 物化（多
   preset 行、并集、byPreset 过滤形状）；桥 preset/set parked/拒绝/未知三条；
   会话命名空间与 reap 含匹配（含 solo 名回退）。沿用现有 fake-harness/注入工厂。
2. **合同⑯**（contracts.mjs）：真矩阵树双成员共宿——`preset/set`+`model/set`
   parked、各成员各 persona 标记/各模型请求、活会话拒绝、历史不互串；与 ①-⑭
   同报告同两轮绿标准。
3. **生产眼见**：一个双 serving agent 的 pack 在 pod 模式 runner 上共宿部署——
   单进程（ps 眼见）、双 persona 回合各归各、内存对照记录回底稿。出片滚版走
   既有 fd 线（GHA→hkccr→relay→ccr）。

## D11 风险与接受面

| 风险 | 接受/缓解 |
|---|---|
| 升级粒度=pack（任一成员变更整 pod 排水） | 接受：pack 部署本就同版本同源；排水窗口既有 drainMs 有界；重建后盘存 resume |
| 收尾串行 → pod 内尾延迟耦合（慢回合队首阻塞同 pod 他成员收尾） | 默认 in-flight=1 使其确定化（排队而非随机尾）；高流量 pack 留 solo 档 |
| 冷启动放大：一成员 spawn 失败全员重试 | 阶梯照旧有界（3 次+退避）；失败面 -32004 语义不变，下次触达再试 |
| paused 语义弱化（成员暂停 pod 仍在跑） | 接受：暂停是回合级拒绝（-32010），非资源回收；资源回收走 warm-zone pod 粒度 |
| byPreset 过滤形状漂移 | 旧形状语义不变（无 byPreset=全 home 单过滤）；合同⑯+单测钉形状 |
| registry 面/端口面零改动的边界 | 显式非目标（D8）；后续切片接 registry 代理路径保持 |
