# Proposal: add-user-questions

## Why

`standard` 预设组合的 `ask_user_question` 工具在平台上是断链的：dsh 的 user-questions seam（`ctx.userQuestions` 单槽）要求宿主注册渲染 provider，桌面 TUI 自带而平台从未接线，于是模型一调即 `NO_PROVIDER`——用户在网页端看到的是整步标红的报错（"执行中遇到问题"），agent 的"问完再收尾"流程整体中断（右侧计划进度也因此冻死）。顺带两个对话面缺陷：活动组标题在"已思考 X 秒 · 执行了 Y 步"情形下把 `{{seconds}}` 原样渲染；子代理完成后计划面板不推进（前者是一行参数丢失，后者按 ADR-0012 的问询修复后预期自然走通，仅留验收观察）。

## What Changes

- dsh 子进程内新增问询桥插件（照 permission-bridge 先例）：注册 `ctx.userQuestions` provider；`ask()` 经独立通知（既有子→宿泵，不入会话日志）转出；新增 `userQuestions/answer` JSON-RPC 方法（既有宿→子方向）回注答案并 resolve 挂起的工具调用；运行时重启/中止时 provider 自动 reject 挂起 ask。
- 宿主按 sessionId 路由问询：web 会话广播新 WS 消息 `agent_question`、按会话持有唯一 pending 态、随连接 sync 重水合；bot 会话转发至既有 turn collector。
- web/小程序把 `ask_user_question` 工具块渲染为问询卡片（选项按钮 + 卡内自由文本=custom + 取消按钮），挂起期间 composer 禁用，多端并发先答先得；已完成问询以摘要形态随聊天历史重放。
- bot 四通道（公众号/企微/飞书/telegram）以编号选项文本问出，等待期下一条入站消息拦截为答案（数字/选项原文/自由文本），不匹配重提示至多 3 次后自动取消；等待窗默认 10 分钟（env 可调），期间 turn 硬超时暂停。
- bot answer-only 姿势对 `ask_user_question` 白名单豁免（回复侧工具衍生检查不拦问询）。
- 修复 `{{seconds}}`：活动组标题参数同时传 `seconds` 与 `count`。
- plan-review 专用卡片与"先讨论再答"不做（通用选项渲染，协议合法）；问询不设 per-bot 开关，默认全开。

## Capabilities

### New Capabilities

（无——全部挂既有能力）

### Modified Capabilities

- `dsh-runtime-bridge`: 新增宿主侧问询桥——provider 注册、ask 外转通知、answer 回注 RPC、重启中止语义
- `web-chat-server`: 新增问询 WS 契约——pending 态按会话持有、广播/重水合、客户端作答消息与归属校验、bot 会话路由
- `web-chat-ui`: 新增问询卡片呈现——工具块形态、选项/custom/取消交互、composer 门控、先答先得收敛
- `miniprogram-client`: 新增小程序问询卡片（与 web 交互对齐）
- `social-bot-channels`: 新增 bot 问询——编号文本问出、入站拦截作答、匹配重试与自动取消、等待窗与 turn 超时暂停、answer-only 豁免
- `chat-activity-collapse`: 活动组标题参数插值修复（seconds+count 双占位符完整填充）

## Impact

- 代码：`dsh-profile-template/`（新 bridge + patch overlay）、`dsh-profile.js`/`dsh-bridge.js`（overlay 生成与排序）、`server/dsh-events.js`（通知路由）、`server/ws.js`（新客户端消息 + sync）、`server/bots.js`（拦截作答）、`packages/core`（store 切片）、`web/src`（卡片组件 + composer 门控 + ActivityGroup 修复 + 五语言词条）、`miniapp/src`（Taro 卡片）。
- 契约：WS 协议新增 `agent_question` / `answer_question` 两条消息（纯增量，旧客户端忽略未知消息）；dsh 侧零改动（不触上游包）。
- 决策依据：ADR-0012（宿主侧 provider、不造反向 RPC）；词汇表「问询（User Question）」。
- 不影响：`{{seconds}}` 修复为纯前端参数传递；bug3（计划推进）不改代码，仅在验收中观察。
