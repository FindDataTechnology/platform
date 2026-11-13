## Context

见 `proposal.md - Why`。四条既有事实约束本设计：

1. **a2a 的协议形状已经存在**：`server/a2a-client.js`（出站）与 `agent-runner/a2a.js`（入站，
   `message/stream`、`X-Authorization`、`X-Delegation-Depth`、depth ≥ 3 拒绝）已经在跑。团队端点
   是这套形状的第三个使用方，**不是新协议**。
2. **深度界已在服务端，但出站恒 1**：`agent-runner/a2a.js:126-134` 解析并下传入站深度，`manager.js:1006`
   把它继续往下带；而 `server/cron-runner.js:991` 与 `:2042` 把出站写成常量 `1`。
   spec 早已要求 +1（`agent-delegation-a2a`「Outbound delegation calls carry a depth that hops」），
   所以这是**实现缺口**，不是需求变更。
3. **既有 a2a 是服务方自付**：部署时铸的是部署者的每 agent 计费键（`a2a-agent-serving`）。
   团队端点的成本模型沿用这条，否则一期就要引入跨方结算，而结算需要共同账本，一期没有。
4. **网关是唯一跨用户面**：`gateway/` 已有 `cell-registry` 与采样先例；团队端点的一期入口必须在这里，
   但服务端实现必须在 cell 内——否则二期换入口要重写。

## Goals / Non-Goals

**Goals:**

- 一次调用只暴露一个入口；编排责任留在团队内。
- 协议形状与 registry a2a 逐字段一致：二期换入口，服务端与调用方都不改。
- 拒绝原因可判别（封闭错误码），且拒绝路径零成本（不产生岗位回合）。
- 深度逐跳在**本 change 内**落地，使团队链的环路界当天生效。

**Non-Goals:**

- 不做跨部署结算/分账（二期，需要共同账本或预付额度）。
- 不做调用方侧的 UI 工作流编排（调用方只发一次请求）。
- 不改 `a2a-agent-serving` 的按 role 部署与卡派生。
- 不把路由岗做成一个「新的编排器」——它就是团队内的一个岗，用既有编导边。

## Decisions

### D1 — 端点地址从团队标识稳定推导，服务端在 cell

**决定**：`POST /api/teams/:cellId/:handle/a2a`（一期网关入口），转发到目标 cell 的同形状路径。

**理由**：a2a 客户端只需要一个 URL + 一个 token。把 `cellId` 放进路径让入口无需查目录即可路由；
把 `handle` 留在路径让团队自己的发布行是唯一权威。

**否决的替代**：入口用团队全局 id + 网关查表。否决理由：多一次查表、多一次失败面，而 `cellId`
本来就随目录响应回来了。

### D2 — 路由岗是团队内的一个普通岗

**决定**：`team_cards.reception` 存一个岗位标识；端点把请求作为一次**定向派发**给该岗，该岗按
既有编导边与派发语义往下走。

**理由**：第二套编排器是长期负债——两套编排必然在两处对「回合契约、深度、配额、失败归因」做不同
假设。复用既有派发，这些语义自动继承。

**代价**：路由岗的提示词质量决定路由质量。缓解：路由岗模板进官方 starter（不在本 change）。

### D3 — 调用方身份是适配器，不是分支

**决定**：`server/caller-identity.js` 暴露 `resolve({headers, session}) → {ok, caller} | {ok:false, reason}`，
适配器按顺序尝试，**全部失败即拒绝**，没有 default。

**理由**：身份解析里最危险的是「找不到就用主人/服务身份」的回落——那会把跨用户调用变成冒名。
把「没有 default」写成接口形状（返回值必须显式带 ok），比写在注释里可靠。

### D4 — 授权判定用一个纯函数，输入恰好是发布行 + 调用方 + 当日用量

**决定**：`decide({publication, caller, usage}) → {allow: true, grants} | {allow: false, code}`。

**理由**：授权是这个 change 里唯一「错了就泄密」的逻辑，必须是可穷举测试的纯函数，而不是散在
路由里的 if。错误码封闭集在同一个函数里返回，杜绝「某条路径返回了没列进集合的东西」。

### D5 — 配额扣减与调用记录同一事务

**决定**：先条件 UPDATE 抢额度（受影响行数判定），再落调用记录；抢不到即拒绝，落记录失败即回滚。

**理由**：放行一笔不记账的调用 = 配额失效。这与 `input-request-cards` 的 first-wins 条件更新是
同一个手法，代码风格也一致。

### D6 — 长任务：同步窗口内走流，超窗转后台 + 回投

**决定**：同步窗口是部署配置（默认与既有回合预算对齐）。超窗时立刻返回 `{taskId}`，后台继续，
完成经 `decision_items`/通知通道回投（复用既有通道，不新造推送）。

**理由**：挂死连接会让调用方与网关同时占资源，且失败不可归因。既有 `runA2aTurn` 已有真实超时
（`AbortController` + `DEFAULT_A2A_TIMEOUT_MS = 300_000`，`server/a2a-client.js:59,88-101`），
但 5 分钟对「一支团队做一件真活」经常不够；把预算调大只会让连接占用更久，所以超窗转后台 + 回投才是正解。
（注：`docs/multi-agent-collaboration-explore.md` 4.5 节记的「超时是空转、委托路径不传 signal」写于
2026-11-08，现行代码已修，勿再引为现状。）

### D7 — 深度：入站贯通到出站调用点，不重置

**决定**：把 `agent-runner/a2a.js` 已解析的入站 depth 沿 `manager.turn({delegationDepth})` 一路带到
`cron-runner` 的委托调用点，出站写 `inbound + 1`；无入站时写 1。

**理由**：spec 已经这么写，调用点也自己标了 future state（`cron-runner.js:972-973,2043-2045`），只是没实现。
团队端点上线的同一天，房间 → 团队 → 岗位就是两跳，不修就等于把环路保护关掉。

**两个常量必须一起看**：客户端侧 `DELEGATION_DEPTH_BOUND = 3`（`server/a2a-client.js:13`，`depth >= 3`
时**在本地抛出、请求根本没发出去**）与服务侧 `delegationDepthMax ?? 3`（`agent-runner/a2a.js:127`，
`depth >= 3` 时拒绝）。因此实际可用入站深度上限是 **2**；入站为 2 的出站委托会在客户端本地抛错。
实现 SHALL 让这两处读同一个可配置来源，或至少在越界时给出**同一句话**的错误，避免「一端说界到了、
另一端说网络错误」。

### D8 — 成本模型：一期服务方自付 + 配额封顶，卡上明示

**决定**：调用消耗记在服务方团队的部署键与配额上；卡上明示这一点（`pricing` 字段已留位）。

**理由**：一期同部署内没有跨方账本。若不封顶，`open` + 无限配额 = 资损开关。二期结算另立 change，
届时 `pricing` 字段已存在，不需要改卡。

## Risks / Trade-offs

- **[路由岗成为瓶颈]** 所有跨团队流量挤在一个岗上 → 路由岗按既有并发准入排队；配额与深度先于排队判定，
  使拒绝零成本；路由岗超时按 `internal_error` 返回并留痕（不伪装成团队没在）。
- **[调用方文本注入]** 跨团队文本可能试图改团队行为 → 见 spec 的不可信内容要求；实现上跨团队内容
  只进「任务内容」位，永不进系统提示；工具面按团队自身配置，不因调用方而变。
- **[深度修复带来行为变化]** 既有单跳委托不受影响（无入站 → 1），但**已经在做两跳**的既有链会开始
  被界拒绝 → 迁移期先在 staging 用真实舰队量一次「当前最大实际深度」，把 `delegationDepthMax`
  按实测值确认（默认 3）；若实测有 3 跳以上的在途链，需与其主人对齐再上线。
- **[配额口径与目录不一致]** 目录页只声明配额，服务端才扣减 → 两端读同一个发布行，不各存一份。
- **[网关入口与目录路由冲突]** `/api/teams/...` 同前缀 → 注册顺序：目录 GET 在前、a2a POST 在后，
  且 a2a 只接受 POST，MUST NOT 被 GET 兜底吞掉（`fleet-room-bridge` 的 404 教训）。

## Migration Plan

1. 先在 staging 量实际深度分布（读 `member_turn_events.depth`），确认界值。
2. 上线顺序：深度贯通 → 身份适配层 → 端点（默认对 `private` 全拒）→ 批准队列 → web 调用入口。
3. 无 env 新增；`team_cards` 增 `reception` 列用 `try/catch ALTER`（可空，空即不可调）。
4. 回滚：端点下线即回到今天；深度贯通是纯修正，可独立保留。

## Open Questions

- 同步窗口的具体秒数（与既有回合预算对齐，部署可配）。
- `listed` 批准的有效期默认值（一次性 vs 7 天），运营定；spec 只要求「可一次性或带期限」。
- 二期结算形态（预付额度 vs 分账）留到二期；本 change 只保证 `pricing` 字段与配额已在卡上。

## 附录 A · 现状基线（a2a 出站/入站今天到底怎么走）

**出站（`server/a2a-client.js`）**

1. 头部形状固定：`Content-Type: application/json`、`X-Authorization: Bearer <gatewayToken>`、
   `Authorization: Bearer <agentToken>`（`:75-80`）。
2. `X-Delegation-Depth` **只在 `depth >= 1` 时发**；人类直接与市场 agent 对话是 depth 0，不带这个头（`:81-83`）。
3. `depth >= 3` 时**在本地抛错、请求根本不发**（`:84-86`，`DELEGATION_DEPTH_BOUND = 3` 定义在 `:13`）。
   → 这一点决定了「入站 2 的团队再往外委托」会得到一个本地异常，而不是远端拒绝。团队端点上线后
   这条路径会第一次被真实走到，必须给出可读错误（见 D7）。
4. 缺凭据是**两个不同的错误**：无 gateway token →「no registry service credential configured
   (`MARKET_REGISTRY_TOKEN`)」；无 agent token →「A2A agent credential not configured
   (`AGENT_SERVING_BACKEND_TOKEN`)」（`:71-77`）。团队端点 SHALL 复用这两句，不自造第三句。
5. 超时是**真超时**：`DEFAULT_A2A_TIMEOUT_MS = 300_000`，`AbortController` + `setTimeout`，且中止是
   **单向的**（调用方 signal 会取消我方，我方超时**不会**去取消调用方）（`:59,88-101`）。
6. `metadata` 可携带 `visitor_scope`（`add-zhiyu-room` 用过），跨团队调用 SHALL 沿用同一字段承载归属来源。

**入站（`agent-runner/a2a.js`）**

7. 解析方式为 `Math.max(0, Number(header) || 0)`——**缺失、非数字、负数一律归 0**（`:126`）。
   这意味着「忘记带 header」与「深度 0」不可区分；团队端点 SHALL 在留痕里把「未携带」与「携带 0」
   分开记，否则事后无法判断是客户端漏发还是真的首跳。
8. `depth >= delegationDepthMax（默认 3）` → 返回 JSON-RPC 错误码 **`-32011`**，
   且在**任何 spawn 之前**拒绝（`:127-129`）。错误码 `-32012` 已被「agent parked」占用（`manager.js:965-968`），
   不要复用。
9. 入站 depth 会继续下传：`manager.turn(..., {delegationDepth: depth})`（`:134`），
   且 `delegationDepth >= 1` 时**额外占一个 delegation slot**（`manager.js:970`）。
   → 团队内部并行派活时，每个岗各自占一个 slot；这条是既有配额，不得在团队层绕开。
10. 每回合计量带 `depth`（`manager.js:1006` 的 `#meterLine`）——团队级调用上线后，
    这一列是唯一能回答「这条回合是不是跨团队来的」的字段。

**调用点（缺口所在）**

11. `server/cron-runner.js:989-992` 恒写 `depth: 1`，注释自陈「chains get +1 only when in-cell turns
    are themselves delegated, a future state」；`:2042-2045` 同一段注释、同一个 executor 入口。
    → 修改点只有这两处（`runA2aRemoteTurn` 与 `targetType === "a2a"` 分支共用 `a2aExecutor`），
    不要在全仓搜 `depth: 1` 批量改——其他出现是别的语义。
12. 凭据解析走 `resolveGatewayCredential({ ownerEmail: ctx.cellUserEmail, cloudMode })`（`:981-984`），
    即**主人个人凭据优先、服务凭据回落**，与 `agent-delegation-a2a` 的既有要求一致。
