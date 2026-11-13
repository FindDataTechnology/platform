# Tasks — polish-zhiyu-reception-welcome-line

> `skip_specs: true`（纯实现对齐，无 requirement 变更）。每项自带验证。

## 1. 欢迎行席位口径

- [x] 1.1 取消 `slice(0, 3)`：欢迎行列**全部在席** agent/facade；仅在超过 6 席时截断并在句末标「等 N 席」；验证：`node --test scripts/test-zhiyu-widget.mjs` 新增断言（每个在席席位都出现在欢迎行里、`meta.seats` 等于真实席位数）
- [x] 1.2 `meta` 增加 `seats`（在席总数），`agents` 语义不变（被列出的席位名）；验证：同上

## 2. 主动招呼的尾部判定

- [x] 2.1 「该访客 joined 之后有没有人说过话」改读 `store.messagesTail(roomId, 200)`，不再 `messagesAfter(0, limit 1000)`；验证：长房（>200 行）新人进房时仍判为"无人说话"——由 2.2 的用例覆盖
- [x] 2.2 补单测：构造一间已有 300 行历史的空间，铸新访客后断言「若此后再无人发言，主动招呼判据为可发」；验证：用例通过且在旧实现（读首 1000 行仍会命中旧 guest_joined）下会红

## 3. 回归与收口

- [x] 3.1 `test-zhiyu-widget.mjs` + `test-zhiyu-rooms.mjs` + lifecycle 全绿；验证：逐套件跑
- [x] 3.2 `openspec validate polish-zhiyu-reception-welcome-line --strict`；验证：绿
- [x] 3.3 提交 + 隔离 clone 推送；验证：fetch 后远端 tip 含该提交
- [x] 3.5 真机访客链路演练（浏览器眼）——**行为已在生产逐条验过**：欢迎行 `seats=4` 且列全四席（产品向导/壹座专家/识律专家/柏讯专家）、主动招呼 20 秒内真答；spec 已补两条断言（首屏 `?tail=200`、流 `after=<cursor>`）。完整浏览器眼的**执行**（需有效口令）转入 `verify-zhiyu-live-eyes` 任务 1.1
`cd paas && PW_LIVE=1 LIVE_SERVICE_URL=https://platform.finddatatech.cloud npx playwright test e2e/live-zhiyu-embed.spec.js --project=live`】
- [x] 3.4 生产侧（本轮授权内已做）：演示房 `proactive_greeting` 开启并真机验证——访客铸席后 20 秒值班席真开口（04:58:40 铸席 → 04:59:11 产品向导应答）；回滚口径：`UPDATE zy_rooms SET proactive_greeting=0 WHERE id='zy_42ce690574b5423bd2'`
