# fix-audit-code-gaps — tasks

## 1. 值班环唤醒 interval/one-shot

- [x] 1.1 `lib/cell-lifecycle.js` cronJobsDue 扩展：interval recurring 按锚点+周期网格（与 cron-module 同口径）、未来 one-shot 提前可唤醒、cap 跑满不唤醒（顺带修 capped cron 无限唤醒隐患）、paused 不唤醒语义保持
- [x] 1.2 cron.js boot/resume/update 三条 re-arm 路径补 interval（实施中发现的伴生缺陷：原写死 task.cron，ring 唤醒后 cell 自身不武装任务白醒）
- [x] 1.3 测试：test-cell-lifecycle-wake 13 条新增 + cron-parity +3 arming；相关 54 测全绿

## 2. chat-input-focus

- [x] 2.1 startNewSession（New chat//new/REST 三条创建路径唯一汇合点）打 created 标记 → useWebSocket 派发 session_created → ChatPage bump focusTick
- [x] 2.2 验证：typecheck+biome 绿；web 面无单测惯例，手工验证清单三条已记（New chat 聚焦//new 聚焦/切换与预填卡回归面不受扰）

## 3. 陈旧注释批（零语义）

- [x] 3.1 cron.js 两条（interval 头注 phase 失实、insertTask persona-only 过时）
- [x] 3.2 design-lint.mjs 头注 Five→Six、blueprint-judge.js:169 选型顺序注释

## 4. 收尾

- [x] 4.1 spec delta：cell-gateway（wake 覆盖 interval/one-shot+legacy carve-out）+ cell-lifecycle（唤醒语义扩展）——strict 绿
- [x] 4.2 出片上产：快照 1275719（run 42109989448 绿）→ relay → fd-infra-deploy 7715543 双清单（gitee 为 ArgoCD 真源）→ 双滚到位（facet-bbfbcd5db/platform-ff945985d 均 sha-1275719 Running，app Healthy，facet catalog 200）+ strict 归档
