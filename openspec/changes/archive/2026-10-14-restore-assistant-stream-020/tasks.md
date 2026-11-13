# restore-assistant-stream-020 — Tasks

## 1. 桥转发（子进程侧）

- [x] 1.1 platform-preset-bridge：`ctx.on("agent/assistant-stream", ..., {global:true})` 订阅 + 逐帧 `transportPeer.notify("platform/stream", {sessionId, frame})`；实现期自证载荷形状（`{agent, frame}` vs `{frame}`，打点核对后定型）；`platform/capabilities` 增播 `streamForward: true`。验证：合同 runner 起真实子进程，宿主侧收到带 sessionId 的 start/text-delta/end 帧
- [x] 1.2 dsh-profile.js 的 writeUserQuestionsPatch/preset 组装不回归（桥仍激活）：`npm run dsh:contracts` 全绿（含既有 9 合同）

## 2. 宿主换源（dsh-events.js）

- [x] 2.1 新增 `platform/stream` 通知分支：sessionId→sid 映射；text-delta→`{type:"text",delta}`、reasoning-delta→`{type:"thinking",delta}`、finish(error)→`T.error`；帧按 sid 进 turn buffer（sendToViewers 既有通道）。验证：本地起 server + 慢速网关回合一轮，浏览器逐字见正文与思考块
- [x] 2.2 删除死 `case "assistant/chunk"`（连带修掉其中 `ctx.dshSessionId` 误绑，统一 `sid`）；grep 全仓 `assistant/chunk` 生产代码零残留（trace/cron/bots 归 4.x）
- [x] 2.3 降级门控：`liveControlFlags` 增 `streamForward` 位；`assistant/message` case 在 `!streamForward && !streamedText(sid) && text` 时一次性补发全量 `{type:"text",text}`（turn/start 复位标记）。验证：单测两分支（有能力不补发/无能力恰一次补发），`streamedText` 复位随 turn/start

## 3. 同源收口（cron / bots / trace）

- [x] 3.1 cron-runner.js 错误捕获改 `platform/stream` finish-error 帧；tokens 记账不动（0cc933b 已修）。验证：cron 作业失败注入用例错误可见
- [x] 3.2 bots.js 流式文本/思考改收 `platform/stream`（#collectors 按会话分键复用）。验证：bot 车道既有测试绿 + 手动一轮流式回复
- [x] 3.3 trace.js 增量行改记 `platform/stream` delta；删除 `assistant/chunk` 引用（含 fixtures）。验证：test-trace-store 绿

## 4. 合同与测试

- [x] 4.1 contracts.mjs 新增 `assistant-stream-forward` 合同（慢速流式 dummy：能力播报/帧词表/双会话归属/整轮 session.event 零 chunk 增量四断言）；编号按套件实际尾部顺延。验证：`npm run dsh:contracts` 新合同 PASS；人为改帧映射自证 FAIL 路径
- [x] 4.2 test-agent-runner 伪子进程改 emit `platform/stream`；test-turn-error-broadcast 注入形状同步。验证：`node scripts/test-agent-runner.mjs`、`node scripts/test-turn-error-broadcast.mjs` 全绿
- [x] 4.3 事件普查探针收编：本变更调研期的 census 探针（慢速 dummy + 全 method 记录）整理为 `scripts/probe-stream-channel.mjs` 入仓（--tree 可测候选）。验证：对矩阵树输出「流式期间有 platform/stream 帧、session.event 零增量」报告

## 5. 验收与出片

- [x] 5.1 单测+lint 全绿：`npm test`（或既有套件入口）零新失败；biome lint 零错
- [x] 5.2 真环境眼见：fd-prod 滚产后浏览器一轮真实对话——逐字流式正文+思考折叠+用量脚注+刷新后一致；`入/出` 数字与 assistant/message 结算一致
- [x] 5.3 降级路径实证：临时禁用桥能力位（或伪旧运行时）验证结算单发恰一次、无重复气泡
- [x] 5.4 出片滚产：快照→公开线出片→六清单滚 sha tag→rollout 全绿；归档前 `openspec validate restore-assistant-stream-020 --specs`
