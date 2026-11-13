# Design: add-user-questions

决策总纲见 [ADR-0012](../../../docs/adr/0012-user-questions-are-host-provided-via-bridge.md)：宿主侧补全 provider、走既有双向通道、不造反向 RPC、不改上游。本文件只记 ADR 之下的技术落法。

## Context

dsh 的 user-questions seam 是子进程内单槽服务（`ctx.userQuestions`），TUI 在客户端注册 provider；平台与 dsh 的唯一通道是 stdio JSON-RPC（宿主→子 request 既有、子→宿 notification 既有），宿主侧 `HarnessClient` 不支持反向 request。事件泵按 sessionId 路由：web 会话走 WS 广播，bot 会话走 `sessionCollectors`，未认领即丢弃。`tool/call` 块带完整参数进 `dshTurnBlocks` 并随 `assistant/message` 持久化——问询的呈现与重放可以骑在这条既有轨道上。

## Goals / Non-Goals

**Goals**：三端（web/小程序/bot 四通道）问询闭环；零 dsh 上游改动；pending 态可重水合；多端先答先得；bot 等待窗与 turn 超时解耦。

**Non-Goals**：plan-review 专用卡片与"先讨论再答"（二期）；问询审计流（dsh invariant 明言 seam 不发布）；per-bot 问询开关；bot 侧多媒体问询（仅文本）；计划推进的行为工程（bug3 仅验收观察）。

## Decisions

**D1 子进程桥照 permission-bridge 子类化，而非独立插件**。新文件 `dsh-profile-template/platform-user-questions-bridge.js` 子类化 `PlatformSdkServer`：构造时 `ctx.userQuestions.registerProvider({ask})`；`ask()` 把请求挂进内存 pending 表并向宿主发独立通知（方法名 `userQuestion/ask`，载荷：sessionId、askId、questions——复用 `session/event` 同款的泵路径但不写会话日志）；`handleRequest` 覆盖新增 `userQuestions/answer`（参数：sessionId、askId、`answer` 或 `cancelled:true`），查表 resolve/reject。备选"独立插件直接 export apply"被否：cordis patch overlay 无法改写 preset 桥已插入的 loader 行，只能 disable+insert，子类化是本仓已验证的叠加方式（permission 桥注释在案）。生命周期：`ctx.effect` 注册的 provider 随 fiber dispose 自动注销，pending 表内的 ask 全部 reject（cancelled）——重启/中止语义由 cordis 结构免费获得。

**D2 patch overlay 由 dsh-profile.js 生成、dsh-bridge.js 排序追加**。照 `permissions.patch.yml` 先例：`dsh-profile.js` 写 `user-questions.patch.yml`（disable `platform-sdk-server` 行、insert `platform-user-questions-server` 行），`patchArgs` 顺序表尾部追加。层序依赖：必须在 preset/permission overlay 之后（它 swap 的是它们 swap 过的行），照 chart-bind 桥的排法。

**D3 宿主路由与 pending 态放 `ctx`，照 planMessage 模式**。`dsh-events.js` 的通知泵加一个方法分支：`userQuestion/ask` 按 sessionId 路由——等于 `ctx.dshSessionId` 时写 `ctx.pendingQuestionBySession`（至多一条，新 ask 到来时旧的按 cancelled 处理，理论上不会发生：turn 内工具调用串行）并广播 WS `agent_question`；否则走该会话的 collector（bot 路径）。`syncReadyClient` 与会话加载处照 `planMessage` 附带 pending 问询（无则不发，避免旧客户端多处理一条空消息）。答案回注经 `dshBridge.request("userQuestions/answer", …)`。

**D4 WS 契约纯增量两条**。服务端→客户端 `agent_question` `{askId, toolCallId, questions}`（toolCallId 供前端把卡片锚到工具块）；客户端→服务端 `answer_question` `{askId, answers} | {askId, cancelled: true}`。校验：发送者必须是该会话 viewer（复用 `sendToViewers` 的归属判断数据）；askId 必须命中该会话 pending 表，否则忽略（先答先得的"后到即落空"）。tool_end 到达时（答案即工具结果）广播路径自然把所有端收敛到已答态——**收敛不靠额外消息，靠既有 tool_end**，这是本设计最省的一处。

**D5 前端：卡片即工具块的特殊渲染，不新增块类型**。`ToolBlock` 对 `name === "ask_user_question"` 且 `state === "running"` 渲染交互卡（选项按钮/多选/卡内文本框/取消），`done/error` 渲染摘要（结果文本里带答案回显——D1 的 answer RPC 让 dsh 把答案写进 tool result，摘要免费）。store 加一个 `pendingQuestion` 切片驱动 composer 门控与提交动作。重水合 = `agent_question` 消息直接重建 `pendingQuestion`（刷新后即使工具块状态还是 running——mid-turn 本就不重放——卡片照样可答）。i18n 五语言词条随卡片文案一次补齐。

**D6 bot：拦截在既有管线内，等待窗是 turn 超时的暂停器**。`bots.js` 的 turn runner 收到 `userQuestion/ask` 通知时：渲染编号选项文本经 adapter 发出（multiSelect 注明逗号分隔；无选项纯文本问），把该 chat 标记 pending-ask（含 askId、匹配元数据、尝试计数），并**暂停 collectTurn 的硬超时计时**（实现上：pending 期间顺延 deadline）。`handleMessage` 在 size/rate 守卫之后查 pending-ask 标记：命中则作答（数字→选项、原文→选项、否则 custom 或重提示，3 次失败自动 cancel）并 return，不排新 turn。等待窗计时器（默认 10 分钟，`BOTS_ASK_WAIT_MS`）到点自动 cancel 并恢复正常超时。answer-only 豁免：`NO_TOOLS_PREFIX` 不变（禁的仍是自主工具调用），回复侧检查对"问询已作答"的 turn 放行——判定即该 turn 期间发生过 ask 且已 resolve，答案本身是用户的话。

**D7 小程序共享 core、自绘卡片**。`packages/core` 的 store/WS 客户端小白得；Taro 组件 `QuestionCard` 对齐 web 交互（选项/多选/custom/取消 + composer 门控）。不做 history 摘要的特殊态——小程序历史渲染已有降级路径，工具块按既有文本形态回显即可。

**D8 `{{seconds}}` 修复**。`ActivityGroup.tsx` 的 params 组装改为把 info 中出现的键全量透传（`{...}` 展开 step/count/seconds 的并集），不逐分支枚举——三个 key 的组合还会随词条演化，透传消灭这类漏参。

## Risks / Trade-offs

- [pending 表在 server 重启（dsh 子进程不死、宿主进程死）时丢失，子进程侧 ask 永挂] → 概率低（宿主重启通常伴随子进程重建）；兜底：桥的 ask 无宿主 ACK 时设一个粗上限（如 15 分钟）自动 cancel——实现为一行 setTimeout，不做 ACK 协议。
- [bot 用户在等待窗内发的是无关消息（不想答题）] → 匹配失败按重提示处理，3 次后取消；用户也可显式回"取消"二字（匹配到取消意图）。不完美——聊天语境歧义是文本通道固有代价，ADR 已认。
- [web 刷新后 mid-turn 工具块不重放，卡片与活动组状态可能不同步] → `agent_question` 重水合独立于块状态，卡片可答可收敛建立在 tool_end 之上，刷新后收敛路径不变。
- [dsh 升级若给 user-questions 增通知/审计流，桥可能与上游方案重叠] → dsh-contracts 门控矩阵会先撞见；桥是宿主侧实现，上游若提供官方 host-provider，替换成本集中在一个文件。

## Migration Plan

纯增量部署：新 overlay 与 bridge 随下一次构建分发；旧客户端忽略未知 WS 消息；`{{seconds}}` 修复随前端包走。回滚 = revert 镜像，无数据迁移。验证顺序：本地 e2e（web 作答/取消/重水合、bot 数字作答与超时）→ fd-prod 冒烟（真实 ask 走一轮）。

## Open Questions

（无——探索与两轮问询已把可推迟项收敛；等待窗默认值与 env 名在实现期定死即可。）
