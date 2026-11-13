# 簇 G1 健康卡 — agent* 全系（38 模块）

审计人：G1 体检员 · 日期 2026-11-06 · paas HEAD `07a8e0c7`（2026-11-06 04:36）
**实际在册清单**（`ls openspec/specs/ | grep -i agent` = **38 条**，任务简报写 34，以 ls 为准）：`a2a-agent-serving / agent-builder-hub / agent-builder-workspace / agent-catalog / agent-cluster-core / agent-delegation-a2a / agent-delegation-tools / agent-document / agent-fleet-architect / agent-fleet-carrier / agent-fleet-cockpit / agent-fleet-cockpit-projection / agent-fleet-core / agent-fleet-decision-delegate / agent-fleet-decision-lane / agent-fleet-orchestration / agent-fleet-report-lane / agent-fleet-runs / agent-fleet-templates / agent-fork-lineage / agent-materials-plaza / agent-memory-foundation / agent-preset-selection / agent-residency / agent-runner / agent-scheduling-tools / agent-self-iteration / agent-service-config / agent-spec-sheet / agent-teams-management / agent-teams-overview / agent-turn-contract / agent-turn-mandate / agent-turn-metering / agent-turn-pricing / local-agent-registry-feed / official-starter-agents-content / pack-agent-scoping`。
**③ 共同部署事实**（fd-infra-deploy/all-services/prod/，本仓只读探查）：platform.yaml:57 与 facet.yaml:66 镜像 `sha-a96731b`（源 paas `5e91d61b` ⊆ HEAD，落后 5 提交，当日新鲜）；agent-runner-serving.yaml:54,63 与 agent-runner-c.yaml:42,51 镜像 `sha-1c17030`（源 `e096c382` 2026-11-05，落后 37 提交）；**agent-runner-b.yaml:43,52 镜像 `sha-51c33c3`（源 `4c03c19` 2026-10-15，落后 HEAD 1395 提交）——11-06 已滚 `sha-ca6a7b4`（=真源 417cf71b4 内容）收口，replicas 决定维持 0（见 §25）**。痛感口径：`git log --oneline --since=2026-09-05 -- <路径>`，n=总提交 f=fix。

---

## 1. a2a-agent-serving — 评级 B
**理由**：17 条 Requirement 全链落位（部署/端口/水位/模型解析/暂停回滚），但承载文件痛感全簇第三，且测试三档新旧混杂。
① 对齐：部署合成与下发 `lib/agent-serving.js:496`(deployToRegistry)/`:420`(setAgentPaused)/`:74`(planAgentPort)/`:395`(modelChoiceError)；容量水位 `agent-runner/fleet.js:107`；同 pod 共宿 `agent-runner/config.js:156`。
② 测试：`scripts/test-agent-serving.mjs`(10-26)、`test-agent-serving-asks.mjs`(11-01)、`test-agent-serving-billing-park.mjs`(10-21)、`e2e/agent-serving.spec.js`(10-22)——存在，最旧 16 天。
③ 部署：serving 车道宿 runner-serving `sha-1c17030`（e096c382，lag 37），未随 platform 当日 a96731b 同拍。
④ 痛感：agent-serving.js n=28 f=10（36%）、gateway/wanxing/a2a.js n=8 f=4、wanxing/store.js 3/2——中高。
⑤ 陈旧度：spec 10-26 vs 代码 10-26，剪刀差 0 天。

## 2. agent-builder-hub — 评级 B
**理由**：四区门面逐区落位且仍在活跃演进，但缺单元级专测，只有 walkthrough 脚本。
① 对齐：`web/src/pages/AgentsPage.tsx:1`(四区)+`:88`(供给三柜)+`:300`(最近文档板)+`:389`(创作草稿面)，头注自述 add-agent-builder-hub。
② 测试：**未证实断言型专测**——仅 `scripts/walkthrough-builder-hub.mjs`（走查脚本）；无 e2e hub spec（e2e/ ls 核过）。
③ 部署：platform `sha-a96731b`（lag 5），web 随镜像。
④ 痛感：AgentsPage.tsx n=19 f=5（26%）。
⑤ 陈旧度：spec 11-04 vs 代码 11-03，剪刀差 1 天。

## 3. agent-builder-workspace — 评级 B
**理由**：唯一创作面+软锁+生命周期 ribbon 全落位、e2e 新鲜，但 boot/validate 两份单测停在 10-11。
① 对齐：`web/src/pages/AgentStudioPage.tsx:1`(unified authoring workspace)+`:38-52`(workspace-lifecycle/canvas/soft-lock 三个 lib 接入)；乐观锁 PUT 头注 :6。
② 测试：`scripts/test-workspace-lifecycle.mjs`(11-02)、`test-workspace-canvas.mjs`(11-03)、`e2e/agent-studio-workspace.spec.js`(11-03)；但 `test-workspace-boot/validate.mjs`(10-11) 26 天未动。
③ 部署：同共同事实（a96731b，lag 5）。
④ 痛感：AgentStudioPage.tsx n=10 f=3。
⑤ 陈旧度：spec 11-04 vs 代码 11-03，剪刀差 1 天。

## 4. agent-catalog — 评级 B
**理由**：双源合并/云优先/本地 persona 预设全落位，但三份专测全部 10 月中下旬、宿文件 agent-session.js 痛感偏高。
① 对齐：合并视图 `catalog.js:369`(getCatalogFor)/`:411`(mergedView)/`:427`(getAppEntry)；云 last-good `data/catalog-cloud-last-good.json`；本地预设缝 `server/agent-session.js:379-404`（:397 a2a 永不落本地预设）。
② 测试：`test-catalog-agent-presets.mjs`(10-14)、`test-catalog-preset-restart.mjs`(10-20)、`test-catalog-cloud-cache.mjs`(10-23)、`e2e/auth-catalog.spec.js`——全 14-23 天。
③ 部署：同共同事实。
④ 痛感：catalog.js n=15 f=4；agent-session.js n=31 f=13（与 preset 共宿混计）。
⑤ 陈旧度：spec 11-02 vs 代码 10-31，剪刀差 2 天。

## 5. agent-cluster-core — 评级 C
**理由**：动态装配/生命周期 API 在册，但 clusters.js fix 率 56% 全簇最高且测试停在 10-20/10-22——补丁期未出。
① 对齐：动态装配 `server/routes/clusters.js:52`(POST /api/clusters/dynamic)/`:169`(mine)/`:191`/:267(delete)/`:302`(agents)；catalog 集群字段 `catalog.js:233-237`。
② 测试：`scripts/test-cluster-platform.mjs`(10-20)、`test-cluster-tasks.mjs`(10-22)、`e2e/fleet-local-cluster.spec.js`——17 天未随补丁更新。
③ 部署：同共同事实。
④ 痛感：clusters.js **n=9 f=5（56%，全簇 fix 率最高）**。
⑤ 陈旧度：spec 10-23 vs 代码 10-22，剪刀差 1 天。

## 6. agent-delegation-a2a — 评级 A
**理由**：深度有界+凭证门+两级发现逐条落位，零 fix、静水，测试在册。
① 对齐：深度界 `agent-runner/a2a.js:126-128`（`delegationDepthMax ?? 3`，:134 透传）；凭证门 `a2a.js:77-82`（backendToken Bearer）；发现 `server/delegation-mcp.js:137`(toolSearchAgents)。
② 测试：`scripts/test-agent-delegation-a2a.mjs`(10-25)，存在。
③ 部署：宿 runner-c/serving `sha-1c17030`（lag 37）。
④ 痛感：a2a.js n=6 f=0、delegation-mcp.js n=3 f=0——零痛。
⑤ 陈旧度：spec 10-02 vs 代码 10-25，代码更新 23 天（<30，非 stale）。

## 7. agent-delegation-tools — 评级 C
**理由**：六条工具面 Requirement 全落位且零 fix，但 spec 是全簇唯一 stale（落后代码 35 天），spec 已不能作验收基线。
① 对齐：`server/delegation-mcp.js:121`(toolDelegate)/`:155`(toolProgress)/`:161`(toolResult)/`:49`(toolsFor)；聚合回合 `server/delegation-aggregator.js`。
② 测试：`scripts/test-fleet-delegation.mjs`(10-29) 一份共测（兼 pin add-deputy-decision-delegate）。
③ 部署：同共同事实。
④ 痛感：delegation-mcp.js n=3 f=0、aggregator n=3 f=0。
⑤ 陈旧度：spec 10-02 vs 代码 11-06，**剪刀差 35 天 >30 = stale（全簇唯一）**。

## 8. agent-document — 评级 A
**理由**：四发射口单验证器闸在册，spec/代码/测试三者 3 天内同步，零痛。
① 对齐：四发射口纪律 `server/routes/studio-draft.js:4`（头注：gate into the three buckets, and the four emit mouths are never fed by the…）；文档即原子单元经 persona-evolution 草稿池。
② 测试：`scripts/test-agent-docs-gate.mjs`(11-03)，存在且新鲜。
③ 部署：同共同事实。
④ 痛感：studio-draft.js n=1 f=0、persona-evolution.js n=2 f=0。
⑤ 陈旧度：spec 11-04 vs 代码 11-01，剪刀差 3 天。

## 9. agent-fleet-architect — 评级 A
**理由**：三段分离+dry-run 必经+批准兜底全落位，spec 与代码同日，低痛。
① 对齐：架构师工具面 `server/fleet-architect.js` + `fleet-architect-mcp.js`；设计模式草稿道骑既有 validate/diff/estimate/apply `server/routes/fleets.js:899-948`（:909 cockpitDraftSubsetError 兜底）。
② 测试：`scripts/test-fleet-architect.mjs`(11-01)，存在。
③ 部署：同共同事实。
④ 痛感：fleet-architect.js n=8 f=2（25%）。
⑤ 陈旧度：spec 10-28 vs 代码 10-28，剪刀差 0 天。

## 10. agent-fleet-carrier — 评级 B
**理由**：三层解析/路由/准入硬闸逐条落位且测试在册，但宿文件 cron-runner.js 承载 scheduling+turn 多模块、痛感 n=40 全簇第二。
① 对齐：`server/cron-runner.js:35`(resolveTaskCarrier)/`:67`(runnerEntryFor)/`:114`(resolveTurnBudgetMs)；测试头注自证 ①②③ 契约。
② 测试：`scripts/test-fleet-carrier.mjs`(11-01)，头注逐条 pin 三层解析/fail-open/准入闸。
③ 部署：同共同事实。
④ 痛感：cron-runner.js n=40 f=13（宿文件混计，carrier 专属占比未证实）。
⑤ 陈旧度：spec 11-01 vs 代码 11-06，代码更新 5 天。

## 11. agent-fleet-cockpit — 评级 B
**理由**：17 条全簇第二大 spec 逐条落位（组织图/拍板横幅/粒子层/迷你 span），但专测 10-27 后未随 spec 演进。
① 对齐：读面 `server/routes/fleets.js:1403`(GET /:id/cockpit)；画布 `web/src/components/fleet/FleetCanvas.tsx` + `InspectorDrawer.tsx` + `MiniSpan.tsx`。
② 测试：`scripts/test-fleet-ops-canvas.mjs`(10-27)、`e2e/fleet-ops-canvas.spec.js`(10-27)——spec 10-30 定稿后 10 天无新测试。
③ 部署：同共同事实。
④ 痛感：FleetCanvas.tsx n=7 f=2。
⑤ 陈旧度：spec 10-30 vs 代码 10-27，剪刀差 3 天。

## 12. agent-fleet-cockpit-projection — 评级 B
**理由**：三缝（cell-sampler 二车道/聚合端点/萬星快照）落位清晰，但 fix 率 50% 且测试同日未更。
① 对齐：二车道 `gateway/fleet-cells.js:9`+`:105`（Projection lane 注释自证 spec 名）；单程聚合 `server/routes/fleets.js:1102`。
② 测试：`scripts/test-gateway-fleet-cells.mjs`(10-27)，存在。
③ 部署：同共同事实（projection 车道随 platform 镜像）。
④ 痛感：fleet-cells.js n=4 f=2（50%）。
⑤ 陈旧度：spec 10-30 vs 代码 10-27，剪刀差 3 天。

## 13. agent-fleet-core — 评级 A
**理由**：26 条全簇最大 spec（物化/派生态/双审计痕/模型断言自愈）逐条落位，核心测试 11-03，spec 当日仍在演进。
① 对齐：模型层 `server/fleet-model.js`（resolveAgentEffort/setEffortDeclarations，test-agent-config-dims.mjs:19 反证导出）；对账 `server/fleet-reconcile.js`；回合事件 `server/fleet-events.js:159`(recordTurnEvent)。
② 测试：`scripts/test-fleet-core.mjs`(11-03) + 卫星族（turn-events 10-27/attribution 11-04/budget 11-01/model-drift 10-27）。
③ 部署：同共同事实。
④ 痛感：fleet-model.js n=2 f=0；reconcile n=11 f=4；fleets.js 56/23 为全家族宿文件混计。
⑤ 陈旧度：spec 11-05 vs 代码 10-26，spec 新 10 天（<30，非 stale）。

## 14. agent-fleet-decision-delegate — 评级 A
**理由**：委托策略/escalate 归并/裁决身份/角标全落位，零 fix，spec 代码同日。
① 对齐：escalate 校验与类别路由 `server/fleet-decisions.js:32-69`（:69 注释自证 add-deputy-decision-delegate）。
② 测试：`scripts/test-fleet-delegation.mjs`(10-29) 显式 pin add-deputy-decision-delegate 契约。
③ 部署：同共同事实。
④ 痛感：fleet-decisions.js n=2 f=0。
⑤ 陈旧度：spec 10-29 vs 代码 10-29，剪刀差 0 天。

## 15. agent-fleet-decision-lane — 评级 A
**理由**：拍板项状态机/注入管线/配置改动提议车道全落位，零痛。
① 对齐：状态机 `server/fleet-decisions.js:11-28`（DECISION_STATES/TRANSITIONS/INJECTED_PER_TURN:15）；配置提议型拍板项经 fleet-iteration（G4 已核其 itemType='config-change'）。
② 测试：`scripts/test-fleet-decision-lane.mjs`(10-27)，存在。
③ 部署：同共同事实。
④ 痛感：n=2 f=0。
⑤ 陈旧度：spec 10-29 vs 代码 10-29，剪刀差 0 天。

## 16. agent-fleet-orchestration — 评级 A
**理由**：四类边+bot 唤醒逐条落位，纯度测试独立成件，低痛。
① 对齐：边类型 `server/fleet-orchestration.js:14-20`（EDGE_KINDS 含 dispatch/handoff/fanout，FANOUT_ROUNDS_MAX:15）；bot 入站唤醒 `server/fleet-event-wake.js`。
② 测试：`test-fleet-orchestration.mjs`(11-01)、`test-fleet-orchestration-purity.mjs`(10-25)、`test-fleet-event-wake.mjs`(10-26)。
③ 部署：同共同事实。
④ 痛感：n=7 f=1。
⑤ 陈旧度：spec 11-04 vs 代码 10-31，剪刀差 4 天。

## 17. agent-fleet-report-lane — 评级 B
**理由**：报数/槽位/归属/注入身份全落位，但 fleet-reports.js fix 率 37% 且 spec 11-04 定稿后测试未跟。
① 对齐：`server/fleet-reports.js:27`(validateReportPayload)/`:115`(resolveAttribution)/`:162`(fleetIdentityFor 身份注入)/`:277`(floodWindowMs)。
② 测试：`scripts/test-fleet-report-lane.mjs`(11-01)、`test-fleet-report.mjs`(10-25)——spec 11-04 后未更新。
③ 部署：同共同事实。
④ 痛感：fleet-reports.js n=8 f=3（37%）。
⑤ 陈旧度：spec 11-04 vs 代码 11-05，代码新 1 天。

## 18. agent-fleet-runs — 评级 B
**理由**：runId 贯穿/明细链/保留界/孤儿收口落位，但半数提交是 fix（50%）。
① 对齐：`server/fleet-runs.js:64`(createFleetTurnLedger)/`:182`(recordTurnEvent 缝)；读面 `server/routes/fleets.js:846`/:879（runs 与 runs/:runId）。
② 测试：`scripts/test-fleet-runs.mjs`(11-01)，存在。
③ 部署：同共同事实。
④ 痛感：fleet-runs.js n=6 f=3（50%）。
⑤ 陈旧度：spec 11-01 vs 代码 11-01，剪刀差 0 天。

## 19. agent-fleet-templates — 评级 A
**理由**：模板清单/参数槽/导出/种子守恒/红线词表全落位，三份专测在册，低痛。
① 对齐：`server/fleet-template.js:146`(resolveFleetTemplateParams)/`:190`(parseFleetTemplate)/`:461`(exportFleetToTemplate)/`:30,:50,:65`( kinds/50 上限/参数类型常量)。
② 测试：`test-fleet-templates.mjs`(11-03)、`test-fleet-template-locale.mjs`(10-27)、`test-fleet-template-publish-gate.mjs`(10-25)、`e2e/starter-teams-sequence.spec.js`(11-04)。
③ 部署：同共同事实。
④ 痛感：n=6 f=1。
⑤ 陈旧度：spec 11-04 vs 代码 11-03，剪刀差 1 天。

## 20. agent-fork-lineage — 评级 A
**理由**：fork 种子/血统戳/无官方性/展示血缘五条全落位，零痛。
① 对齐：`server/persona-evolution.js:12`（头注：DRAFT (provenance.forkOf stamped) through the same drafts store）；MCP 面 `persona-evolution-mcp.js`。
② 测试：`scripts/test-agent-fork-lineage.mjs`(11-03)，存在且新鲜。
③ 部署：同共同事实。
④ 痛感：persona-evolution.js n=2 f=0。
⑤ 陈旧度：spec 11-01 vs 代码 11-03，代码新 2 天。

## 21. agent-materials-plaza — 评级 B
**理由**：三域一清单/五语静态站/新鲜度降级落位且测试新鲜，但站点 fix 率 55%——内容纪律仍在打磨。
① 对齐：静态站 `site-plaza/`（index.html+locales+translations）；机读面 `site-plaza/generated/`（catalog.json/llms.txt/snapshot.json）；生成链 `scripts/plaza-export.mjs`。
② 测试：`scripts/test-plaza-site.mjs`(11-03)、`deploy-plaza.sh`/`make-public-snapshot.mjs` 在册。
③ 部署：独立静态站（scripts/deploy-plaza.sh），不随 platform 镜像。
④ 痛感：site-plaza n=11 f=6（55%）。
⑤ 陈旧度：spec 11-05 vs 代码 11-06，代码新 1 天。

## 22. agent-memory-foundation — 评级 B
**理由**：写面 metadata/结构化筛选/memory_overview 读面落位，但核心实现跨仓（fd-memory），paas 侧只有读面代理与 UI，本仓未证实专测。
① 对齐：核心写面/MCP 在 fd-memory 仓（`fd-memory/dist/mcp.js:361` memory_overview 工具；`fd-memory/dist/test/agent-memory-foundation.test.js` 2026-11-05）；paas 侧读面 `gateway/memory-face.js` + 筛选 `server/routes/memory.js:36`（tag 参数解析）+ `web/src/pages/MemoryPage.tsx`。
② 测试：核心测试在 fd-memory（11-05 新鲜）；paas 侧 `scripts/test-memory-promotions-proxy.mjs` 在册；**本仓无该 spec 名引用的专测（grep 核过）**。
③ 部署：fd-memory.yaml 独立部署（fd-infra-deploy），paas 读面随 platform。
④ 痛感：routes/memory.js n=2 f=0、MemoryPage.tsx n=4 f=0。
⑤ 陈旧度：spec 11-05 vs paas 侧代码 10-30，剪刀差 6 天（跨仓代码 11-05 未计入）。

## 23. agent-preset-selection — 评级 B
**理由**：预设名册/下一会话生效/静态标签/WS 契约落位，但 spec 停在 10-22 而选人面代码 11-06 仍在动，测试分散三处。
① 对齐：名册与本地预设缝 `server/agent-session.js:379-404`；会话桥 `lib/copilot-presets.js:1-22`（focused 预设按形态解析）；`e2e/agent-presets.spec.js`。
② 测试：`test-catalog-agent-presets.mjs`(10-14)、`test-preset-session-bridge.mjs`(11-01)、`test-session-to-preset.mjs`(10-13)——最旧 24 天。
③ 部署：同共同事实。
④ 痛感：agent-session.js n=31 f=13（宿文件混计，preset 专属未证实）。
⑤ 陈旧度：spec 10-22 vs 代码 11-06，代码新 15 天（<30，非 stale 但趋势向 stale）。

## 24. agent-residency — 评级 A
**理由**：不驱逐/暖区降级/日滚动 carry-over/节奏自回合/可逆暂停逐条落位，运行时零 fix。
① 对齐：驻留纪律 `agent-runner/manager.js:1-6`（头注：idle children are NOT reaped on a timer…warm zone）；降级参数 `agent-runner/config.js:136,:186`(demoteCooldownMs)；滚动 `agent-runner/rollover.js:8`（warm agents roll on re-warm）+`scheduler.js:7`（restart/pause/warm gap 重锚）。
② 测试：`scripts/test-agent-residency.mjs`(10-11)、`test-steward-residency.mjs`(10-28)、`test-bridge-preset-park.mjs`(10-31)——专测 26 天未动。
③ 部署：宿 runner-b/c/serving 三镜像（见头注，runner-b 代际分裂直接影响本模块运行时）。
④ 痛感：rollover.js n=2 f=0、scheduler.js n=2 f=0。
⑤ 陈旧度：spec 10-14 vs 代码 10-21，代码新 7 天。

## 25. agent-runner — 评级 C
**理由**：26 条 runner 契约代码全落位且测试昨日刚跑，但它是 runner-b 代际分裂的当事模块——生产两代 runner 并存，fix 密度全簇最高（44%）。
① 对齐：子进程管理器 `agent-runner/manager.js:1`（bounded queue+drain）；环境净化 `child.js:37`(scrubbedChildEnv)；入站鉴权 `a2a.js:82`；深度界 `a2a.js:126`；工作记忆挂载 `memory-mount.js:11`；桥通知 `notify.js:27`；邮箱 `mailbox.js:10`。
② 测试：`scripts/test-agent-runner.mjs`(11-05) + `agent-runner/test/`（listener/matters/memory/workspace/credentials-scalar 五件）。
③ 部署：**runner-b `sha-51c33c3`（源 4c03c19，10-15，落后 1395 提交）vs runner-c/serving `sha-1c17030`（e096c382，lag 37）——同 spec 两代运行时**。
④ 痛感：agent-runner/ n=66 f=29（44%，全簇最高）；harness/ 11/6。
⑤ 陈旧度：spec 10-30 vs 代码 11-05，剪刀差 6 天。
**【11-06 代际治理收口】**：runner-b 已滚 `sha-ca6a7b4`（公开快照线镜像仓 tag，digest 0e4ee127 = paas 真源 `417cf71b4` 内容；5a420fa 引用的 `sha-417cf71` 从未物化，已纠正）——manifest 层代际对齐完成。途中抓出 relay 缺口：同名 tag 已入 seen 账本即永不重拷（ccr 上 ca6a7b4 曾挂 10-31 旧内容），删 tag+skopeo 补拷已核。
**决定（维持 replicas=0）**：runner-b 缩容是 5fc4d8b 有意为之（闲置数日 + fd-prod 配额让位 fd-paper-trading），且配额墙仍在（ca9f82e 36→38Gi 第十次顶满，剩 176Mi<1Gi）——成本目标下不拉空闲实例；代际对齐落在 manifest，复用即吃新镜像。runner-c 维持 `sha-1c17030` 不动：在役服务车道（Recreate 策略滚动=瞬时停机），无请求的滚动是白风险，挂账到下次复用/例行滚版时对齐。

## 26. agent-scheduling-tools — 评级 A
**理由**：五件工具（create/list/update/pause/delete）+专用会话绑定+结构化错误全落位，cron 测试当日仍在跑。
① 对齐：工具面 `server/cron-mcp.js:74`(cron_create)/`:124`(cron_list)/`:129`(cron_update)/`:159`(cron_pause)/`:168`(cron_delete)；专用会话 label 语义 :102。
② 测试：`test-cron-catchup.mjs`/`test-cron-decisions.mjs`/`test-cron-parity.mjs`/`test-cron-round-rotation.mjs`（均 11-06，当日）。
③ 部署：同共同事实。
④ 痛感：cron-mcp.js n=4 f=1。
⑤ 陈旧度：spec 10-31 vs 代码 11-06，代码新 6 天。

## 27. agent-self-iteration — 评级 A
**理由**：章程进 persona 尾巴/四条件成本异常闸/防中毒（无证据不提案、不自动生效）逐条落位。
① 对齐：章程合成 `dsh-profile.js:2129-2135`（entry.memory.guidance → 【记忆章程】persona tail）；提案闸 `server/fleet-cost-digest.js:110-133`（four conditions + proposedBy: "platform:cost-anomaly"）；人批 `server/persona-evolution.js:95,:159`（decisions human-only）。
② 测试：`scripts/test-agent-self-iteration.mjs`(11-02)，头注逐条 pin 三组契约。
③ 部署：同共同事实。
④ 痛感：persona-evolution n=2 f=0、cost-digest n=2 f=0。
⑤ 陈旧度：spec 10-31 vs 代码 11-03，剪刀差 3 天。

## 28. agent-service-config — 评级 B
**理由**：读 写面/车道校验/优先级/Overlay 存续落位，但唯一 e2e 停在 10-11（26 天），spec 11-05 定稿后无新测试。
① 对齐：生效值解析 `lib/agent-serving.js:199`(resolveServiceConfig，rhythm/budget/model override 链)；升级存续 Overlay `server/routes/overlay.js`。
② 测试：`e2e/agent-service-config.spec.js`(10-11) 26 天未动；`test-agent-delegation-a2a.mjs` 内含 service-config 引用（grep 核过）；**无独立单测**。
③ 部署：同共同事实。
④ 痛感：overlay.js n=4 f=1。
⑤ 陈旧度：spec 11-05 vs 代码 11-05，剪刀差 0 天。

## 29. agent-spec-sheet — 评级 A
**理由**：共享契约/三桶空也渲染/徽章派生/来源三轴合成逐条落位，测试用源断言钉死"不重派生"纪律。
① 对齐：`web/src/components/packs/AgentSpecSheet.tsx:5-11`（头注：buckets… Derivations are NOT reimplemented here—badge/provenance 由 `lib/pack-provenance.js` 单点合成）。
② 测试：`scripts/test-agent-spec-sheet.mjs`(11-01)——源断言风格：NEVER imports packGuides、NEVER re-derives badge/provenance + 五语 keys。
③ 部署：同共同事实。
④ 痛感：AgentSpecSheet.tsx n=3 f=0。
⑤ 陈旧度：spec 11-01 vs 代码 11-01，剪刀差 0 天。

## 30. agent-teams-management — 评级 A
**理由**：行内编辑/逐条回执批量/入口一致三 Requirement 落位，写面复用单队 PATCH 不立第二套写路径。
① 对齐：`web/src/components/fleet/TeamsManagementView.tsx:1-7`（头注：checkbox batch actions with per-item receipts…Writes reuse the existing single-fleet PATCH）。
② 测试：`scripts/test-fleet-batch.mjs`(10-30) 显式 pin add-agent-teams-management；`e2e/fleet-hub.spec.js`(10-31)。
③ 部署：同共同事实。
④ 痛感：TeamsManagementView.tsx n=2 f=0。
⑤ 陈旧度：spec 10-30 vs 代码 11-02，代码新 3 天。

## 31. agent-teams-overview — 评级 B
**理由**：跨团队主位看板/三路降级/迷你阵形落位，但**无任何专测**（grep add-agent-teams-overview 零命中）。
① 对齐：`web/src/components/fleet/TeamsOverviewBoard.tsx:1`；挂载 `web/src/pages/FleetsPage.tsx:19,:836`。
② 测试：**未证实专测**——单测/e2e 均无该 spec 名引用（scripts/ 与 e2e/ grep 核过）。
③ 部署：同共同事实。
④ 痛感：TeamsOverviewBoard.tsx n=2 f=0。
⑤ 陈旧度：spec 11-02 vs 代码 10-31，剪刀差 2 天。

## 32. agent-turn-contract — 评级 B
**理由**：turnRequest 显式契约/保留位结构化拒绝/等价消费落位，但 fix 率 29% 且测试 11 天未动。
① 对齐：契约常量与界限 `server/turn-request.js:14-26`（SOURCES/RESERVED_SOURCES/RESULT_SINKS/DISPATCH_DEPTH_BOUND/DEFAULT_MAX_CHAIN_DEPTH）；消费缝 `server/fleet-events.js`。
② 测试：`scripts/test-turn-request.mjs`(10-26)，11 天未随 fix 更新。
③ 部署：同共同事实。
④ 痛感：turn-request.js n=7 f=2（29%）。
⑤ 陈旧度：spec 10-26 vs 代码 10-31，代码新 5 天。

## 33. agent-turn-mandate — 评级 A
**理由**：不可变 mandate/信号源准入表/影子三档/disposition 入账逐条落位，spec 代码 1 天内同步。
① 对齐：`server/fleet-turn-mandate.js:66`(defaultSignalPolicy)/`:145`(admitTrigger)/`:203`(buildMandate)。
② 测试：`scripts/test-fleet-turn-mandate.mjs`(11-03) + `test-worker-pool.mjs` 引用，新鲜。
③ 部署：同共同事实。
④ 痛感：n=1 f=0。
⑤ 陈旧度：spec 11-04 vs 代码 11-03，剪刀差 1 天。

## 34. agent-turn-metering — 评级 A
**理由**：计量列同缝落事件行/三段时相/日汇总同缝累积逐条落位，测试头注逐字钉死 NULL 语义与 D6 降级。
① 对齐：`server/fleet-events.js:104-110`(TokenUsage 细分 verbatim)/`:182`(metering)/`:203-209`(meteringOf 派生注释)。
② 测试：`scripts/test-turn-metering.mjs`(11-01)，头注 pin ADDED ①②③+degrade D6。
③ 部署：同共同事实。
④ 痛感：fleet-events.js n=8 f=1。
⑤ 陈旧度：spec 10-31 vs 代码 10-31，剪刀差 0 天。

## 35. agent-turn-pricing — 评级 A
**理由**：词元管理门读价/进程内缓存/估算列/不自动校准对账全落位，零痛。
① 对齐：`server/turn-pricing.js:49`(pricingFor)/`:58`(estimateTurnCost)/`:94`(refreshTurnPricing)/`:115`(attachTurnPricing 缓存)；对账 `scripts/reconcile-turn-pricing.mjs`。
② 测试：`scripts/test-turn-pricing.mjs`(11-01)，存在。
③ 部署：同共同事实。
④ 痛感：n=1 f=0。
⑤ 陈旧度：spec 10-31 vs 代码 10-31，剪刀差 0 天。

## 36. local-agent-registry-feed — 评级 A
**理由**：本机 feed 形状/安装态合成/容量闸/与云并存四条全落位，测试在册，零痛。
① 对齐：`server/local-agent-feed.js:28`(LOCAL_FEED_BASE=/local-registry)/`:50`(listDeployments)/`:64`(getDeployment)/`:80`(capacityInfo)。
② 测试：`scripts/test-local-agent-feed.mjs`(10-31)、`test-registry-bridge.mjs`(11-05，HEAD 即今日 fix 对齐其断言)。
③ 部署：同共同事实。
④ 痛感：n=3 f=0。
⑤ 陈旧度：spec 10-28 vs 代码 10-29，剪刀差 1 天。

## 37. official-starter-agents-content — 评级 A
**理由**：persona 槽位逐字保留/双桶如实/批量改版溯源/转正快照不可动/无触手顾问纪律全落位，内容基线测试双件在册。
① 对齐：名册 `agents.json`（官方 starter 定义，:1 起）；内容基线 `scripts/test-starter-content-baseline.mjs:1-5`（Pins the CONTENT quality bar of the five official starter teams）+ `test-official-starter-teams.mjs`(11-01)、`test-business-teams-content-baseline.mjs`(11-02)。
② 测试：上述三件 + `e2e/starter-teams-sequence.spec.js`(11-04)——全新鲜。
③ 部署：随 platform 镜像（bundled 定义进镜像）；W1 地板 10 starters 由 `07a8e0c7`（HEAD 本身）对齐。
④ 痛感：agents.json n=6 f=0。
⑤ 陈旧度：spec 11-04 vs agents.json 10-23，剪刀差 12 天（<30，非 stale；内容纪律在测试侧持续活跃）。

## 38. pack-agent-scoping — 评级 B
**理由**：focused/full 双模/per-server 上界/度量落位，但 spec 定格 10-22 后测试停在 10-22，且 ① 度量只有 probe 无断言单测。
① 对齐：full-mode 收窄 `lib/full-mode-tool-scope.js:1-6`（纯函数，installed_packs 快照重推导）；focused 装载 `agent-runner/compose.js:223`（tool-filter.json+scope module 落私宅）；度量 `scripts/probe-pack-scope.mjs`。
② 测试：`e2e/pack-agent-scoping.spec.js`(10-22)、`scripts/test-pack-cell.mjs`——均 10-22，15 天未动；probe 是测量探针非断言。
③ 部署：同共同事实。
④ 痛感：full-mode-tool-scope.js n=2 f=0。
⑤ 陈旧度：spec 10-22 vs 代码 10-22，剪刀差 0 天。

---

## 簇摘要

**评级分布：A 18 / B 17 / C 3 / D 0（共 38 条）**——整体对齐率高（38/38 关键 Requirement 均找到实现入口，零 shadow 能力未证实项），弱点集中在测试龄与宿文件痛感混计。

**最严重三件事**：
1. **agent-runner 生产代际分裂恶化（C，当事模块）**：runner-b 生产镜像 sha-51c33c3 源 `4c03c19`（2026-10-15）落后 HEAD **1395 提交**（G4 卡时 1385，9 小时内又扩 10），与 runner-c/serving `e096c382`（lag 37）、platform `5e91d61b`（lag 5）三代并存——agent-runner 26 条契约 + agent-residency 的运行时宿分两代，同一 spec 行为不可归因；且该模块 fix 密度全簇最高（agent-runner/ 66 提交 29 fix，44%），b 代机器吃的全是旧补丁。
2. **agent-delegation-tools spec stale 35 天（C，全簇唯一 >30）**：spec 定格 10-02，代码 11-06 仍在演进，spec 已脱离实现——需重走 openspec 流程补 spec 或收口代码。
3. **agent-cluster-core 补丁期未出（C）**：clusters.js 9 提交 5 fix（56% fix 率全簇最高），动态装配/生命周期 API 仍在连环修，测试停在 10-20/10-22 未跟补丁——下一个 stale/spec-漂移高危。
   **【11-06 复核推翻测试停摆判定】**：fix 提交 7cd3a4448（10-22）自带测试增量（boot-guard 独立文件+auto-term 四态+持久化往返）；实测三文件全绿 = test-cluster-platform 8/8 + test-cluster-tasks 21/21 + test-task-engine-boot-guard 2/2 = **31/31 绿**（含 auto-term 四态/集群字段往返/记忆钩子降级开）。fix 已被测试覆盖，无需补测；本条销账，仅剩 fix 率高的观察价值。

**次级信号**（未入评级主因但值得跟）：agent-fleet-cockpit（17 条最大 UI spec）专测 10-27 后未随 10-30 定稿演进；agent-teams-overview 与 agent-builder-hub 均无断言型专测；agent-service-config 唯一 e2e 26 天未动而 spec 11-05 刚定稿。
