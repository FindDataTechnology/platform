# unify-wanxing-management-plane — 任务清单

## 1. cell 侧：stats 快照 + HTTP 车道

- [x] 1.1 `task-engine.js`：`stats({now})` 派生——`{jobs, executions:{running,queued},
       workers, recent:{done,failed,interrupted}, agentBusy}`；纯计数、无 prompt；
       worker 池占用经注入的 provider 取（不硬连 server 层）
- [x] 1.2 `server/worker-slots.js`：只读 `poolStats()` → `{cap, busy, idle}`（不带 persona）
- [x] 1.3 `server/routes/tasks.js`（或既有任务路由挂点）：`GET /api/tasks/stats`——
       标准 cell 鉴权（**非** loopback 豁免），答 stats JSON
- [x] 1.4 单测：stats 形状（在跑/排队/worker 占用）；**无用户内容**（prompt 子串不得出现
       于序列化）；stats() 无副作用（重复调用结果一致、不打断队列）

## 2. gateway 侧：代采上报器

- [x] 2.1 `gateway/fleet-cells.js`：`createCellFleetReporter({cells, fetchImpl, env, log})`——
       env 缺任一（URL/TOKEN）不启动；tick 串行遍历 cells、2s 采样超时、批量 POST ingest
       （ULID id、source `cell-sampler`、agent `cell:<userId>`、kind `cell_stats`）；失败
       log-only 丢批；timer unref
- [x] 2.2 `gateway/index.js` 接线：spawner cells Map + env 装配（默认全关=零变化）
- [x] 2.3 单测：未配置不跑不发包；两 cell 各得上报一条（身份/形状断言）；一 cell 采样
       失败不影响其余；ingest 500 丢批不抛

## 3. runner 侧：心跳密度自报

- [x] 3.1 `agent-runner/fleet.js`：runner_stats payload 增 `pod`（config.podMode）；
       harness-adapter 既有测试同步
- [x] 3.2 单测：payload 含 pod 布尔；旧形状（无 pod）消费侧读作 solo 的降级断言
       （在既有 board/门测试上补）

## 4. 姊妹仓 fd-wanxing（独立 change `add-fleet-cell-views`，本节只交叉引用）

- [x] 4.1 fd-wanxing change 立项+实施：observer EVENT_KINDS 收 `cell_stats`、board 增
       `cells` 段 + `cells_total`；console 统一视图（cells 表与 runners 并排）
- [x] 4.2 发布线滚产（该仓自有管线）

## 5. 出片与生产实证

- [x] 5.1 `fd-build-channel` 判路 → 快照出片（GHA→hkccr→relay→ccr 链路纪律）→
       fd-prod 平台容器 + agent-runner-serving 两滚动位滚产
- [x] 5.2 生产眼见：board `runners[].pod` 字段出现（serving runner=false）；fd-prod 配
       FLEET_INGEST_URL/TOKEN 后 board `cells` 段有真 cell 遥测（jobs/executions/workers
       计数对得上 cell 内 /api/tasks/stats）；console 统一视图渲染
- [x] 5.3 零回归：cell 流量、runner 部署/回合、既有 board 段全部不伤
- [x] 5.4 台账（docs/registry-maintenance.md §9）+ 底稿切片⑤完结注记 + 记忆落盘

## 追记（2026-10-15 全项收口）

- **1-3 全绿**：task-engine stats()（4 新测；boot 注入 workerStats 闭包，pool 后挂懒读）+
  worker-slots `poolStats()`（无 persona）+ `GET /api/tasks/stats`（标准 cell 鉴权，非豁免）+
  gateway `fleet-cells.js` 代采上报器（4 新测；`startImmediate` 参数供测试关构造即采）+
  runner `pod` 自报（sampler 测试断言 true/false 两态）。**全量单测 1375/1375**（含首轮
  worker-pool 负载时序 flake 复跑即绿）；biome 净；lint-dsh-adapter 18 名单绿。提交 a578a5a。
- **4.x 姊妹仓**：fd-wanxing `add-fleet-cell-views`（e3f0408）——observer 白名单+board
  cells/shortterm（**rollup 面显式排除 cell_stats kind**：rollupHour 对任意 kind 先建
  agent 累计行，不排除则 cell 身份泄漏进 agents_total——首测即抓到，改后 11/11）+
  OpsView 统一视图；全量 135/135、web build 绿。
- **5.1 出片事故与抢救（在册）**：fd-build-channel 判路后走 T2 池三快照。**池变量竞态**——
  工具在 push **之后**才设 BUILD_IMAGE，push 触发的 run 读到该池上一镜像旧值：fleet-observer
  构建把镜像推进了 `yizuo/fd-legal-search-mcp`（真生产线在 finddata-business/ 命名空间，
  零消费方、不在 relay 清单→ccr 未受染；删错 tag 后 TCR 回收空仓；seen-tags 打标防「首见」
  误搬运）。重派后正确落 hkccr，手动 relay 补单到 ccr（digest 3548ef42 全等）。
  **工具已修**（~/.local/bin/fd-build-snapshot）：变量+relay 登记挪到 push 前、变量写失败即
  中止、成功回执加 target 核对提示。另：wanxing-web 烟测 45 秒 boot 门对「集群内反代」镜像
  天生误杀（nginx upstream 解析不了 k8s 服务名）——池 003 置 SMOKE_MODE=skip。
  快照源纪律再证：工具「远端 clone 失败退回本地工作树」会带进并行会话未提交残留
  （trace.db/-shm/-wal+.impeccable 缓存）——本地干净 clone 重出后与源 sha 精确一致。
- **滚产**：GitOps 89446e6（fd-infra-deploy）——platform sha-022cb16 双滚动位（fd-prod
  网关 **+FLEET_INGEST_URL/TOKEN 开门**、wanxing-fleet/ingest_token 同源密钥；
  agent-runner-serving）+fleet-observer sha-9b45cf4+wanxing-web sha-daef5b8；ArgoCD 异步
  sync 后四 deployment 全 Ready。
- **5.2 生产眼见（全链）**：board `runners.runner-serving.pod=true`（该位生产本就 pod 模式，
  自报如实）；**cells 段两条真 cell 遥测在流**（两次读板 seen_at 精确 +30s=采样循环活；
  其中一台 agentBusy=true）；shortterm 汇总对；agents_total=21 常驻口径零污染；网关日志
  `[gateway] cell fleet telemetry armed (FLEET_INGEST_URL)`。浏览器级验收
  `scripts/probe-wanxing-ops-unified.mjs` **7/7 ALL PASS**（Logto 真登录→控制台→运维面→
  cells-panel 眼见 cells 2+2 行+runner-serving pod 徽标；坑在册：**会话不耐整页 reload，
  必须站内点击导航**；断言要等 board 首拉落定）。截图 /tmp/wanxing-ops-unified.png。
- **5.3 零回归**：四滚动位 Ready；board 既有段（states/turns/missions）原样；runner 部署
  门/心跳其余字段不变；未配 env 的部署（platform-demo 等）字节级零变化（reporter null）。
