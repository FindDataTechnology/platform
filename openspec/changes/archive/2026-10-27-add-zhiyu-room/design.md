## Context

现状关键约束（勘探结论，行号以勘探时点为准）：

- 1:1 会话模型是单主对象：`chat_sessions` 盖一次 owner、`chat_messages` 无发送者列、`turn-dispatch` 强制共享运行时同时只开一个回合、每连接单 `viewedSession`。这些不变量**不为空间改造**——空间另立对象与新路由。
- 可复用接缝：`runA2aTurn(url, text, { contextId })` 的 contextId 现为 web sessionId（`server/agent-session.js:733`），已部署智能体按 `(pack, agent, deployer)` 租户化并带 per-agent 计费键；`a2a-client.js` 对 `X-Delegation-Depth ≥ 3` 拒绝（防环语义与房间 @ 链不同，不混用）；matter-threads 有 runner 侧服务凭据 internal 路由与主人队列；bot-relay/站内未读/微信订阅是现成触达通道；action-gate 既有提议-批准闸。
- 拓扑：cell 是每用户进程，**无法跨用户承载空间**；gateway（registry/wanxing 同层）是多用户共享层。

## Goals / Non-Goals

**Goals:**
- 空间内核（对象、成员、消息、回合路由、结束）落在多用户可达的一层，四类成员身份模型可扩展到游客与外部 A2A（二、三期）。
- 站内首版：人类成员 SSE 实时 + 持久回读、智能体经既有 a2a serving 车道应答、代席三动词闭环。
- 零改动既有 1:1 会话、session-share、matter-threads、a2a serving 的行为契约。

**Non-Goals:**
- 网站嵌入 widget、IM 群桥、外部 A2A 入席、游客（均后置 change）。
- LLM 主持人/议事厅房型、消息可见性矩阵（v1 仅"共享史 + 私窗"两档）。
- 分身在场内的自主长期记忆写入（空间语境只读挂载，不写私域记忆）。

## Decisions

### D-A：空间内核落 gateway，不碰 cell 的 1:1 栈

空间是跨用户对象，cell 是单用户进程——内核只能放 gateway 层新模块 `gateway/zhiyu/`（与 wanxing facade 同层），存储用 gateway 级 SQLite 库（packs.db 先例）：`zy_rooms`（标识/主办/状态/空闲时长/创建时间/来源会话）、`zy_room_members`（room, kind: user|facade|agent, ref: email|deployment|registry条目, display, duty_policy, history_grant, 状态）、`zy_room_messages`（room, seq 单调递增, sender 归因成员行, visibility: shared|private:<memberId>, provenance, blocks）。

- 备选 A1（改造 chat_sessions 为多方）：拒绝——要重写 owner 闸、turn-dispatch、viewedSession 三条不变量，回归风险巨大，收益只是"无缝"假象。
- 备选 A2（独立新服务）：拒绝——部署纪律要求最小新增运维面；gateway 已是多用户层且握有 registry/计费键知识。

### D-B：回合路由器 = 无 LLM 的显式协议（hermes 式）

空间路由器是 `gateway/zhiyu/` 内的状态机：人类消息入房 → 解析 @提及（成员显示名+部署别名表）→ 命中则定向派发；未命中则对在场智能体并行广播征询一次。派发经 `agent-runner` 的 a2a 执行车道，`contextId` 用 `room:<roomId>:<agentRef>` 复合键（每空间×智能体一条远端上下文），**走 depth=0**——房间路由是平台内部会话车道，不是跨 agent 委派，不消耗 delegation 深度预算。

熔断三连：①智能体回复入房时打 `from_agent` 标记，路由器永不以 agent 消息为触发源；②同一条人类消息的非 pass 应答计数触上限即拒后续派发并落如实事件——上限两级可配：部署级默认值装 `zy` 部署配置（出厂 3）+房间级覆盖存 `zy_rooms.reply_cap`（创建指定/主办事后可改、界域校验、生效值对成员可见）；③每（空间， 智能体）一条在答回合，重名再点排队。pass 判定用保守约定：**回复以控制记号 `「过」` 开头的视为过**，落 pass 事件（可观）不入消息流；误判容忍——可疑回复一律当作正常发言。

- 备选 B1（AutoGen 式 LLM selector 每轮选人）：拒绝 v1——成本高一个数量级，MAST 基准证明失败模式来自协议缺失而非选人笨；LLM 主持人后置为单独房型。
- 备选 B2（智能体自由麦+后置熔断）：拒绝——循环风暴的实验已在学界做烂。

### D-C：代席 = facade 部署的房间形态，升级全走既有通道

值守分身就是其 facade 部署以 `on_duty` 身份入场：在房内被派发的回合，路由器的语境构造器只挂三件料——空间共享上下文（截尾窗口）、与该主人的私窗、主人显式挂载的资源；**不挂**主人私域记忆（隐私分域在构造器强制，不靠提示词自觉）。越权/拿不准 → 走 runner 既有 matters 车道给主人开串（`visitor_scope` 元数据通道的现成机制，空间场景填 `room:<id>:<memberRef>`）；「需要你」= 路由器发的定向空间事件 + 通知中继推送；接管/交还 = 在席状态机里 user 行的 `active|away` 与 facade 行的 `on_duty|listening` 翻转，纯状态不进消息流（仅落系统事件）。不可逆动作 → 部署侧 action-gate 提议，房内不另立闸。

### D-D：身份与授权模型

成员行即一切授权的载体：读空间/历史/事件流一律 member-only（非成员 404）；消息 visibility 两档（`shared` / `private:<memberId>`），查询按请求者过滤；邀请握手落邀请行（含历史授权 `join_from` | `full`、分身策略命中结果），接受即落成员行。分身被邀的应答策略（auto_accept|ask|decline）存于其主人的部署配置面，默认 `ask`。

### D-E：实时与回放 = SSE + seq 单调

`GET /api/zhiyu/rooms/:id/events?after=<seq>`：SSE 推送 + `seq` 单调递增使断线重连=按 after 重放 DB，天然幂等、无需回放缓冲区。人类消息发送=先入 DB（拿 seq）再扇出，发送方乐观回显、服务端行为权威。备选 WebSocket：拒绝——跨域/代理友好度与既有栈 SSE 先例优先，且空间人类读写幂等性好做。

### D-F：升房 = cell 导出 + gateway 播种

cell 侧加只读导出（owner 鉴权，返回指定窗口的原始消息）；gateway 的空间创建请求携带导出参数时调用之，以 `provenance: session:<id>` 落房史开场行。原会话只被读、永不回写。升房请求必须经 owner 本人令牌发起，防越权携带他人会话。

### D-G：计费复用 serving 车道，不新增结算轴

空间内每次智能体检索与应答按 wanxing facade 同型的准入与计量，以该部署的计费键结算（内部调用者，不经外部 caller key 概念）；键不可用 → 落「欠费谢绝」**系统事件**（非智能体消息）并继续。房间日预算=主办字段，路由器的预算闸在派发前检查，触顶暂停智能体派发并落如实事件。

## Risks / Trade-offs

- 空间语境膨胀（长房历史+多智能体）→ v1 路由器截尾最近 K 条 + 结束纪要不回喂；K 与纪要回喂策略单列后续优化项。
- pass 记号被智能体误用（把正常话以「过」开头）→ 保守判定+pass 事件可观测；误判方向宁可"把过当发言"（贵）也不"把发言当过"（丢话）。
- 广播征询的计费放大 → 默认上限 3 + 显式过零计费 + 日预算闸，三层都是协议强制的。
- gateway 单进程的扇出规模 → SSE 按 seq 回放，无内存缓冲寿命问题；会员数站内量级（十人级房间）远低于扇出压力阈值，规模问题留到真有那天。
- 多人同时升房/并发邀请的竞态 → 成员行唯一约束 (room, kind, ref) + 邀请行幂等键。
- 房内私密性承诺（私窗/记忆分域）被一句提示词破坏 → 分域在语境构造器代码层强制，提示词层只做呈现，不写信任攸关规则。

## Migration Plan

纯增量：三表新建、无既有表迁移；UI 入口以部署开关 `ZHIYU_ROOMS` 门控（默认关，滚版走查后开）。回滚=关开关，数据留存但不可达；无反向迁移。发布顺序：gateway 模块→runner 语境键兼容（老 runner 见到未知 contextId 键形天然按新会话处理，无协议破坏）→UI 开门→真机多账号走查（两用户+两分身同空间全链：创建/邀请//@唤醒/熔断/呼叫/接管/自动结束/纪要）→台账更新。

## Open Questions

- 结束纪要的生成车道（复用哪条模型 lane、是否用户可选）——不影响需求与任务拆分，apply 期间定。
- 广播征询 v1 并行与应答上限的交互手感（3 上限在 4+ 智能体房间是否偏紧）——上线后用真实用量校准，房间字段已可调。
- 私窗是否计入空间结束纪要的"待办归属"（涉私密边界）——apply 期间定，倾向只归公域待办。
