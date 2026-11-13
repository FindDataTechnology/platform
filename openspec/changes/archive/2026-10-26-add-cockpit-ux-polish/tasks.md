# Tasks: add-cockpit-ux-polish

- [x] 1.1 FleetsPage `loadDetail` 失败自愈:2s/4s 有界重试(至多 2 次),selectedRef 守卫换舰取消;验证:e2e cockpit 首刷 500→重试成功自动呈现,双失败停在错误不风暴
- [x] 1.2 RunTimeline 默认选中最新 run(仅初始,runsVersion 不跳选)+ run 行单次岗位名;验证:e2e 打开即瀑布可见;新 run 到达选中不变
- [x] 1.3 `routes/trace.js` listTurns 批量关联 fleets.db(`annotateFleetTurns` 纯函数导出)+ core 类型 `fleet?`;TracePage 徽章与舰队入口 + i18n 五语言;验证:单测 纯函数命中/未命中/多行;构造真机 Trace 页舰队回合带岗位徽章
- [x] 1.4 全量回归(fleets e2e+typecheck+biome)+出片随下班车+浏览器眼见(深链自愈构造一次失败;Trace 徽章)
