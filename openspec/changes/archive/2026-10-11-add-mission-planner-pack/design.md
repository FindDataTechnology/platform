# design — add-mission-planner-pack

> 前置：① add-mission-definitions（fd-wanxing）已实施——brief/回写/GET 轮询契约是本
> pack 技能正文的规范来源。本 change 零平台行为变更（skip specs，spider-heal 先例）。

## D1 pack 形状

- 纯 persona + 四技能，**无 MCP 引用**（工具族=标准 preset 面：search_agents/delegate 在册则用；bot_notify 走部署的通知桥）。
- serving：a2a + rhythm（缺省 15m 自巡检——mission 的多回合驱动靠它；env 可覆盖）+ turnMinutes 30。
- visibility private，萬星运营号自营（与 spider-heal 同档）。

## D2 技能内容要点（正文规范）

**mission-protocol**（对外唯一约定）：
- brief 解析：MISSION id / goal / model / window / cost cap / approval / writeback URL+token。
- 动词：`GET <url>`（X-Mission-Token 头）轮询；`POST` 写回 `{kind,payload,idempotencyKey}`。
- 状态机地图（planner 视角）：planning→[plan]→awaiting_approval（人批：只轮询）|auto_approved→[ready]→scheduled→[首个 step running]→executing→…→[report]→reported；任何活态可 [fail]。
- 幂等纪律：每次写回唯一键 `wb-<mission短id>-<序号>`；重发安全（服务端按键回放）。
- 每回合动作表：醒来先 GET，按状态分派——planning=出计划；awaiting_approval=本回合不动；scheduled=开首步；executing=推下一步；终态=收尾。

**mission-planning**：
- 拆解 ≤8 步（v1 上限，防长尾）；每步 `{id: s1.., prompt, agent?}`；prompt 自含验收标准。
- agent 归属：**search_agents 实查在册才可填**；查无合适者该步自行执行（agent 留空）；绝不编造 agent 名。

**mission-execution**：
- 串行；一步一状态回写（running/done/failed+note）；delegate 在册则委派 a2a，否则自行执行。
- 窗口纪律：每次醒来核 `now` vs window_end——窗尽 → `fail{reason: 窗口已尽}`；窗外不开新步。
- 失败重试 ≤1；二次失败 → `fail{reason}`。预算将尽（brief 的 cap）→ 完成当前步后 `report` 部分成果并注明未竟事项。

**mission-reporting**：
- 终态报告：summary（结论先行+逐步结果）+ artifacts（产物清单）；`report` 写回。
- `bot_notify("mission_terminal", …)` 一条（通道=部署绑定；未绑定则如实注明不重试）。

## D3 部署与上线

- 发布/部署脚本沿 spider-heal-pack.mjs 形状（publish 幂等续版 → deploy 省略 secrets=保留）。
- 上线序列：①② 同窗——fd-wanxing 镜像（scs001 fd-wanxing-images 线）→ GitOps 滚 facade + env（MISSION_PLANNER_SLUG=planner slug、WANXING_PUBLIC_BASE_URL=公网基址）→ planner pack 发布+部署 → 生产真 mission（auto 模式首选：无人工环节，e2e 全自动可探）。
- e2e 判据（M2 出口首个样本）：mission created→submitted→planning→auto_approved→scheduled→executing→reported；spent>0 记账在 wanxing_usage.mission_id；console 面板可见计划步骤与报告。

## D4 测试

- `scripts/test-mission-planner-pack.mjs`：manifest 校验（validatePackManifest）+ 技能正文断言（五 kind 词表/幂等键句式/search_agents 纪律/窗口句式在册）。
- 生产 e2e 走查脚本 `scripts/mission-live-e2e.mjs`（paas 侧）：铸 JWT → 建 mission → 轮询到终态 → 断言链。
