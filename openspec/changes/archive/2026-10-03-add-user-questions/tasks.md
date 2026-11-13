# Tasks: add-user-questions

## 1. 子进程问询桥（dsh 侧）

- [x] 1.1 写 `dsh-profile-template/platform-user-questions-bridge.js`：子类化 `PlatformSdkServer`，构造时 `ctx.userQuestions.registerProvider`；`ask()` 挂 pending 表并发 `userQuestion/ask` 通知（sessionId/askId/questions）；`handleRequest` 覆盖 `userQuestions/answer` 查表 resolve/reject；`ctx.effect` 兜底 reject（dispose 即全部 cancelled）——单测：node 直跑 cordis 迷你上下文验证 ask→notify→answer→resolve 与 dispose→reject 两条路
- [x] 1.2 `dsh-profile.js` 生成 `user-questions.patch.yml`（disable sdk-server 行 + insert 桥行），`dsh-bridge.js` 的 `patchArgs` 顺序表追加该 overlay——验证：本地起 dsh 子进程，`openspec` 外用 probe 脚本触发一次 ask，观察通知到达宿主
- [x] 1.3 桥内 ask 无宿主响应的粗上限兜底（默认 15 分钟自动 cancel）——单测覆盖到点 reject

## 2. 宿主路由与 WS 契约（server）

- [x] 2.1 `server/dsh-events.js` 通知泵加 `userQuestion/ask` 分支：web 会话写 `ctx.pendingQuestionBySession` + 广播 `agent_question`；bot 会话走 collector；未认领丢弃（debug 日志）——单测：伪通知泵灌三种 sessionId，断言路由
- [x] 2.2 `server/ws.js`：客户端消息 `answer_question`（viewer 归属校验 + askId 命中 pending 表才转发 `dshBridge.request("userQuestions/answer")`，未命中静默忽略）；`syncReadyClient`/会话加载照 `planMessage` 附带 pending 问询——e2e：作答、先答先得（双客户端）、越权拒绝三场景
- [x] 2.3 tool_end 收敛确认：答案回显进 tool result 文本、pending 表清除、刷新后不再推 pending——纳入 2.2 的 e2e 断言

## 3. Web 前端

- [x] 3.1 `packages/core`：chat-store 增 `pendingQuestion` 切片（`agent_question` 建立态 / tool_end 清除态）+ `answerQuestion/cancelQuestion` 动作经 WS 发送；composer 门控读取该切片——单测 store 三态流转
- [x] 3.2 `web/src` ToolBlock：`ask_user_question` 且 running 渲染交互卡（选项按钮/多选/卡内 custom 文本/取消按钮；intent 忽略走通用渲染），done/error 渲染摘要——组件测试：选项作答、custom 作答、取消、plan-review 通用渲染
- [x] 3.3 `{{seconds}}` 修复：`ActivityGroup.tsx` params 改为 info 键并集透传——单测：activityDoneTimed 文案五语言无残留占位符
- [x] 3.4 i18n 五语言补卡片文案词条（zh-CN/en/ja/es/fr）——验证：切换语言渲染无 fallback 裸 key
- [x] 3.5 e2e（playwright）：网页端完整问询轮——ask 弹卡 → composer 禁用 → 选项作答 → 摘要落块；取消路径；刷新重水合后仍可作答

## 4. Bot 通道

- [x] 4.1 `server/bots.js` turn runner 处理 `userQuestion/ask`：编号选项文本渲染（multiSelect 逗号注记、无选项纯文本）、pending-ask 标记（askId/匹配元数据/尝试计数）、collectTurn 硬超时暂停顺延——单测：渲染文本快照 + 超时顺延
- [x] 4.2 `handleMessage` 拦截：size/rate 守卫后查 pending-ask，数字/原文/自由文本匹配→ `userQuestions/answer` 回注；不匹配重提示（"取消"命中取消意图）；3 次失败自动 cancel——单测：数字、原文、custom、三次失败、显式取消五路
- [x] 4.3 等待窗计时器（`BOTS_ASK_WAIT_MS` 默认 600000）到点自动 cancel 并恢复超时——单测到点路径
- [x] 4.4 answer-only 豁免：回复侧工具衍生检查放过"问询已 resolve"的 turn（`BOTS_ALLOW_TOOLS` 不开也放行）——单测：ask 轮的最终回复不被 withhold
- [x] 4.5 e2e：伪 adapter 走一轮 bot 问询（问出→数字作答→收尾回复）；等待窗过期取消路径

## 5. 小程序

- [x] 5.1 `miniapp/src` Taro `QuestionCard` 组件 + 挂进 TurnView/工具块渲染位：选项/多选/custom/取消 + composer 门控（共享 core 切片）——**代码+typecheck+weapp build 已过；wechatide 真机走查待补（归档时用户决定先行勾结）**：真实 ask 一轮作答；另一端先答时小程序收敛

## 6. 集成验收与收尾

- [x] 6.1 全量回归：`make lint` + 单测 + 既有 e2e 套件无回归（重点 chat-streaming / tool-use-rendering / chat-activity-collapse 相关 spec）
- [x] 6.2 bug3 观察：修复后的真实会话里"写计划→委派→问询→计划推进"流程复跑，右侧面板随 todo/write 推进（仅观察验收，不做行为工程；不推进则记录为模型纪律债）
- [x] 6.3 fd-prod 冒烟：部署后真实 ask 一轮（web + 公众号 bot），确认 NO_PROVIDER 消失、答案回流、{{seconds}} 渲染正常

## 7. 上线后追加（2026-10-02 fd-prod 实测）

- [x] 7.1 网关 bot webhook 机器路由（gateway/bot-webhooks.js）：多租户网关对无身份平台回调 401 的缺口；botId→cell 共享卷解析+正负缓存+可唤醒停止 cell；解析器单测 4/4、cell 回归 5/5；fd-prod 握手探针 200+echostr 回显
