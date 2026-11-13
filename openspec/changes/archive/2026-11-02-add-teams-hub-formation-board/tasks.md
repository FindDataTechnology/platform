# Tasks: add-teams-hub-formation-board

## 1. 聚合载荷扩展（服务端）

- [x] 1.1 `GET /api/fleets/overview` 载荷加每队 `formation` 紧凑摘要（members 节点四元组 + edges kind/from/to，按既有编排读面导出，不新造状态计算）；既有消费方回归绿（字段增位零破坏）；合同测试断言 8 队一次取齐且无 N+1 详情请求形态
- [x] 1.2 大队护栏：摘要含密度上限信号（节点数>N 时置 truncated），单测覆盖超限团队

## 2. 编队视图（Web）

- [x] 2.1 `FleetGraph` 参数化 mini 形态（去标签点节点+tooltip、密度参数、状态色覆盖；布局算法与 kind 着色同源不复制）；组件测试=同一编排驾驶舱图与 mini 图的节点/边集合一致
- [x] 2.2 `FleetsPage` 综合看板加视图切换（卡片列表 ↔ 编队，选择持久化）与编队栅格：懒渲视口外 SVG、断线/缺岗图上标注、点击直达 `/fleets/:id` 深链；e2e 三断言（切换持久、断线可见、点开进舱）
- [x] 2.3 降级：编队读面失败时该视图标注不可用+重试，卡片列表不受影响（沿用三路独立降级条款）

## 3. 看板副驾

- [x] 3.1 副驾面板挂看板：`CopilotDock` 以团队架构师聚焦 preset + 名册/选中队上下文打开（iframe 隔离沿用）；架构师未装/车道失效如实降级；单测=上下文注入断言 + 降级态断言
- [ ] 3.2（**挂账：需真装团队架构师包走 a2a 车道**，fast e2e 无此 fixture；降级路径已由「无架构师 → iframe 无 preset」e2e 断言覆盖）调线闭环 e2e：一句话改线 → dry-run diff 呈现（无直接 apply 入口）→ 批准 → 广播后编队图自动重渲出新增边【归档挂账 2026-11-02：种子在仓（docs/fleet-architect.seed.json）但需真环境装包走 a2a 回合，属生产走查班动作，非 hermetic 可伪造】
- [x] 3.3（**按构造成立且 2026-10-31 代码对照走查过**：CopilotDock=纯 chat iframe（/chat?embed=copilot），网络面仅 GET /api/fleets/copilot（preset 解析）与 GET /api/boards/<line>/copilot，postMessage 单向注入上下文（board/fleetId/pack）不出命令；TeamsOverviewBoard 与 FleetGraph 全 GET 读面零 fetch 写——本刀未新增任何 apply 手势，批准纪律在架构师工具面原样生效（该面属架构师包既有测试域，本 change 未触碰））批准纪律看板侧回归：确认副驾面无绕过 apply 的手势（对照架构师批准条款测试清单）

## 4. 门与收口

- [x] 4.1 i18n 新键五语言齐（编队/副驾入口/降级文案），locale 完整性门绿（2026-10-31 复核 `check-locales.js` 全绿，并补 `tasks.actions.edit` 五语言——真机走查 T4 揪出裸键上板）
- [x] 4.2 全量回归 `test:unit` + teams/cockpit 合同套 + e2e 绿；`openspec validate` 绿（2026-10-31 合 main 后净 worktree 全量 **2914 tests / 2912 pass / 0 fail / 2 skip**（排除 supervisor-ports 与 supply-owner-acceptance-live 两环境绑定用例，§15.113 续记三）；teams/formation 合同套绿；validate **223/0**）
- [ ] 4.3 真机走查挂账（台账，**归档移交 2026-11-02**）：滚版后生产看板眼见——8 队一次取齐、断线上浮、一句话改线闭环三眼见；大队（30+岗）缩略形态上眼（**2026-10-31 真机眼见两/三**：编队栅格 29 mini formation 一次取齐 + 失联/待补岗计数上浮（t1b/t2 截图，§15.113）；副驾 fleets 线诚实降级眼见；**改线闭环随 3.2 真装架构师班**）
