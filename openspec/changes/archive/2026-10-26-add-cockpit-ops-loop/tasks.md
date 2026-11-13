# Tasks: add-cockpit-ops-loop

- [x] 1.1 检查器「立即交付」:config 页签按钮(member.taskId 存在才渲染)→ POST /api/cron/:id/run,already 诚实提示;i18n 五语言(inspector.runNow=立即交付等);验证:e2e stub run 通道断言调用与提示
- [x] 1.2 抽屉自刷新:MemberInspector 订阅 fleet store version,回合结束自动重拉 turns/reports/decisions;验证:e2e 注入 fleet_turn_ended→turns stub 计数增加
- [x] 1.3 兜底轮询:FleetsPage 60s setInterval(可见时+有选中)+visibilitychange 补拉;验证:typecheck/build 绿(轮询行为构造验证留真机)
- [x] 1.4 fleets e2e 全量回归+出片随下班车+浏览器眼见(立即交付真点一轮/抽屉自刷新)
