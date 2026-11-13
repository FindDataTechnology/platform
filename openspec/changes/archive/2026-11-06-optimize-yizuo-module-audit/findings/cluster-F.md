# 簇 F 审计报告——cell · 任务 · 执行底座（13 条）

仓：/Users/chengsishi/finddata/paas。审计日 2026-11-06。核对代码：task-engine.js、cron.js、server/cron-runner.js、server/worker-slots.js、server/llm-lane.js、server/routes/{tasks,cron,misc}.js、db.js、gateway/{index,spawner,cell-registry,duty-ring,packs,fleet-scheduler}.js、lib/{cell-lifecycle,proc-memory}.js、agent-runner/harness/*、agent-runner/fleet.js、web/src/lib/scheduleParse.ts。另核对了 harden-cell-execution-reliability 三份 delta（见末节）。

## 一、判定总表

| spec | 评级 | 一句话依据 |
|---|---|---|
| task-engine | A- | 生命周期/重启修复/原子持久化/统计快照全对齐（task-engine.js:176-194,64-138,763-796；server/routes/tasks.js:1-17）；仅 creation 期 ref 解析未实现 |
| cron-module | C | interval 单位与 phase 超claim；"SHALL NOT catch up" 与代码及姊妹 spec 双重矛盾（cron.js:44-57,150-157） |
| worker-pool | A | worker-slots.js 逐条对齐：cap 0 默认、persona 亲和、5min 回收、人优先额外槽、crash 隔离（24,39-48,216-248,81-92） |
| cell-gateway | A- | 网关/生成器/值班环全对齐；遗留豁免与 interval 唤醒盲区两处小瑕（spawner.js:715-726, duty-ring.js:115） |
| cell-lifecycle | A- | 纯词汇层+注册表+重建对齐（lib/cell-lifecycle.js 全文）；唤醒需求只承诺 cron 表达式，与代码一致，但跨 spec 盲区落在其语义域 |
| tenant-cell-runtime | A | workspace 钉扎在 baseEnv 之后覆盖（spawner.js:336-337）、cwd 入用户根（274）、匿名 pack skill 由网关应答（packs.js:1957-2000） |
| harness-adapter | A | adapter/acp/dsh/registry 四件套 + runner_stats 携 harness/models/density（agent-runner/fleet.js:146-164, acp.js:106） |
| a2a-agent-serving | B+ | 水位/访问模式/port_override/toolFace/roster 均有实证（packs.js:1574,1584,2223；fleet-scheduler.js:213）；叙事混入规范文本，十余条需求未见逐条验证 |
| project-container | A | /api/projects 三路由（server/routes/misc.js:827-868）；projectId 随任务记录透传（task-engine.js:127, cron.js:534） |
| project-database | A | WAL+FK（db.js:1117-1118）、schema_migrations、email 键控绑定表、dbReady 降级全实证（db.js:1074-1138,236-251） |
| scheduled-task-notifications | A- | 未读=客户端派生有实证（server/fleet-digest.js:6-9）；WeChat 订阅信封零代码（MAY 合法但成悬空档） |
| scheduled-tasks-ui | A- | NL 解析器与任务页存在（web/src/lib/scheduleParse.ts、pages/TasksPage.tsx）；深层 UI 未逐条验 |
| upstream-concurrency | B+ | 实现在仓外 sub2api fork（仅 docs/sub2api-fork-patches/），本仓不可审计；Purpose TBD（spec.md:4） |

无 D 级。两处 C/B+ 债各有明确锚点，展开如下。

## 二、C 级展开：cron-module

**C1. interval 单位与 time-of-day phase 超claim（能力悬空）**
- spec「Job scheduling API」与「Interval rules are the truth」承诺 `minute/hour/day/week/month/year` 六单位 + "optionally pinned to a time-of-day phase"。
- 代码只认四单位：`INTERVAL_UNITS = new Set(["minute","hour","day","week"])`（cron.js:150），month/year 被 validateInterval 拒绝；`nextIntervalOccurrence` 是纯 anchor+k×step（cron.js:165-171），**无任何 phase 逻辑**——cron.js:148-149 注释声称 "Day/week units honour the job's timezone for the optional time-of-day phase"，注释提到的功能不存在。
- 该超claim从源头就有：archive/2026-10-31-add-cron-automation-parity/specs/cron-module/spec.md:6 同文。UI 侧 interval builder 未暴露 month/year，但 API 调用方按 spec 发 `unit:"month"` 会吃到矛盾报错。
- 定级 C 的另一半：spec「Downtime and expiry lifecycle」写 "Recurring schedules ... SHALL NOT catch up"，而代码在容忍窗内**会**补跑（cron.js:44-57 + withinToleranceWindow cron.js:179-198，2026-10-26 P2 引入），且姊妹 spec 明说相反——cell-gateway 值班环场景 "executes the round (including any applicable catch-up)"、cell-lifecycle "履约（含停机补跑）"。补跑行为指定的归属变更落在 agent-fleet-core 的 change 里，cron-module 本条从未回改，留下 spec-代码-姊妹 spec 三方矛盾。
- 其余 10 条需求对齐质量很高：熔断 streak/哈希车道 id/skipped 不喂养（server/llm-lane.js:35-85 与 cron-runner.js:739-751）、舰队回合子进程逐轮轮换+best-effort 清理（cron-runner.js:555-585）、turnTimeout [2,30]min 钳制默认 10min（cron-runner.js:103-120）、相对 one-shot 服务端锚定（cron.js:426-431）、update 保 id 保历史（cron.js:557-701）、降级重试 degradedTo（cron-runner.js:803-877）。

## 三、B+ 级展开

**a2a-agent-serving（B+，偏差是体量与卫生而非失实）**
- 抽验全部命中：`PACK_ACCESS_MODE`（packs.js:1574，closed 默认）、`FLEET_CAPACITY_WATERLINE_MB` 默认 512 + `FLEET_AT_CAPACITY` 503（packs.js:1584,2223）、`port_override` 降级与删除（gateway/fleet-scheduler.js:213-216）、`serving.toolFace:"chat"` 物化裁剪（agent-runner/compose.js:151）、roster 门与 heartbeat `models` 字段（agent-runner/fleet.js:150-157）。
- 未逐条验证：多部署者租户化三元组、secrets 绑定/解绑矩阵、subset deploy 拒绝细节——spec 声称极细（含 2026-10-25 生产事故回写），方向与代码注释文化一致，抽验未见反例，故给 B+ 而非 C。
- 卫生债：多条需求把事故叙事写进规范正文，规范性 SHALL 与背景叙述混杂，15 条需求已呈叠层状。

**upstream-concurrency（B+，归属与可审计性）**
- 实现不在本仓：全仓 grep `UPSTREAM_CONCURRENCY_MAX|queue_full|aimd` 仅命中 docs/sub2api-fork-patches/{README,upstream-pr-candidates.md} 与 openspec 文本——sub2api 网关是外部 fork，经 patches 文档维系。
- spec 本身内容具体自洽（有界队列/AIMD/三指标/哨兵收编），archive/2026-11-05-add-sub2api-fork-concurrency 带完整 design，属"诚实但本仓无从对账"。Purpose 仍是 TBD 占位（spec.md:4）。

## 四、A- 级瑕疵清单（小瑕，均不误导）

1. **task-engine**：spec 要求 creation 拒绝 "whose `ref` the cell cannot resolve"，但 insertTask 只验 type 不验 ref（task-engine.js:262-267，persona 显式允许 null ref），a2a ref 在执行期才解析（cron-runner.js:499-501）；cron.js:539-541 注释 "insertTask validates the target (persona-only today)" 已过时（SUPPORTED_TARGET_TYPES 实为四类，task-engine.js:28）。
2. **cell-gateway**：legacy 无注册表部署保留 "cron/bot 阻止回收" 豁免（spawner.js:715-726），spec 却绝对化写 "superseded"——建议补 legacy-mode carve-out；memory gate / 唤醒预算 / 驱逐链 / SIGTERM 链路（index.js:1168-1182）均逐条命中。
3. **cell-lifecycle**：词汇层与注册表干净对齐；`wakeDue` 用 workload.nextDueAt 但值班环以 jobs.json 扫描为准（duty-ring.js:32-50，spec 语义一致）。
4. **scheduled-task-notifications**：未读派生有实证；WeChat 订阅信封在 miniapp/ 与 server/ 均无代码（`requestSubscribeMessage` 零命中）。MAY 合法，但 "Consent SHALL be requested only from explicit user interaction" 这条 SHALL 目前是空转条款。
5. **scheduled-tasks-ui**：NL 解析/模板/interval builder 存在；UI 历史列表取 clientShape 尾 20 条（task-engine.js:379）与 "sourced from existing history" 一致。

## 五、harden-cell-execution-reliability delta 对账（不计漂移）

三份 delta 声称的现状均与代码一致：
- cron-module delta："existing tolerance-window catch-up (2× period, 6h floor, PLATFORM_CRON_CATCHUP kill switch)" ↔ cron.js:179-198 逐字命中。
- task-engine delta："preserving the current fail-fast behavior" ↔ task-engine.js:370 现行 SHALL NOT retry；"the existing record-only path" ↔ countMissedOccurrences 只记账。
- harness-adapter delta：契约测试目标 agent-runner/harness/acp.js 存在。
- delta 无一修改 cron-module 的矛盾条款（C1 补跑矛盾），本次 harden 不应被当作修复该矛盾的载体。

## 六、本簇 P0/P1/P2 候选

**P0**：无。

**P1**
1. **值班环只认 cron 表达式任务**（cell-gateway/cell-lifecycle × cron-module 交叉）：`cronJobsDue` 要求 `j.cron && type==="recurring"`（lib/cell-lifecycle.js:115），interval 型 recurring 与 one-shot 任务**永远不会唤醒** suspended/on_demand cell——cron-module 已把 interval 提为 first-class，纯 interval 任务的 cell 会被静默挂起后永不再履约。要么扩扫描、要么在两份 spec 明示 interval 任务不参与唤醒。
2. **cron-module 补跑条款回改**：把 "SHALL NOT catch up" 改为现实的"窗内一次补跑 + 窗外只记账 +（harden 后）显式告警"，消除 spec-代码-姊妹 spec 三方矛盾。
3. **cron-module interval 单位/phase 收敛**：从 spec 删去 month/year 与 time-of-day phase（或补实现与 UI 暴露），同步修正 cron.js:148-149 的失实注释。

**P2**
1. upstream-concurrency Purpose TBD 补写（spec.md:4）；spec 头部注明实现载体为仓外 sub2api fork 及 patches 文档位置。
2. task-engine：creation 期 ref 解析要么实现要么改 spec 为"执行期解析、失败如实 failed"；顺手删 cron.js:539 过时注释。
3. scheduled-task-notifications：WeChat 订阅信封标注为未实现的 future-MAY，或删条目。
4. cron-module update 目标重绑定：代码已支持（cron.js:603-677），spec 写 "changing the target ... is not part of update"——spec 落后于代码，补一句。
5. a2a-agent-serving 卫生：事故叙事移入注记/ledger 引用，需求正文只留 SHALL/场景；15 条需求按 deploy/upgrade/pause/placement 分节。
6. cell-gateway legacy 豁免 carve-out 一句话（spawner.js:715-726）。

## 七、复核锚点索引

- 任务引擎持久化/修复：task-engine.js:64-138,155-199,225-238
- 主链串行与 worker 声明：task-engine.js:421-464,485-508；worker-slots.js:166-271
- 值班环纯持久化判决：gateway/duty-ring.js:27-71；lib/cell-lifecycle.js:97-125
- 生成器单进程纪律：gateway/spawner.js:293-301（换记录先杀进程）、568-660（in-flight 同步登记）、663-677（SIGKILL 升级）
- 销毁墓碑：gateway/index.js:555-581；抑制重生 spawner.js:570-577
- 内存门 fail-open + 唤醒投影 + 驱逐链：spawner.js:402-561；lib/proc-memory.js:220-236
- runner_stats 三字段：agent-runner/fleet.js:146-164
- 契约四件套：agent-runner/harness/{adapter,acp,dsh,registry}.js
- 项目库：db.js:20-31,236-251,1074-1138；server/routes/misc.js:827-868
