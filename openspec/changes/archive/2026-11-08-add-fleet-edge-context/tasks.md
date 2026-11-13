# Tasks — add-fleet-edge-context

## 1. 注入缝识别第二个占位符（`cron.js`）

- [x] 1.1 `composeFleetPrompt` 同时识别 `{{fleetContext}}`（patrol）与 `{{fleetEdgeContext}}`（edge）
- [x] 1.2 两个 token 同时在场时各渲染一次、各自替换（不双注入、不互相吞）
- [x] 1.3 替换改用**函数 replacer**：报数文本含 `$` 金额，字符串替换会被 `$&`/`$'` 改写
- [x] 1.4 渲染失败仍抛错 → 该次执行落 failed（姿势与巡视轮一致）

## 2. 渲染器的 edge 形态（`server/fleet-context.js`）

- [x] 2.1 `deps.mode === "edge"` 时表头改为「【集群上下文】」（不带"巡视"）
- [x] 2.2 去掉巡逻纪律尾段，换成一句"背景在下面、任务见上文指令"
- [x] 2.3 不渲染决策送达段，且**不调用** `decisionDigest` provider
- [x] 2.4 总量池 `EDGE_TOTAL_LIMIT = 8KB`（巡视轮仍 24KB），保留"下级优先、本岗按余额截断"
- [x] 2.5 patrol 模式逐字节不变

## 3. 四处 prompt 模板（只给 persona）

- [x] 3.1 派发：`server/routes/fleets.js` 的「集群派发」分支追加 token；tool 分支不动
- [x] 3.2 接棒：`server/fleet-handoffs.js` handoff 分支
- [x] 3.3 扇出：`server/fleet-handoffs.js` fanout 分支
- [x] 3.4 唤醒：`server/fleet-event-wake.js` 的 `createWakeTask`
- [x] 3.5 `server.js` 把 `opts.mode` 透传给 `buildFleetContext`

## 4. 测试

- [x] 4.1 `scripts/test-fleet-report-lane.mjs`：edge 形态含背景、无纪律、不调 digest；
      patrol 形态仍含两者；两 token 分别按各自 mode 渲染；edge 渲染失败不起轮
- [x] 4.2 `scripts/test-fleet-orchestration.mjs`：真实 `igniteFleetEdges` 的 handoff/fanout
      token 只给 persona；dispatch API 给 persona 加 token，**tool 岗 prompt 与 JSON 参数逐字节相同**
- [x] 4.3 `scripts/test-bots-event-wake.mjs`：唤醒任务 prompt 以 token 结尾
- [x] 4.4 **反向证明**：删掉 handoff/派发任一处的 token 追加，4.2 必须红；恢复后全绿
- [x] 4.5 全量逐文件扫（每文件 100s 超时）：**本 change 无新增红**。唯一红
      `scripts/test-agent-studio-validate.mjs`（基线 5/5 → 现 1/4）已归因清楚，与本 change 无关：
      干净 HEAD 5/5 绿 → 只叠本 change 的 6 个源文件仍 5/5 绿 → 再叠并发线未提交的
      `gateway/packs.js` + 新文件 `gateway/pack-publish-gates.js` 复现 1/4。
      真因：N-9 抽取把 `CREATOR_GROUP_REQUIRED` 搬进 `gateway/pack-publish-gates.js:76` 但
      **没有 export**，`gateway/packs.js` 又删了本地那份，`:1466`/`:1540` 引用未定义名字
      → validate 路由抛 `ReferenceError` → 网关子进程 exit 1 → 后续请求 ECONNREFUSED。
      属并发线在途工作，未擅自改动其未提交文件。
      归因三分（worktree 逐层叠 + 同一命令）：
      - 干净 HEAD：`test-pack-marketplace` 8/8、`test-agent-studio-validate` 5/5 全绿
      - 再叠本 change 的 6 个源文件：agent-studio 仍 5/5 绿
      - 再叠并发线 2 个文件（`gateway/packs.js` + `gateway/pack-publish-gates.js`）：
        pack-marketplace 0/8、agent-studio 1/4，崩溃行 `ReferenceError: CREATOR_GROUP_REQUIRED`
      同族新红/新超时共 7 项（pack-validate、pack-marketplace、opening-gates、
      facet-cli-publish、facet-publish-bridge、vendor-supply-open、agent-studio-validate）
      全部落在同一 publish/validate 面，与本 change 的舰队上下文无交集

## 5. 门禁

- [x] 5.1 `npx biome check cron.js server/fleet-context.js server/fleet-handoffs.js server/fleet-event-wake.js server/routes/fleets.js server.js <三个测试文件>` 绿
- [x] 5.2 `openspec validate add-fleet-edge-context --strict` → `is valid`

## 6. 上线

- [x] 6.1 出片滚版 → 已在产（快照取自远端线 `gitee/release/cell-session-persona` f5ceb4a84
      → GHA `sha-cf1f2f0` 直落 `law-bench`；digest `sha256:19a50119`；fd-infra-deploy `d174f27`
      双 bump → ArgoCD → 两 rollout 完成；镜像内 `test-fleet-report-lane`+`test-bots-event-wake`
      = 47/47、`test-fleet-orchestration` = 17/17）
- 6.2 观察项（滚版后，非本 change 交付物）：看一条真实接棒/派发回合的 prompt 体积与
      该岗下一轮的产出质量；确认 8KB 池在真实舰队规模下够用
