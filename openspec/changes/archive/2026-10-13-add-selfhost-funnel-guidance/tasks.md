# Tasks — add-selfhost-funnel-guidance（F3.1）

- [x] 1.1 gateway serving-status 探针（注册序防 :id 捕获）
- [x] 1.2 PackDetailDialog 引导面板（探针前置+503 竞态同面板+官方路径不变）
- [x] 1.3 官方侧创作者动线文案（MineView 漏斗说明+空态创作指南）
- [x] 2.1 测试+build+parity 绿；镜像三面滚+OSS 快照
- [x] 2.2 生产验证+归档+路线图 F3.1 ✅

## 验收实证（2026-10-12/13 生产）

- 探针两向单测（58/58 agent-serving）；生产 platform+facet 双实例 `{"configured":true}`。
- 引导面板眼见：facet 壳 #/packs（同源 PackMarketView、免登录）+ 预启动注入 stub
  （configured:false）→ 打开「一键流验收」详情=引导面板（漏斗文案+市场/创作指南双
  按钮）且部署表单正确隐藏；官方路径（真 configured:true）=原部署表单渲染（浏览器
  两见）。**排障教训**：懒加载分块的模块级 fetch 绑定会让晚装 window.fetch stub 失效
  ——必须 CDP addScriptToEvaluateOnNewDocument 预启动注入。
- MineView 文案（漏斗全链+空态指南链接）随 facet 面上线；五语 1151 键 parity。
- 镜像 sha-5c9f532 三面滚；OSS f298100。
