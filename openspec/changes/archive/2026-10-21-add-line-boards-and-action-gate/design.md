## Context

见 `proposal.md` 的 Why。以下是塑造方案的现状约束：

- 五线操作 MCP 已在产（facet-ops / facet-market / wanxing-ops），凭据轨道 `credential-refs` 已覆盖 registry / facet-market / connector / wire-customer / lex / paper-trading / ciyuan-account。看板与闸都建立在这两层之上，不重造。
- Pack 只能引用**注册处已注册**的 MCP server（`registryName`），不能带端点、不能带 UI。因此平台级工具不能靠 pack 分发。
- 平台内置 MCP 的既有形状是：`mcp.json` 声明 stdio server（`library` / `cron` / `delegation`），server 是**loopback REST 桥的瘦客户端**，工具以 `mcp__<server>__<tool>` 出现，所有 persona 预设可见。
- 会话工具体系已有两种模式：**聚焦模式**只装载基线与所选 pack 的资源集（含 `allowTools` 收窄）；**完整模式**对已装 pack 引用的 server 取并集。副驾的「写工具不可见」只有在聚焦模式下才成立。
- `web/src/components/ToolBlock.tsx` 已按工具名分派专用卡片（`__cron_create` / `__delegate_task` / `ask_user_question`），动作卡沿用同一注册点。
- `useChatStore` 是模块级单例（`packages/core/src/store/chat-store.ts:454`），在同一个文档里再挂一个对话面板会抢主会话状态。
- `/external/:appId` 代理整包缓冲（`server/routes/external-services.js` 的 `arrayBuffer()`），不能承载 SSE/WebSocket；本方案不使用它。

## Goals / Non-Goals

**Goals:**

- 每条已接入产品线一块线看板，数据由服务端适配器直读，渲染不产生模型回合。
- 动作闸成为平台原语：看板按钮与模型提议走**同一条**注册、确认、执行、审计路径。
- 副驾是独立会话，携带看板上下文，且其可见工具面里没有写工具。
- 云端部署与桌面部署走同一个闸，但 preflight 不同：云端要 `wanxing-deployer`，桌面只要机位在线。

**Non-Goals:**

- 不嵌入谦面/萬星的原生页面，不做 DOM 级界面操控。
- 不做面向第三方的声明式看板 DSL（adapter 接口即契约，v1 由我们实现）。
- 不做组织/角色级审批（v1 仅 owner）。
- 不拦自主 mission 的工具调用（那是下一个量级；本 change 只保证「提议型动作」不可绕过）。
- 不引入 CopilotKit 运行时或依赖。

## Decisions

### D1 — 看板数据走服务端线适配器，不走 MCP

每线一个 `BoardAdapter`：

```
BoardAdapter {
  id, title, originUrl,
  blocks(ctx): Promise<BlockResult[]>   // 每块独立成功/失败
}
```

适配器用该用户已有的 credential ref 直连各线 REST，返回块数据；路由 `GET /api/boards/:line` 一次返回块元数据 + 数据，每块带自己的错误信封。

**为什么不用 MCP 读工具**：MCP 工具面是为模型设计的——分页、字段裁剪、限流都按对话回合算；渲染需要的是稳定字段、可缓存、可按块降级。**为什么不做声明式 manifest**：v1 只有两条线，DSL 的抽象成本高于收益；adapter 接口已经把「通用对接」的契约固定下来，第三方接入时再决定是否产品化为 manifest。

**备选**：服务端 MCP client 调读工具（多一跳、多一层序列化、错误语义混在模型协议里）；前端直连各线（跨域 + 凭据落前端，否决）。

### D2 — 闸的不可绕过性靠「聚焦模式 + 能力收窄」，不靠代理

副驾以 **pack persona preset** 运行，处于**聚焦模式**：可见工具面 = 该 pack 声明的读工具 + 基线里的 `propose_action`。写工具不在白名单里，模型无从直接调用。

`propose_action` 不放进 pack，而是作为平台内置 MCP：新增 `server/actions-mcp.js`，在 `mcp.json` 声明，沿用 cron/delegation 的 **loopback REST 桥瘦客户端**模式，工具名 `mcp__actions__propose_action`。它立即返回一个 proposal id（不 park、不改 dsh 协议），确认与执行在回合之外由闸完成。

**为什么不选另外两条路**：

- *MCP 代理层*：要插在所有写 server 前面，承担协议语义、流式与延迟，且对非副驾会话也生效——那是「全局沙箱」，不是本 change 的目标。
- *dsh 每次调用前回调宿主*：**已核实（子代理）**：dsh 有 `tools/pre-execute` 的 `ask` 决策类型，但 paas 没有答案器（approval answerer）；任何 `ask` 因无服务而拒绝。现有权限桥只暴露预设档位（read-only/workspace-write/danger-full-access），不是 per-call 审批钩子。**因此 v1 不能依赖 dsh 审批**。

**边界（必须写进文档）**：闸不是全局沙箱。用户若把副驾会话切到另一个带写工具的 preset，他就离开了副驾；这条路径不被闸覆盖。要让「任何会话都过闸」，需要 D2 的备选方案（MCP 代理或 dsh approval hook，后者不存在），属于后续 change。

### D3 — 风险登记在 paas 侧动作注册表

`lib/action-registry.js` 声明每条动作：`{id, line, tool, risk, target, impact(args), preflight(ctx)}`。v1 的条目：

| 动作 | 风险 | 目标 | 确认档 |
|---|---|---|---|
| `facet.pack.publish` | publish | cloud | 异步审批 |
| `facet.pack.visibility` | write | cloud | 行内确认 |
| `facet.pack.curation` | publish | cloud | 异步审批 |
| `facet.agent.toggle` | write | cloud | 行内确认 |
| `wanxing.agent.pause` / `resume` | write | cloud | 行内确认 |
| `wanxing.callers.add` / `remove` | write | cloud | 行内确认 |
| `wanxing.agent.deploy` | destructive | cloud / desktop | 二次确认 + 影响面 |

**备选**：`tool-surface.json` 加 `risk`（是五线的产品级契约，但 paas 目前不消费它，要先造拉取通道）；MCP annotations（`readOnlyHint`/`destructiveHint` 是提示，且现有三个 ops MCP 都没标）。v1 用注册表，后续把同一份风险声明同步到 `tool-surface.json`，注册表退化为缓存。

### D4 — 确认与执行在回合之外，单一执行路径

```
看板按钮 ─┐
          ├─> POST /api/actions/propose ─> 注册表校验 + preflight
模型提议 ─┘                                  │
                                             ├─ read    ─> 直接执行
                                             ├─ write   ─> 返回 pending，卡片行内确认
                                             ├─ destructive/cost ─> 返回 pending，二次确认+影响面
                                             └─ publish ─> 返回 pending，审批队列
                                                        │
                               POST /api/actions/:id/approve
                                                        │
                                    ┌───────────────────┘
                                    v
                          统一 executor（按 action.tool 调底层）
                                    │
                       审计表 + board_changed 事件
```

`propose_action` 的返回体永远是 `{proposalId, state: "pending"|"executed"|"rejected", impact}`；模型只能转述这个状态，不能把 pending 说成成功（spec 的「回执不冒充结果」）。

### D5 — 审批记录与审计落在 cell SQLite

新增两张表：`action_proposals`（提议、风险、影响面、状态、过期时间）与 `action_audit`（执行、批准者、参数摘要、结果、耗时）。24 小时过期由现有定时器扫描，过期置 `expired` 并 fail-closed。通知复用 `bot_notify`。

**备选**：gateway store（多设备可见，但 v1 审批人只有 owner 且在 cell 内操作）；任务引擎（审批不是工作项，塞进去会污染 mission 语义）。

### D6 — 副驾宿主用同源 iframe，不重构 store

v1：`/chat?embed=copilot&board=<line>&preset=<copilotPreset>` 的**同源 iframe** 挂在右侧 dock。独立文档 = 独立 store 实例、独立 WS、独立会话，零重构；看板上下文经 URL 首帧 + `postMessage` 增量传递。`embed` 模式隐藏侧栏与页头，保留对话、输入与动作卡。

**备选**：把 store 改成工厂并实例化第二个（要动 `packages/core` 的单例假设与全部 selector）；复用主会话（污染主历史，否决）。iframe 的开销与焦点管理是已知代价，若实测不可接受再提升为原生 dock。

### D7 — 变更事件驱动看板刷新

执行成功后发 `board_changed` WS 事件 `{line, resources: ["packs"|"fleet"|...]}`；看板只重取受影响的块，保留筛选与滚动。另设 30s 轮询兜底（事件丢失时不至于永远陈旧）。

### D8 — 部署动作补在 wanxing-ops-mcp，不绕过操作面

新增 `wanxing_agent_deploy`，调用 facade 既有部署端点；`target=desktop:<seat>` 走机位路径（既有配对，不需要计费键），`target=cloud` 要求 `wanxing-deployer`。preflight 在闸里做，工具只负责执行。

**为什么不从 paas 直调 facade**：会绕过 ops MCP 的凭据模型与工具面台账，形成第二条信任路径。

### D9 — 两个官方 pack 只带读工具

`谦面助手`：`facet-market-mcp`（browse/read/versions/validate）+ `facet-ops-mcp`（catalog_browse/agent_read）+ 建包与发布 playbook。
`萬星舰队助手`：`wanxing-ops-mcp`（agents_browse/agent_card/callers_list）+ 舰队巡检 playbook。
两者都**不含** `wanxing_agent_turn`（internal/计费）与任何写工具。发布门加一条 lint：副驾 pack 的 `allowTools` 命中写工具名单即拒发。

### D10 — IA：应用中心主行动进看板

`/boards/:line`；应用中心卡片主行动「看板」，外链降为「打开原站」。看板不新增主导航项——发现面仍是应用中心。

### D11 — 执行凭据按宿主服务器的目录声明解析（2026-10-21 收尾补决）

执行器（`lib/action-executor.js`，姊妹 change add-wire-line-board 落的 MCP 客户端）取凭据的顺序定为：**动作自身 `credentialRef` → 线固定 ref（wire = `wire-customer`）→ 宿主服务器在市场目录条目上声明的 `credential_ref`**（`facet-market-mcp` → `facet-market` 设备 token；`facet-ops-mcp` 未声明 → `registry`）。第三条就是装包路径的 `credentialRefForEntry` 规则——执行器呈现的 bearer 与该用户 cell 调同一服务器时**一致**，不另造第二套凭据映射。**萬星例外**：运营基线 `platform-mcp-config` 向 `wanxing-ops-mcp` 呈现的是 `wanxing-caller`（萬星平台令牌 = sub2api 键），注册表条目却未声明——若按数据驱动落到 registry 令牌，不仅 401 还会误伤用户的 registry 凭据（置 stale 断整个市场访问）。故萬星四条操作动作在注册表**显式钉 `wanxing-caller`**（优先级第一档），preflight 同步要求词元账号已连接。

取 token / 置失效一律经 `credential-refs.js` 调度表（新增 `liveTokenForRef` / `invalidateRef`），而非只认 `line-credentials` 一张表——否则 facet-market 的设备 token 与 registry 令牌根本取不到。路由是**声明式**：facet/wanxing 动作在注册表上写明 `server`；wire 动作钉在 `wire-tool-risk` 快照；二者互不回落，wire 动作永远够不到 facet 工具名。`wanxing.agent.deploy` 刻意不声明 server（上游工具尚不存在，task 6.2），以 `tool_unroutable` 诚实失败。

preflight 用同一解析（`requireExecutionCredential`）：目录冷、或用户未连接所需 ref，都在进档位前拦住并给出连接卡深链。401 在 HTTP 层（鉴权门）与工具层（无 wire 信封的自由措辞，复用 `dsh-events` 的 `UNAUTHORIZED_RE`）同等处理：置失效 + `upstream_401`。

**顺手修的潜伏缺陷**：`getMarketEntries()` 返回 `{ mcpServers, skills }` 对象，执行器原按数组 `.find()`——所有未 stub 的真执行都会抛 `list.find is not a function`；单测全靠注入 `resolveEndpoint` 才没暴露。现按对象形状读。

**COPILOT_ENABLED 与原 Migration Plan 的偏差**：dock 已随 sha-352d662 先行上产且无杆，若按计划「默认关」，升级即消失。实施为**杀开关**（仅 `"0"` 关闭，默认开）；`LINE_BOARDS_ENABLED` 维持姊妹 change 的默认关，生产清单显式置 `1`。

## Risks / Trade-offs

- **看板与产品 API 漂移** → 每线一个契约探针（复用 `scripts/probe-*.mjs` 的形状），块级失败诚实降级，不整页白屏。
- **闸可被 preset 切换绕过** → 已写入 D2 边界；副驾会话锁定在副驾 preset，切换即离开副驾；后续 change 再做全局 per-call 拦截。
- **`propose_action` 进入基线，所有会话多一个工具** → 它只能提议、不能执行；代价是一个工具 schema。若实测干扰，改为只注入副驾 preset。
- **桌面机位在线态误判** → 多机位时强制显式选择，不自动猜（对应 grilling 的 Q7）。
- **pack 误声明写工具** → 发布门 lint + CI 测试双保险。
- **审批人离线** → 24h 过期 fail-closed + 通知；不自动执行。
- **iframe 上下文陈旧** → 每次看板状态变化都 `postMessage`，上下文条显示「实际发给模型的内容」。

## Migration Plan

1. 新增表与路由（additive，无回填）；`/boards/:line` 由 `LINE_BOARDS_ENABLED` 控制（默认关，生产清单置 `1`）；副驾入口由 `COPILOT_ENABLED` 杀开关控制（默认开，`"0"` 关闭——见 D11 偏差说明）。
2. 部署 `server/actions-mcp.js` 与 `mcp.json` 条目；滚动 cell 与 runner（共享 profile 管线）。
3. `wanxing-ops-mcp` 发布新版本并加 deploy 工具；registry 侧更新 `tool-surface.json`。
4. 发布两个官方 pack（private 先行），装进验收 cell。
5. 打开 env，跑真机验收：看板打开不计费、写动作行内确认、破坏性二次确认、publish 异步审批、桌面部署不需要计费键。
6. 回滚：`LINE_BOARDS_ENABLED` 删除/置非 `1` 即关看板；`COPILOT_ENABLED=0` 即关副驾入口；表与工具留存无害。

## Open Questions

- **dock/embed 未传 preset（2026-10-21 真机发现③，待后续 change）**：dock 只带 `board=` 不带 `preset=`，会话跑用户默认预设=全工具面；模型面对同一写操作有直写工具与 propose_action 两条路时选择了前者，闸（确认/审计）被整体绕过。D6 的 `preset=<copilotPreset>` 参数已在设计中但未接线——修复方向：dock 按线注入聚焦 pack 预设（读工具 + propose_action），使「副驾=闸内」成为默认而非约定。

- 副驾 dock 是否在实测后从 iframe 提升为原生 dock（取决于焦点与滚动体验）。
- 移动端审批是否需要（当前审批只在 cell 内；若要手机批，需要一条 cell 审批 API + MP 页面）。
- 风险声明何时迁到 `tool-surface.json` 并让注册表退化为缓存。
- 是否需要在看板里提供「批量动作」（当前只做单对象动作）。
