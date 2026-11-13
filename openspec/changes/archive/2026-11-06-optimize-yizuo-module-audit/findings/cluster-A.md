# 簇 A（agent 核心面，18 条）spec 体检 findings

仓：/Users/chengsishi/finddata/paas。审计日 2026-11-06。只读审计：spec（openspec/specs/<name>/spec.md）逐条对照代码（gateway/ server/ server.js web/src agent-runner/ lib/ facet/ scripts/ 根目录 *.js）。注意一坑：`agent-runner/manager.js` 含非常规字节（`file` 判为 data），grep 需 `LC_ALL=C grep -a`，否则整文件漏检——本报告所有 manager.js 证据均已用 `-a` 复核。

## 1. 18 条判定总表

| spec | 评级 | 一句话发现 | 关键证据 |
|---|---|---|---|
| agent-catalog | A- | 五源合并/角色门/脱敏/a2a/双刷新全部对齐；`v1 共享会话天花板`仍真，但 spec 的 emit-targets 命名与代码 tool 名有简写漂移 | catalog.js:22-23,359-366; server/routes/misc.js:211-216 |
| agent-cluster-core | A- | 路由/限额/去重/广播全在；spec 的「载入集群 SHALL 切到第一个默认成员」在实现里 leader 无默认时静默降级取首项 | server/routes/clusters.js:52-354; web/src/components/AssistantPicker.tsx:167-190 |
| agent-delegation-a2a | A- | C-lite 凭据选择/深度头/两级发现全对齐；spec 的 registry gateway URL 硬编码示例（mcp.finddatatech.cloud）与代码 env 化略陈旧 | server/a2a-client.js:24-49,65; agent-runner/a2a.js |
| agent-delegation-tools | A | 四工具/扇出/聚合回投/权限门/任务卡全对齐；唯一小瑕是 spec 用短名 delegate/progress/result，代码注册名是 delegate_task/task_progress/task_result | server/delegation-mcp.js:57,78,91,97; server/delegation-aggregator.js:3-32; web/src/components/TaskCard.tsx |
| agent-document | A- | 单一三桶模型/单一校验器/blueprint kind 两型全对齐；「emit targets 不产生第二内容形状」由代码注释与 cast 拒绝佐证，但四 emit target 的个人 preset emit 路由未在 blueprints.js 内点名 | server/routes/blueprints.js:162-167,308-328,459-460; lib/pack-manifest.js:1082-1083 |
| agent-fork-lineage | A | forkOf 校验/lineage 展示/官方语义/facet 深链全对齐 | lib/pack-manifest.js:1120-1136; web/src/components/packs/AgentSpecSheet.tsx:84-85,212; web/src/pages/AgentStudioPage.tsx:313-327; facet/web/src/App.tsx:211 |
| agent-preset-selection | A- | roster/push/set_preset/broken/统一选人面全对齐；`presets` 推送 `{presets,current}`、`set_preset` 流式拒绝均落在既有 switchPresetTo 守卫，但 set_preset case 本身不含显式 isStreaming 判断（靠 switchPresetTo 内部拒绝），契约语句与实现位置有一跳 | server/ws.js:286-292,827-843; server/agent-session.js:902-903; web/src/components/AssistantPicker.tsx:1,129-190 |
| agent-residency | A | 不闲收/warm zone/预算逐出/节奏自转/暂停可逆全对齐，且 ADR-0010 注释直接点名 spec | agent-runner/manager.js:1-9,386-400,753-772; agent-runner/index.js:190-208; agent-runner/scheduler.js:3-78; agent-runner/rollover.js:1-5 |
| agent-scheduling-tools | A | 五工具（含 update）/扩表单/cluster 任务/坏 cron 结构化错误/任务卡全对齐 | server/cron-mcp.js:72-311; web/src/components/ToolBlock.tsx:100-120 |
| agent-self-iteration | A- | 记忆章程声明→目录透传→persona 组成→成本异常提案→人批 updateMember 全链在；仅「驳回即终/去重计数」的细节在测试而非路由可见 | lib/pack-manifest.js:1536-1540; dsh-profile.js:2128-2134; server/fleet-cost-digest.js:111-193; server/routes/fleets.js:2464-2480 |
| agent-service-config | A- | 读写双门/三态合并/车道+白名单+花名册三闸/会话边界热切/升级存续全对齐；spec 说 UI 在「萬星 console agent 详情页」，本仓只有 API 双门与 console 深链注释，console UI 本体不在本仓（跨仓归属） | gateway/packs.js:3233-3484; agent-runner/harness/dsh.js:60-175; agent-runner/manager.js:445-470; e2e/agent-service-config.spec.js |
| agent-spec-sheet | A | 单一契约/三桶恒渲/badge 派生/provenance 合成/guide 文档直出全对齐；facet 复用同一组件达成「两处一致」 | web/src/components/packs/AgentSpecSheet.tsx; web/src/components/packs/PackMarketView.tsx:458; facet/web/src/App.tsx:10; AssistantPicker.tsx:263; AgentStudioPage.tsx:1059 |
| agent-teams-management | A | 行内编辑三字段/批量逐条回执/上限 50/终态拒绝/入口一致全对齐 | server/routes/fleets.js:2582-2625,2683; web/src/pages/FleetsPage.tsx:379-403,668 |
| agent-teams-overview | A | 三源独立降级/异常上浮/编队迷你图/副驾经架构师/灯纪律全对齐 | server/routes/fleets.js:1106,1240; web/src/components/fleet/TeamsOverviewBoard.tsx:7-135,167-252 |
| agent-turn-contract | A | turnRequest 纯函数派生/取值受界/保留位结构化拒绝/分道深度界/单一定源消费全对齐 | server/turn-request.js:14,20,24,103-120; server/fleet-events.js:15,60-62,162; server/fleet-runs.js:30,104 |
| agent-turn-mandate | A | mandate 不可变/准入表/off-observe-auto/去向账有界环/恢复重校验全对齐 | server/fleet-turn-mandate.js:1-350; server/fleet-event-wake.js:11-72 |
| agent-turn-metering | A | 计量列同缝落库/时相三段/日汇总 upsert/诚实 NULL 全对齐 | server/routes/fleets-db.js:1104,1136-1162; server/cron-runner.js:704-787; server/fleet-events.js:208-265 |
| agent-turn-pricing | A | 词元门读价/pricing_at 戳/日行估算四分量/对账脚本不自动校准全对齐 | lib/sub2api-admin.js:136-145; server/routes/fleets-db.js:373-437,1136; scripts/reconcile-turn-pricing.mjs:1-30 |

**总评**：本簇 18 条无 C/D。13 A、5 A-。无能力悬空、无账实矛盾。债务集中在命名漂移、示例 URL 陈旧、以及 agent-service-config 的 UI 归属横跨仓界。

## 2. A- 展开小节

### agent-catalog（A-）
- 对齐主证：五源与优先级 catalog.js:22-23（AGENTS_CONFIG_URL/CATALOG_REFRESH_SECS=60）、catalog.js:154（cloud 拉取失败保留 last-good 并 warn）、catalog.js:442-470（refresh + notifyIfChanged 广播 catalog_changed :462）；角色可见性 catalog.js:359-366；脱敏 catalog.js:309-312；WS 契约 server/ws.js:286-287（current_agent/agents）、ws.js:921（set_agent）、server/agent-session.js:497,543（agent_changed）、agent-session.js:462-464（流式中拒绝切换）；a2a 模式 server/a2a-client.js 全文；Nango broker server/routes/misc.js:231-262；刷新门禁 misc.js:215-216。
- 小瑕：①spec 场景示例网关 URL `https://mcp.finddatatech.cloud/agent/{path}/`（spec.md:60）写死具体域名，代码里 a2a url 由 registry 数据/环境派生（registry-bridge.js:415 起）——建议改 `{registry}` 占位；②spec 对四工具称 delegate/progress/result，代码注册名 delegate_task/task_progress/task_result——转述层传播。

### agent-cluster-core（A-）
- 对齐主证：清单校验 lib/pack-manifest.js:1865-1871、:117-119（LIMITS 逐 publish 读取、非法回落默认，test-pack-validate.mjs:504-510 覆盖）；动态集群 API server/routes/clusters.js:52,169,191,221,267,302,354、:8-9（限速 10/h）、:92（not_subscribed 400）、:284,460（cluster_terminated 广播+绑定释放）；目录标记 catalog.js:233-237,331-332；picker 分组 AssistantPicker.tsx:129-132、:167-190。
- 小瑕：AssistantPicker.tsx:186 `?? group[0]` 静默降级——spec「switch to the first default member」在无默认成员时降级为首项，建议 spec 补 fallback 语义。

### agent-delegation-a2a（A-）
- 对齐主证：C-lite 凭据 a2a-client.js:24-49（-32012 结构化 connect-guidance、绝不静默替换）；深度头 a2a-client.js + DELEGATION_DEPTH_BOUND=3（:17）；两级发现 delegation-mcp.js:44-54,78-90,172-175；未知 ref 拒绝 routes/delegation.js:101。
- 小瑕：硬编码域名（同上）；spec.md:33 服务凭据回落场景的「部署配置注记」属文档面，极轻。

### agent-preset-selection（A-）
- 对齐主证：roster/push/切换 ws.js:292,384,827-833,837-843（失败孤儿 error 且原值保持——注释自证）；broken 拒选 agent-session.js:902-903、AssistantPicker.tsx:199；统一选人面 AssistantPicker.tsx:1,129-132、ChatHeader.tsx；去重 :424-428。
- 小瑕：spec「SHALL reject set_preset while streaming」实现在 switchPresetTo 内部而非 ws.js case——建议 spec 点一句「经 switchPresetTo 同门禁」。

### agent-document（A-）
- 对齐主证：三桶单模型 lib/pack-manifest.js:519,861-876；单一校验器 :1082-1083；kind 两型与 cast 拒绝 blueprints.js:162-167,308-309,327-328,459-460；无端点无凭据 lib/pack-manifest.js SECRET_* 校验族。
- 小瑕：「个人 preset emit」实现位在 dsh-profile.js preset overlay（:2140 附近）与 studio-draft/custom-presets 路由，spec 无指针——建议加 custom-presets 交叉引用。

### agent-self-iteration（A-）
- 对齐主证：章程校验 pack-manifest.js:1536-1540；目录透传 catalog.js:226；persona 组成 dsh-profile.js:2128-2134 + test-agent-self-iteration.mjs:25-52；成本异常提案 fleet-cost-digest.js:111-193（proposedBy="platform:cost-anomaly" :133、证据链 :163-182、去重 :189-193）；人批生效 routes/fleets.js:2464-2480。
- 小瑕：「跳过被计数」的可观测计数在周报/日志层，路由侧无独立计数器——账面弱。

### agent-service-config（A-）
- 对齐主证：读写面与权限 gateway/packs.js:3233-3258（:3252-3253 作者 403）、:3446/:3452（用户门）、:3475/:3480（internal 双门）；写时车道校验 :3352-3370（MODEL_LANE_REJECTED、未配置 503 拒写）、:3373-3390（MODEL_NOT_IN_ROSTER degrade-open 三态）；三态合并/升级存续 :3392-3418 + lib/agent-serving.js:276-283,199；会话边界热切 dsh.js:60-70,136-175 + manager.js:445-470,538-542。
- 小瑕：①spec.md:10「萬星 console agent 详情页」UI 不在本仓（跨仓半悬空，建议 Purpose 注明 console 实现仓）；②热切语义仅 dsh harness 具备，无面 harness 走排水（manager.js:467-470）——spec 全称量词轻微过宽。

## 3. 本簇 P0/P1/P2 候选

**P0（会误导实现/账实矛盾）**：无。

**P1（应尽快修，避免债务固化）**
1. agent-service-config：spec 声明的「萬星 console agent 详情页」UI 不在本仓，spec 无跨仓指针——后续实现者在本仓找不到 UI 会误判能力悬空。动作：spec Purpose 加 console 实现仓引用，或 openspec 增跨仓归属说明。（gateway/packs.js:63,3233-3258；spec.md:10）
2. agent-catalog / agent-delegation-a2a：spec 中硬编码示例域名 `https://mcp.finddatatech.cloud/agent/{path}/`（agent-catalog spec.md:60）。域名属环境实例，非契约。动作：改为 `{registry}` 占位。

**P2（顺手清理）**
1. agent-delegation-tools（连带 catalog/self-iteration 转述）：spec 用短名 delegate/progress/result，代码注册名 delegate_task/task_progress/task_result（mcp.json "delegation" → server/delegation-mcp.js:57,91,97）。动作：spec 首次出现处注明注册名。
2. agent-preset-selection：set_preset 流式拒绝的实现位置在 switchPresetTo 内部而非 ws.js case 内（server/ws.js:837-843）。动作：spec 加「经 set_model 同门禁（switchPresetTo）」一句。
3. agent-cluster-core：picker lead 选择 `?? group[0]` 静默降级（web/src/components/AssistantPicker.tsx:186）。动作：spec 补 fallback 语义一句。
4. agent-service-config：热切语义仅 dsh harness 具备，无面 harness 走排水（agent-runner/manager.js:467-470）。动作：spec 在「两档生效语义」注明 harness 前提。
5. 仓库卫生：agent-runner/manager.js 含非常规字节致 `file` 判为 data、默认 grep 漏检（需 `LC_ALL=C grep -a`）。动作：定位并清除该字节，避免后续审计/工具链静默漏检本文件。
