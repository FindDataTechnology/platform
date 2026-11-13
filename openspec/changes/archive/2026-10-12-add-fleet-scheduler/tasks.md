# Tasks: add-fleet-scheduler

- [x] 1.1 planAgentPort 提炼（部署/调度器共用，serving 53/53 不变）。
- [x] 1.2 gateway/fleet-scheduler.js：心跳健康/陈旧判定/容迁改点（GET→改→PUT）/滞回/容量门/优雅降级。
- [x] 1.3 packs.js 接线：env 门启动+部署自动选址（多行→最空闲健康机；board 盲→旧行为）。
- [x] 1.4 测试：test-fleet-scheduler.mjs 7/7（改点/默认未标注/防撞改判/无目标不动/满段穿透/滞回/选址排序/双面断电跳拍）+全相关套件绿。
- [x] 2.1 GitOps：facet 启用（FLEET_SCHEDULER_ENABLED+board env）+配额 24Gi+runner-c（cheap-7）+llm Secret 挂载+机群表行。
- [x] 2.2 生产容灾演练（2026-10-12 四证 PASS）：①三机上线（cheap-1×5+runner-b+runner-c@cheap-7，llm Secret subPath 免手工种子）②facet 调度器 armed；③演练=runner-b GitOps 缩 0→心跳停→observer 剔板→**孤儿检测自动改点**（'absent from the board (pruned) — re-pointing'→demo→runner-c:8893 防撞端口）→runner-c 接管→真回合 200 答复；④拉回 runner-b→**滞回成立**（demo 留 runner-c）。演练三抓三修：provider GET 串/PUT dict（422）、version 数字/串（422）、板上缺席孤儿检测+新行 10min 供应宽限。
- [x] 2.3 归档+记忆。
