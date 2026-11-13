# Design: add-harness-adapter

> 依据：docs/wanxing-multi-harness-runtime-explore.md（切片③）＋本轮侦察实证：
> npm 上 `@zed-industries/claude-code-acp@0.16.2`（Claude Agent SDK 实现，bin
> `claude-code-acp`，stdio ACP agent）与 `codex-acp@0.16.0` 真实存在；
> `@agentclientprotocol/sdk` 已在仓依赖（合同⑬的 ACP mini client 就是手写同款）；
> `runner_stats` 心跳已带 `models`（roster gate 同形增量）；`agent_runners` 表 +
> `runner_id` 部署路由（add-runner-fleet-sharding）已上线。未决问题 2（ACP 与平台
> JSON-RPC 分工）在此给出切片级答案：ACP 只做**驾驶面**，平台深控不进 ACP。

## D1 接口形状：agent 级四方法 + 能力自报

```js
// agent-runner/harness/adapter.js —— 契约（JSDoc + 运行时断言，零依赖）
// HarnessAdapter:
//   async start(spawnSpec) -> void        // 起运行时并完成 initialize/握手
//   async turn(sessionId, text, {onDelta, agentKey}) -> { text, usage }
//   async stop() -> void                  // 幂等；EOF→SIGTERM→SIGKILL 阶梯
//   pid() -> number|null                  // 足迹采样（warm-zone）
//   capabilities() -> { liveModel?, cancel?, stream?, perSessionPreset? }
//   async request(method, params) -> any  // 可选：harness 深控面（dsh 桥方法透传；
//                                         // ACP 实现缺省抛「unsupported capability」
```

- 判据（写进代码注释）：**能在两个 harness 上都成立的概念才进接口**。
  `agentKey`/pod 密度/泊靠 wire id 都只在 DshHarnessAdapter 内部生效；接口上
  `agentKey` 只作为「共宿实现的内部提示」——ACP 实现忽略它（一进程一对话）。
- `usage` 形状沿用 child.js 现状（harness 原始 usage 对象，`tokensOf` 在 manager
  侧归一）——两个 harness 各自给原样，计量面不变。
- 契约测试（单测）对两个实现跑同一组断言（spec「Adapters are interchangeable」）。

## D2 dsh 实现：零行为变化的包装

`DshHarnessAdapter` = 今天的 `AgentChild` 内协议面拆出：`clientFactory` 注入保留
（测试与 index.js 的 `HarnessClient` 构造不动），`prompt/request/subscribe` 的
事件泵、wire 会话命名空间、`preset/set`+`model/set` 泊靠、`session.status` idle
结算、`platform/stream` 帧、`-32001/-32002/-32003/-32005` 错误族全部留在实现内。
`AgentChild` 保留为薄壳（key/lifecycle/budget 状态），把 `turn` 委派给 adapter。
**验收硬门**：dsh 路径单测（57 项）与合同①-⑯ 全绿零改动。

## D3 第二 harness：claude-code-acp + 镜像线

- **本体**：`@zed-industries/claude-code-acp`（npm，pin 版本），启动命令
  `claude-code-acp`（stdio ACP）。descriptor 声明：
  `harness: "acp-claude-code"`；命令与参数走 runner 配置（`AGENT_RUNNER_ACP_COMMANDS`
  JSON 映射，如 `{"acp-claude-code": ["claude-code-acp"]}`）——不在 descriptor 里放
  任意命令（安全面：descriptor 来自 registry，命令面必须是 runner 侧白名单）。
- **镜像**：**同镜像内置**（不另开镜像线）——理由：claude-code-acp 是 npm 包、
  体积可控；另开镜像会把 dsh-matrix 版本纪律乘出第二套矩阵。装进现 runner 镜像的
  独立 npm 前缀（`/opt/harness-acp`），不污染 dsh 树。若体积实测 >150MB 或依赖
  冲突，回退方案=独立 runner 镜像（design 记录，实施时按实测拍板）。
- **凭证**：Claude Code 走 `ANTHROPIC_API_KEY`（或平台网关的 anthropic 兼容路由）——
  走既有 per-agent credentials 文件通道（`applyBillingKey`/`applyDeploymentSecrets`
  同款），child env 仍 scrub。**未验**：claude-code-acp 的凭证读取面（env vs 文件）
  实施时第一件事核（tasks 3.1），核不到就先用 deployment-secrets 注入 env。
- **不做**：pod/多会话共宿、工具 allowlist 强制（ACP 面只有权限请求）、preset 泊靠。

## D4 ACP 映射表（写死进 design，实施照做）

| 接口 | ACP 方法/通知 | 备注 |
|---|---|---|
| `start` | `initialize` → `session/new {cwd: 绝对路径, mcpServers: {}}` | mcpServers 必须对象（合同⑬实证坑）；cwd 必须绝对（validateWorkspaceParams） |
| 模型选择 | `session/set_config_option {configId:"model", value: JSON.stringify([provider,model])}` | 值形状来自合同⑬实证 |
| `turn` | `session/prompt {sessionId, prompt:[{type:"text",text}]}` → 等 `stopReason` | 文本从 `session/update` agent_message_chunk 累积 |
| `onDelta` | `session/update` 的 chunk 通知 | 映射为 text-delta 回调 |
| `usage` | `usage_update` 通知（合同⑬实证存在） | 原样交给 manager 的 tokensOf |
| 取消 | `session/cancel` 通知 + 等收敛 | 预算取消优先路径同 dsh |
| `stop` | 关闭 stdin → 等退出 → SIGTERM/SIGKILL 阶梯 | 同 HarnessClient 阶梯 |
| 会话续跑 | `session/resume`（若 agent 支持）else 新会话 | 不混历史（spec 场景） |

## D5 选择与路由：descriptor 声明 + 心跳自报 + 部署门

- descriptor 增 `harness`（composeDescriptor 增参；缺省不写字段=runner 默认 dsh）。
- 心跳 `runner_stats.payload.harness = ["dsh", "acp-claude-code"]`（来自 adapter
  注册表；`createFleetSampler` 增 `harnessProvider`，同 rosterProvider 形状）。
- 部署门（gateway/packs.js）：与 model roster gate 同形——目标 runner 的 board 行
  有 `harness` 且不含声明值 → 400/503 指名拒绝；无字段/unknown → 降级开放。
- 选址：沿用 `runner_id` 指派（不做第二套 placement）；部署面可选把
  harness 作为选址提示（非本 change 必需，记为后续）。

## D6 契约⑰：本地 fake ACP agent

`scripts/lib/dsh-contracts/fake-acp-agent.mjs`：stdio 实现 ACP 最小面
（initialize / session/new / session/prompt / session/cancel / session/update 流式 /
usage_update 通知），含两个故障模式（起不来=启动即退出；空回合=prompt 后直接
end_turn 无文本）。合同⑰ 在**仓内 adapter 模块**上直接跑（不经 dsh 树——adapter
是平台代码），断言 D4 映射表 + 错误族。fake agent 同时是单测的共享夹具。

## D7 兼容与风险

| 风险 | 处置 |
|---|---|
| claude-code-acp 凭证面未知 | tasks 3.1 先核（env/文件）；不通则 deployment-secrets 注入 env 兜底 |
| ACP 会话面比 dsh 浅（无工具门/无泊靠） | 如实收窄：capabilities 自报，深度面请求结构化拒绝（spec 已钉） |
| 镜像体积/依赖冲突 | 独立前缀 `/opt/harness-acp`；实测超限回退独立镜像线 |
| 上游 ACP 版本漂移 | adapter 走 `@agentclientprotocol/sdk` 类型；合同⑰盯映射面 |
| 部署门新增维度误伤存量 | 缺失/未知降级开放（与 roster gate 完全同形），存量 descriptor 无字段=零变化 |

## D8 验收

1. 单测：契约一致性（两实现同断言）+ ACP 映射（fake agent）+ 部署门/harness 自报。
2. 合同⑰两轮绿；dsh 合同①-⑯零回归（同一 runner）。
3. 生产眼见：同 pack 双 agent（一 dsh、一 acp-claude-code）各 A2A 回合成功；
   心跳 harness 字段；harness 错配部署被拒。

## D9 实施期增补（2026-10-14 实测）

- **凭证面实测（tasks 3.1）**：claude-code-acp 的凭证由 **Claude Agent SDK 从进程 env 读
  `ANTHROPIC_API_KEY`**（包内 dist 无文件凭证读取路径；`CLAUDE_CONFIG_DIR` 默认
  `~/.claude`）。故 ACP spawn 走 **env 注入**（`AGENT_RUNNER_ACP_ENV`，runner 侧配置，
  值不落日志），不是 dsh 的 credentials 文件通道——因为 ACP 进程不经我们的桥。
  实施落地：`agent-runner/harness/registry.js` 在 spawn 时把 acpEnv 叠在 scrubbed child env 上。
- **镜像实测（tasks 3.3）**：`npm install --prefix /opt/harness-acp @zed-industries/claude-code-acp@0.16.2`
  = **104 包 / 120MB**（含 Claude Agent SDK + bundled CLI），bin `claude-code-acp` 正常落地。
  120MB < 150MB 阈值 → **同镜像独立前缀方案成立**（Dockerfile builder 装、runtime COPY、
  PATH 加一行）。dsh 树零污染（独立 prefix，不 merge）。
- **上游改名（记录，不阻塞）**：npm 提示该包已改名 `@agentclientprotocol/claude-agent-acp`
  ——本 change pin 0.16.2 继续可用；跟随改名是后续小改（白名单命令名不变，换包名与版本即可）。
- **ACP adapter 不引入 `@agentclientprotocol/sdk` 直接依赖**（决定）：手写 ndjson JSON-RPC
  （与合同⑬的 mini client 同形），理由=该 SDK 在 dsh 树里是传递依赖，提升为生产直依赖会给
  runner 镜像加第二套版本纪律面；合同⑰钉住线形，漂移由套件捕获。
