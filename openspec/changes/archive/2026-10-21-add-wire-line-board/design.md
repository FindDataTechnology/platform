## Context

动机见 `proposal.md`。塑造方案的现状约束（均已实地核实）：

- **壹座侧骨架**（`add-line-boards-and-action-gate`，960e6725，在途未归档）：`BoardAdapter` 契约与 `GET /api/boards/:line` 路由已在；两个既有适配器是 TODO 占位；`executeAction` 空壳；`propose_action` 为 stdio MCP 子进程（`server/actions-mcp.js`）经 loopback 调 `POST /api/actions/propose`，**不带身份**；`/api/actions` 不在 `server/auth.js` 的 loopback 豁免家族（只有 `/api/cron`、`/api/resources/bind-declared`、`/api/delegation`）；`LINE_BOARDS_ENABLED` / `COPILOT_ENABLED` 全仓零命中；`riskToTier` = read→auto / write→inline / destructive、cost→second / publish→async。
- **柏讯侧**（fd-wire a228bfa）：`REGISTRY` 11 条，`RISK_TO_TIER` 与壹座逐字一致（无 read 键——读不入闸）；`ACTION_TO_TOOL_NAME` 7 条（漏 `wire.dataset.create`）；客户面 REST 全在 `/api/v1/*`，Bearer = Logto ID token 或 `wdk_` key，无 Bearer 一律 401。
- **两个操作 MCP**：`wire-ops-mcp` 10 工具（7 读 + 3 写），`wire-build-mcp` 15 工具（build 组 10 + steward 组 5，其中 9 写）；两仓 `tool-surface.json` 顶层 `tool_risk` 共 **12 个写工具名**；工具层把进站 `Authorization` 原样转发上游（`WireClient`），超时 20s。
- **凭据**：`wire-customer` 是 ID-token 线（`line-credentials.js`）：浏览器 PKCE 铸、服务端不铸、过期从 profile 省略、**401 时 `markInvalid` 清 token 回未连接**（stale 是粘贴 key 线的语义）；dispatch 表 `credential-refs.js` 的 `staleEvent` 名为 `line_credential_stale`，前端 extensions store 已消费该事件名。连接面板已存在：`/settings/connections?panel=line-wire-customer`。
- **主 spec 冲突面**：`app-center`「统一网格——一卡一生态产品」被姊妹 change 的 delta MODIFIED（看板主行动条件 = 卡片聚合态 `connected`）；主 spec 规定 `wire` 卡所需连接是 `line-wire-customer` **和** `paper-trading` 两个，故柏讯看板若沿用聚合态条件，paper-trading 未连时入口会消失。
- **前端配置通道**：`GET /api/config`（`server/routes/misc.js:385`）+ `useAppConfig()` 已被 Sidebar / Settings 等消费。
- `@modelcontextprotocol/sdk ^1.29.0` 已在依赖；paas 目前只用其 server 侧，无任何 MCP client 代码。

## Goals / Non-Goals

**Goals:**

- 柏讯成为第一条「看板真读 + 闸真执行」端到端走通的线；地基修补以通用形态落地，facet / wanxing 后续零改动复用。
- 风险声明三处一份：paas 注册表、两仓 `tool_risk`、fd-wire `REGISTRY`——paas 侧以 CI 硬门钉住自己能钉的那一段，漂移在刷新时暴露而非上线后暴露。
- 需求单合规字段的「不代填」由服务端强制，不依赖 prompt。
- 回滚可一键：env 关门即回到现状。

**Non-Goals:**

- 不补 facet / wanxing 占位适配器（点名暴露，不修）。
- 不做 MCP 客户端连接池、不做跨回合长连接。
- 不做卡片原地重试（执行失败置 `failed` 后，重试 = 重新提议）。
- 不把写工具 lint 做成 `/api/packs/validate` 的平台级规则（需要 registry 暴露风险数据，挂账）。
- 不改 fd-wire、不改两个 MCP 仓。

## Decisions

### D1 — 柏讯看板适配器真读客户面 REST；连接判据是凭据，不是 email

`WireBoardAdapter.fetchBlocks(ctx)` 以 `liveToken(ctx.email, "wire-customer")` 判连接：为 null → 返回单个「未连接」块（`data.connected=false`、`connectPanel="line-wire-customer"`），不发任何上游请求。有 token → 四块各自 `fetch`（base `https://wire.finddatatech.cloud`，`Authorization: Bearer <token>`，20s 超时），每块独立 try/catch 落自己的 `error` 信封：

```
+------------------+----------+------------------------------------------------+
| 块               | 类型     | 上游                                           |
+------------------+----------+------------------------------------------------+
| overview         | metrics  | GET /api/v1/datasets + /artifacts + /demands   |
|                  |          | （三次计数）+ GET /api/v1/datasets/quota（免费档）|
| my_datasets      | list     | GET /api/v1/datasets                            |
| artifacts        | list     | GET /api/v1/artifacts                           |
| demands          | timeline | GET /api/v1/demands（按创建倒序）               |
| market (v1.1)    | list     | GET /api/v1/market/datasets                     |
+------------------+----------+------------------------------------------------+
```

任一块上游 **401** → 调 `markInvalid(email, "wire-customer")`（清 token）、广播 `line_credential_stale`，该请求的其余块一律不再发（token 已废），整板返回「未连接 + 需重连」块。深链拼在 `originUrl + "/#/console/{datasets|artifacts|demands}"`。

**为什么不照抄 FacetBoardAdapter 的 email 判据**：有 email 不等于有凭据；柏讯的连接事实就是 token 本身。**为什么不用 MCP 读工具**：沿姊妹 D1——工具面为模型设计，渲染要的是稳定字段、可缓存、可按块降级。**为什么 401 不置 stale**：ID-token 线的既有机制是「清 + 浏览器重铸」，stale 语义会要求用户「重新粘贴」——柏讯没有可粘贴的东西。

### D2 — 风险单一真源 = 两仓 `tool_risk`；paas 侧用快照 + 刷新脚本 + 两级对拍

```
wire-ops-mcp/tool-surface.json ──┐   scripts/refresh-wire-tool-surface.mjs
wire-build-mcp/tool-surface.json ─┴──> lib/wire-tool-risk.js（快照：12 工具→风险，8 动作→工具）
                                              │
          测试 A（CI 硬门）：action-registry 柏讯八条 {tool, risk} == 快照；快照键集 == 12
          测试 B（本地门）：两仓源文件存在时 源 tool_risk == 快照；不存在则 skip 并打印
```

快照的「动作→工具」映射以 fd-wire `ACTION_TO_TOOL_NAME` 为底稿、**补上 `wire.dataset.create → wire_dataset_create`**（fd-wire 漏项，见 Open Questions）。刷新脚本读 `WIRE_OPS_MCP_DIR` / `WIRE_BUILD_MCP_DIR`（默认 `~/finddata/...`），有 diff 则非零退出并打印差异供人工确认后提交。

**为什么不在 CI 直读源仓**：CI 没有两个 checkout。**为什么不从 registry 拉**：registry 不暴露 `tool_risk`（姊妹 D3 已指出 paas 不消费 tool-surface、要先造拉取通道；快照 + 脚本就是最小通道）。**为什么不 import fd-wire**：Python 仓；fd-wire 侧已有自己的同仓一致性测试，三方各守一段。**诚实边界**：源仓改了 `tool_risk` 而无人刷新快照时，paas CI 不会红——这段由刷新脚本 + fd-wire 侧测试 + 本任务书「任何一侧加动作先改 tool-surface.json」纪律覆盖。

### D3 — 执行器是 MCP 客户端，不直调柏讯 REST

新增 `lib/action-executor.js`：按 `action.tool` 找到其所属 server（快照里带 `server: "wire-ops-mcp" | "wire-build-mcp"`），endpoint 沿 registry-bridge 的推导 `{REGISTRY_URL}/{entry_path}/mcp`，每次执行 `new Client` + `StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: "Bearer <liveToken>" } } })` → `callTool({ name, arguments })` → `close()`。一次性连接、20s 超时、不池化。

错误映射：工具返回 `isError` 且内容可解析出上游 422 → 结果摘要携带 `{ code: "upstream_422", fields: [...] }` **逐字段**透传到卡片，不改写不补全；上游 401 → `markInvalid(email, "wire-customer")` + 提案置 **`failed`**（执行失败、可查可重提——`rejected` 只表示人说不，沿 main `4e06e955` 的定案）、`result_summary` 前缀 `execution failed:`，并广播 `line_credential_stale`。成功 → `executed` + `board_changed { line: "wire", resources: [<action id 第二段>] }`。审计台账只记参数 **digest**，不存 args 本体。

`executeAction` 从 `proposal.proposer_email` 取 email——这正是 D4 必须先成立的原因。

**为什么不直调 REST**（`POST /api/v1/demands` 等同样可达）：姊妹 D8 的单一信任路径原则——绕过操作 MCP 就绕过了它的参数校验、422 语义与工具面台账，形成第二条信任路径；而且两个 MCP 的 notes 里已经把「建集按档位分流」「写修正必须带 source」等上游语义封装好了。**为什么不借 dsh 会话调工具**：那是回合内、计 token、且副驾可见面刻意不含写工具。

### D4 — 提议身份经 per-user profile 注入；loopback 只豁免 propose

```
dsh-profile（per-user effective profile）
   └─ mcpServers.actions.env.ACTIONS_MCP_PROPOSER_EMAIL = <email>
        └─ actions-mcp.js  POST /api/actions/propose { actionId, args, proposerEmail }
              └─ auth.js: isInternalActionsBridge = POST /api/actions/propose && isLoopback → 放行
                    └─ routes/actions.js: proposer_email 落库；preflight 拿到 email
approve / reject / GET :id ─── 仍走完整认证（cookie / 网关头），owner-only 不变
```

profile 本来就是逐用户写的（`resolveCredentials` 为 HTTP server 注 `Authorization` 头就在同一处），给 stdio server 注一个 env 是同款位置的同款动作。`proposerSession` 尽力而为（子进程可得时带上，否则 null）。

**信任边界**：本机进程可伪造 `proposerEmail`，但只能造出一条 **pending** 提案——批准仍要该用户的真实会话；与 cron 桥同款模型（「loopback 即凭据」），CLOUD_MODE 下沿 cron 桥既有处理，不另起一套。**备选否决**：子进程带网关 secret（secret 不该进 dsh 子进程 env）；提议匿名、首个批准者成 owner（违背 owner-only）。

### D5 — 执行前用户补填参数（`userFilledArgs`）：服务端剥除模型值，approve 合并用户值

注册表条目新增可选字段：

```
userFilledArgs: [
  { key: "source_urls",            label: "公开源 URL",   kind: "url[]",   required: true },
  { key: "public_data_statement",  label: "公开数据声明", kind: "boolean", required: true },
]
```

- **propose**：`for (k of userFilledArgs) delete args[k]`——模型给的值一律丢弃，不报错不提示；`args_json` 存剥除后的；返回体带 `userFilledArgs` 供卡片渲染。
- **ActionCard**：按 `kind` 渲染空输入；任一 `required` 未填 → 确认钮 disabled。
- **approve** body 增 `{ userArgs }`：服务端校验 required 齐全（缺 → 400）、键必须在 `userFilledArgs` 内（越权键 → 400）、合并后执行；审计 digest 取**最终** args。

首个消费者 `wire.demand.submit`；字段实名在任务里对 fd-wire `POST /api/v1/demands` schema 核实，上游 422 逐字段透传兜底。**为什么服务端剥除而不靠 persona 约束**：spec 要求「一律丢弃」，prompt 做不到「一律」。**为什么做成通用机制**：萬星 deploy 的 `billingKey`、谦面 publish 的可见性等未来同样需要「人亲手填」的参数。

### D6 — 「柏讯助手」pack 读面 11 工具；写工具 lint 落为仓库级测试

读面：wire-ops-mcp 7（`wire_demands_list` / `wire_demand_read` / `wire_datasets_list` / `wire_dataset_query` / `wire_dataset_aggregate` / `wire_dataset_rows` / `wire_market_browse`）+ wire-build-mcp 4（`wire_dataset_schema` / `wire_artifact_list` / `wire_artifact_get` / **`wire_dataset_corrections_list`**）。收 `corrections_list`：改错 playbook 的自然读面；不收 `wire_dataset_export`（数据出口 + 行数闸，非对话读面）；不收 `wire_dataset_rows_read`（与 ops 的 `wire_dataset_rows` 重叠）。

lint：仓库级测试对 `docs/official-packs/*.json` 的全部 `allowTools` 与 `lib/wire-tool-risk.js` 的 12 键求交，非空即红。**为什么不进 `/api/packs/validate`**：平台不知道任意 server 的写工具名；通用规则要等 registry 暴露风险数据（Open Questions）。官方 pack 是仓库文件，仓库测试已足够钉死。`requiredGroup: wire-customers`；private 先行，验收 cell 实测后转 public。

### D7 — 应用中心看板主行动的条件 = 该看板所需凭据已连接，不是卡片聚合态

`wire` 卡所需连接含 `paper-trading`（主 spec），与看板无关；沿姊妹的「聚合态 `connected`」条件会让 paper-trading 未连的用户看不到看板入口。改为按线声明：谦面 → `facet-market`；柏讯 → `line-wire-customer`；萬星无所需凭据 → 恒可用。这对谦面行为不变（单连接，聚合态即该连接），对萬星消除了「无连接 → 聚合态为空 → 永不渲染看板」的歧义。`appCatalog.ts` 的 `wire.status: "early"` 摘除；`hasBoard` 列表加 `wire`。

### D8 — `LINE_BOARDS_ENABLED` 默认关，经 `/api/config` 投影到前端

服务端：未开启时 `GET /api/boards/:line` 返回 404 `line_boards_disabled`；`/api/config` 增只读字段 `lineBoardsEnabled`。前端：`useAppConfig().lineBoardsEnabled` 为 false 时不注册 `/boards/:line` 路由（或渲染「未开启」）、应用中心不渲染看板主行动（回到「打开」）。默认关：姊妹迁移计划既定，分支未上产，可以兑现。`COPILOT_ENABLED` 不在本 change。

### D9 — 401 / 未连接的事件名沿用 `line_credential_stale`，语义按 ID-token 线解释

事件名已被 extensions store 消费、且是 dispatch 表字段，不改名。看板页收到 `{ type: "line_credential_stale", line: "wire-customer" }` 时重取看板（此时会得到未连接块）并提示「柏讯登录已过期，重新进入连接页即可重新授权」——不是「重新粘贴」。

### D10 — 审计双层并存，不同步

壹座 `action_audit` 记操作侧（提议者、批准者、最终 args digest、结果、耗时）；wire 侧因请求带该用户 Bearer 自然落租户审计（无论 REST 直打还是经 MCP）。两层不互相同步、不聚合；柏讯看板不呈现 wire 侧审计（fd-wire 动作审计暂只有库表无 REST）。

## Risks / Trade-offs

- **短命 ID token 中途过期**（典型 1–2h）→ 执行时 401 → 清凭据 + 提案失败 + 重连提示；**不得**为绕过它改用长命 key。长回合用户会在批准瞬间失败一次，重铸后重新提议。
- **快照过期漂移 CI 测不到** → 刷新脚本 + fd-wire 同仓测试 + 「先改 tool-surface.json」纪律；仍可能短暂漂移，验收任务含一次强制刷新。
- **loopback 豁免面在 CLOUD_MODE 更大** → 只豁免 `POST /api/actions/propose`、只能产 pending；approve 全程完整认证。
- **`userFilledArgs` 字段名与上游 422 字段名不一致** → 任务先核实 schema；422 逐字段透传兜底，用户看得到真实字段名。
- **MCP endpoint 可达性**（网关 Bearer 透传 10-20 刚修）→ 验收前跑一次 `callTool` 探针（读工具）确认链路。
- **fd-wire 真机验收（6.2，wire-testers 三档）尚未跑** → 壹座端到端排在 fd-wire 出片之后，或用 fd-wire 本地 / 预发先行。
- **两个在途 change 修同一 app-center 需求** → 本 delta 叠加姊妹文本；归档顺序须先姊妹后本 change；若顺序反了需手工合并（任务 8 点名）。
- **facet / wanxing 适配器仍是占位** → 本 change 不修，看板页对它们仍渲染零数据（现状）；在 proposal / tasks 点名给维护者。
- **一次性 MCP 连接的握手开销**（每次执行 1 次 initialize）→ 动作频率低（人确认一次执行一次），可接受；若实测慢再池化。
- **`failed` 与 `rejected` 两种终态并存** → 卡片与审计按状态名区分展示；spec「失败允许重试」在 v1 = 重新提议，原地重试不做。

## Migration Plan

1. 地基修补先行且各自独立可合：执行器（D3）、身份链（D4）、补填参数（D5）、env 杆（D8）——单测绿、既有 facet / wanxing 路径行为不变（它们的 `tool` 仍不可达时执行器返回明确错误而非假成功）。
2. 快照脚本跑一次生成 `lib/wire-tool-risk.js`，注册表 +8，对拍 A/B 绿。
3. 适配器 + 看板页 + 应用中心 + i18n。
4. 「柏讯助手」private 发布，装验收 cell，工具面探针。
5. 验收 cell 打开 `LINE_BOARDS_ENABLED`，跑十场景（见 specs）；更新 `docs/acceptance-criteria.md` 与 `docs/registry-maintenance.md` §9。
6. **回滚**：关 `LINE_BOARDS_ENABLED` → 看板路由 404、入口消失；注册表条目、快照、执行器、身份注入、`userFilledArgs` 留存无害（无 wire 提案即无调用）。

## Open Questions

真正可延后、不改变本 change 的 specs / 方案 / 任务拆分：

- **fd-wire 侧映射缺口**（fd-wire 线 follow-up，不阻塞本 change）：`ACTION_TO_TOOL_NAME` 漏 `wire.dataset.create`；`wire_artifact_update` / `wire_artifact_restore` 有工具无 action id；`wire.artifact.draft.create` 按 `kind` 对应 `wire_artifact_form_create` / `wire_artifact_record_view_create`（非 1:1，args 形状不同）；`wire.artifact.promote` / `wire.artifact.share.create` 真无工具。何时补齐、paas 何时扩到 11 条。
- 通用写工具 lint 何时进 `/api/packs/validate`（前置：registry 暴露 `tool_risk`）。
- 卡片原地重试（`failed` 态已有；重试目前 = 重新提议）。
- 市场浏览块（v1.1）与 `wire.market.subscribe` 在看板上的行内入口形态。
- `COPILOT_ENABLED` 杆（姊妹 change 的债）。
- 快照 ↔ 源仓对拍是否在两个 MCP 仓的 CI 做反向校验（它们改 `tool_risk` 时提示 paas 刷新）。
