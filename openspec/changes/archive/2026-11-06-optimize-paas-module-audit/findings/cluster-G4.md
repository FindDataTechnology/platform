# 簇 G4 健康卡 — fleet 全系 + 域动作（9 模块）

审计人：G4 体检员 · 日期 2026-11-06 · paas HEAD `ae04f0b`（2026-11-06 02:45）
**实际在册清单**（ls specs/ 按词干核对）：`fleet-blueprint-studio / fleet-config-overview / fleet-machine-console / fleet-memory / fleet-owner-iteration / fleet-owner-surface / fleet-room-bridge / fleet-turn-memory / action-gate` 共 9 条。
**ontology / entity / relation / window / dag 词干在 specs/ 与 changes/（含 archive 之外）均不在册**——本体 v1 蓝图未证实存于本仓（fd-industry-data 仓亦无），未证实，不评级。
**③ 共同部署事实**：9 模块同宿 `fd-infra-deploy/all-services/prod/platform.yaml:57` 镜像 `sha-70a3620`（源 paas `dde77c3a`，2026-11-06 00:29；`git merge-base --is-ancestor dde77c3a HEAD` = 是，落后 6 提交，当日新鲜）。

---

## 1. fleet-blueprint-studio — 评级 C
**理由**：全链对齐且测试最新，但铸造链是全簇痛感最高点——首铸自引用死锁连环 5 刀自愈，生产铸造路径靠补丁堆叠维稳。
① 对齐：validate/approve/cast/trial/signoff/report 全在 `server/routes/blueprints.js:288,297,322,455,483,513`；NL 起草落草稿池 `server/blueprint-author.js`（server.js:74 注册）；试跑引擎 `server/blueprint-trial.js`（410 行，deadline 自适应 ec46336d）。未发现明显 shadow 能力。
② 测试：`scripts/test-blueprints.mjs`(11-01)、`test-blueprint-trial.mjs`(11-01)、`test-blueprint-judge.mjs`(10-30)、`test-blueprint-kind.mjs`——存在且新鲜。
③ 部署：同上共同事实（dde77c3a ⊆ HEAD，lag 6）。
④ 痛感：`git log --oneline --since=2026-09-05 -- blueprints.js blueprint-trial.js blueprint-author.js` = **30 提交 / 17 fix（全簇最高）**；死锁连环：`8ab6fffa`→`d18085a9`(cast 前置闸认陈旧指针)→`fbe179d0`→`e24ebf04`→`05022564`(首铸 {{PACK_ID:self}} 死锁自愈)。
⑤ 陈旧度：spec 11-04 vs 代码 11-03，剪刀差 1 天，新鲜。

## 2. fleet-config-overview — 评级 A
**理由**：纯读聚合面，实现即 spec 的逐条投影，零 fix、零漂移；唯一弱点是无专属测试。
① 对齐：`web/src/components/fleet/FleetConfigBar.tsx:1-9` 头注自述四项聚合+纯读面，模型分布/effort/预算直方/24h 热力图逐一实现（:52-90 models/effortDist）；数据源自 cockpit 聚合零新端点，与 spec "pure read surface" 一致。
② 测试：**未证实专测**——grep scripts/e2e 仅 `scripts/design-lint-baseline.json` 提及 configBar；`web/src/components/fleet/` 无 *.test.*。
③ 部署：同共同事实。
④ 痛感：n=1 fix=0（该文件自 09-05 仅 1 提交）。
⑤ 陈旧度：spec 10-28 vs 代码 10-27（688fbc72），剪刀差 1 天。

## 3. fleet-machine-console — 评级 B
**理由**：名册/期望态/解绑/历史全对齐、测试同日，但真机走查两次逮住单测盲区（PUT body 恒 undefined、期望集跨重启丢失）。
① 对齐：roster/detail/history/unbind/desired 全在 `gateway/fleet-machines-routes.js:91,121,143,168,190`；健康哨派生只读 `deriveMachineHealth`（fleet-machines-routes.js:31）；steward 只读门在 routes.js:85 注释落实。
② 测试：`scripts/test-fleet-machines.mjs`(11-03)、`test-machine-convergence.mjs`(11-03)、`e2e/machines-console.spec.js`(10-29)、`e2e/machines-lifecycle.spec.js`(11-03)。
③ 部署：同共同事实。
④ 痛感：n=4 fix=2；`f4777920` 自曝"原套件自己 app.use(express.json()) 把缺口盖住了"（真机 400）、`48bc85f9` 期望集跨重启不丢。
⑤ 陈旧度：spec 11-03 vs 代码 11-03（491d61dd），剪刀差 0 天。

## 4. fleet-memory — 评级 A
**理由**：17 条 Requirement 全数落位（namespace 寻址/两族令牌/换防不换/零 LLM/tier 分层），与 fd-memory 缝契约清晰，当日仍在演进。
① 对齐：capture 去重+降级开放 `server/fleet-memory.js:54-110`；成员令牌按 (fleetId,memberId) 懒铸、换防不换 `fleet-memory.js:120-129`；平台缝 person/member 双令牌 :122-128；服务端单源渲染 digest 由 fd-memory 侧承担（spec 213 行要求，跨仓未证实，标注）。
② 测试：`scripts/test-fleet-memory.mjs`(11-05)、`test-fleet-memory-split.mjs`(11-05)、`test-fleet-memory-anchors.mjs`、`test/cell-memory.test.mjs`——存在且当日更新。
③ 部署：同共同事实。
④ 痛感：n=3 fix=1，低痛。
⑤ 陈旧度：spec 11-05 vs 代码 11-05（8b89c936），剪刀差 0 天。

## 5. fleet-owner-iteration — 评级 A
**理由**：小而完整：提议→拍板→铸版→订阅四环全链在册，唯一通道纪律（审批单=decision_items）未另建表。
① 对齐：提议入口 `server/fleet-iteration.js:26`（createConfigChangeProposal，itemType='config-change' :41）；REST 面 propose/list/retry `server/routes/fleets.js:1308,1327,1338`；批准回调铸版 `server/routes/fleets.js:2462-2488`；报数订阅 `fleets.js:1361,1374,1385`。
② 测试：`scripts/test-fleet-owner-iteration.mjs`(10-28)，存在。
③ 部署：同共同事实。
④ 痛感：n=2 fix=1，低痛。
⑤ 陈旧度：spec 10-28 vs 代码 10-30（39f31eb4 lint），剪刀差 2 天。

## 6. fleet-owner-surface — 评级 B
**理由**：六坞（总览/跨机占位/经营/花销/装作/失败分类）读面对齐，但痛感度量只能给到 fleets.js 全文件口径，模块级拆分未证实。
① 对齐：总览 `server/routes/fleets.js:1111(/overview)`、主人看板 `:1245(/owner/board)`、花销 `:1294(/:id/spend)`、失败如实分类在 board 组装段；web 侧 `web/src/lib/fleet-owner-api.ts` + `web/src/components/fleet/OwnerBoardStrip.tsx`。
② 测试：`scripts/test-fleet-owner-surface.mjs`(10-31)，存在。
③ 部署：同共同事实。
④ 痛感：`fleets.js` 全文件 n=55 fix=24（含 carrier/chat-lane 等他模块）；owner-surface 专属占比**未证实**。
⑤ 陈旧度：spec 10-28 vs 代码 11-05（1d21317d），剪刀差 8 天，代码更新，非 stale（<30 天）。

## 7. fleet-room-bridge — 评级 A
**理由**：订阅/频控/召唤三 Requirement 逐条落位，事务走既有 inviteCreate 不立第二套握手，静水。
① 对齐：订阅+解除 `gateway/fleet-room-bridge.js:111,119,142`（所有权校验 :127、上限 :135）；一键召唤 PLAN→批量邀入 :156-196（走 store.inviteCreate :184）；系统行如实播报 :138,149。
② 测试：`scripts/test-fleet-room-bridge.mjs`(10-31)，存在。
③ 部署：同共同事实。
④ 痛感：n=1 fix=0。
⑤ 陈旧度：spec 10-30 vs 代码 10-30（814d50c0），剪刀差 0 天。

## 8. fleet-turn-memory — 评级 A
**理由**：零 LLM 观测→本岗 digest 注入→换防不清记忆三点全链当日落成，测试与 spec 同日双新。
① 对齐：capture `server/fleet-memory.js:54-110`（dedup 512、失败不阻塞回合 :14 契约注）；注入梯子 `server/fleet-context.js:413-421`（memoryDigest(fleetId,title,memberId,scope)，本岗/团队/历史团队三标签见 1d21317d）；换防不清=令牌随岗 `fleet-memory.js:120-124`（"换防不换" 原文）。
② 测试：`scripts/test-fleet-memory.mjs`(11-05) 覆盖 buildFleetContext/memoryDigest（grep 实证）；`test-fleet-memory-split.mjs`(11-05)。
③ 部署：同共同事实。
④ 痛感：fleet-context.js n=8 fix=2 + fleet-memory.js n=3 fix=1，合计 fix=3/11，中等偏低；fix 集中在链路纪律（b99fd103 槽位键注入）非本模块。
⑤ 陈旧度：spec 11-05 10:00 vs 代码 11-05 09:17，剪刀差同日。

## 9. action-gate — 评级 B
**理由**：注册表/单一执行路径/owner 闸/补填参数全对齐，但测试集是全簇最旧（10-21~10-24 后未再动），而动作面仍在加（CRM、柏讯订阅/退订），测试增速落后于注册表增速。
① 对齐：注册表 19 动作 `lib/action-registry.js:96-286`（risk/tier 声明）；owner-only+userArgs 校验 `server/routes/actions.js:171-199`（approveAction，403 only owner :191）；凭据链（自身 ref→线固定 ref→fallback）`lib/action-executor.js:24,47-49`；部署无关 preflight `lib/action-preflight.js:11-16`（target=cloud/desktop 两态）。
② 测试：`lib/action-registry.test.js`(10-22)、`scripts/test-action-executor-refs.mjs`(10-21)、`e2e/action-card-turn.spec.js`(10-24)——存在但 mtime 全簇最旧。
③ 部署：同共同事实。
④ 痛感：n=15 fix=7；`fb7c72a6` 提议参数按注册表校验与归一（缺必填 400 不落库）、`3b3a8cd9` 动作闸双凭据。
⑤ 陈旧度：spec 10-23 vs 代码 10-27（809623f4），剪刀差 4 天。

---

## 簇摘要 — 三件最严重的事

1. **blueprint-studio 铸造链死锁连环补丁（评级 C 的依据）**：30 提交/17 fix 为全簇最高，其中首铸自引用死锁+陈旧指针问题连打 5 刀（`8ab6fffa`/`d18085a9`/`fbe179d0`/`e24ebf04`/`05022564`，2026-11-03 前后），自愈逻辑叠在自愈逻辑上；建议专项清理 cast 前置闸与 provenance 认回的判定矩阵，否则下一个边角仍会触发第 6 刀。
2. **生产 runner 镜像代际分裂**：platform 主镜像源 `dde77c3a`（11-06，lag 6）而 `agent-runner-b.yaml:43` 仍 `sha-51c33c3`=paas `4c03c19`（10-15，**lag 1385 提交**）；serving/c 已同代 `20f304c3`（10-29，lag 554）。fleet 回合执行面跨 runner 代际不一，blueprint 试跑舰队若落在 b 池即跑在 21 天前的行为上。
3. **fleet-scheduler 是无 spec 的活体控制环（shadow）**：`gateway/fleet-scheduler.js`（257 行，failover-by-repoint+placement hint）经 `gateway/packs.js` 在产，但其依据只在 archive（2026-10-12-add-fleet-scheduler），`openspec/specs/` 无任何 scheduler 在册 spec——冷重建/热会话丢弃等风险语义（头注自述 warm transcript dies）无 spec 约束。次级观察：fleet-config-overview 无任何专属测试。
