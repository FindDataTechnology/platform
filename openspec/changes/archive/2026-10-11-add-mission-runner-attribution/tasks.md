# tasks — add-mission-runner-attribution

- [x] 1.1 manager.js 回合事件 payload 补 session+tokens（D1），验证：单测断言事件载荷
- [x] 2.1 planner pack v2 技能三律（D2）+ 断言（D4），验证：pack 测试绿
- [x] 3.1 出片滚 runner + planner v2 发布部署，验证：生产 mission 回合事件带 session/tokens（实测：镜像 a210cd6 滚 runner；planner v2 部署 kept bindings；标语任务 90s 全链 reported 两步全 done——v2 终态纪律生效；turn_started/turn_ended 带 session=srv-mission-<id>。附记：tokens 在 usage 缺失时曾写 null，已修为缺席（29d7ba8 后一笔，随下次 platform 滚动））
