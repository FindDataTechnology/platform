# tasks

- [x] 1. gateway：matters 表（id/pack/agent/deployer/summary/visitor_hint/status/timeline
       JSON/created_at/updated_at）+ registry 方法（open/listForDeployment/read/reply/close）
       + internal 路由三支（open/list/read，internalAuth）+ 主人路由三支（list/reply/close，
       登录态+归属 404）+ 单测
- [x] 2. agent-runner：matters overlay（bridge row 子类，`matter_open`/`matter_status`/
       `matter_read` 三工具，descriptor.facade 门控）+ runner 执行器（限速桶+internal
       调用+开串 piggyback bot_notify+len-only 审计）+ 单测（挂载门控/限速/非 facade 无工具）
- [x] 3. web：包详情分身面板事项区（待回应清单/回应框/关闭+说明）+ 五语言
- [x] 4. e2e：主人队列回应闭环一案（route-mock 线）；分身工坊指南补「越界=开事项」纪律段
       （v3.1 文案随产）
- [x] 5. 验证面：gateway 单测+runner 单测+typecheck/biome/check:locales+e2e 全绿
- [x] 6. 上产：出片列车滚 facet/platform/platform-demo+agent-runner-serving（runner 本班
       必滚——工具面变化）；生产构造验收（经代理通道开串→队列眼见→回应→对话读回）；
       台账 §15.42；归档
