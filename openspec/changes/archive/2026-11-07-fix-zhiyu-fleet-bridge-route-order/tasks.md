# Tasks: fix-zhiyu-fleet-bridge-route-order

> 本地 apply 已完成 1.x–4.2；4.3+ 出片/上产属生产动作，本轮未执行，保持未勾。证据见同目录 `evidence.md`。零假绿。

## 1. 确认装配契约与回归基线

- [x] 1.1 复核全仓 `registerZhiyuRoutes` 的调用点，记录各自是否依赖内联 404 兜底；验证=各带 `file:line` 与依赖判定，落 `evidence.md`。→ **10 处**（立案时窄 grep 只看到 5 处，apply 更正）：1 生产 `gateway/index.js:866` + 9 测试 `test-zhiyu-{im-bridge,e2e-chain,billing,room-memory,notify,duty,router,rooms,widget}.mjs`；见 `evidence.md` §1.1。
- [x] 1.2 复核桥注册之后 `gateway/index.js` 不再注册任何 `/api/zhiyu/*` 路由、且 cell 代理 `app.use` 是全局最后兜底；验证=`awk` 扫描 889~1126 之间零 zhiyu 注册，确认收尾调用点落在两者之间（D4）。
- [x] 1.3 记录修复前基线；验证=`test-fleet-room-bridge.mjs` **6/6 绿**、生产四端点 404 的四路交叉证据已在 `optimize-zhiyu-behavior-walkthrough/evidence.md` §3.5，且明确「测试绿 ≠ 端点可达」。

## 2. 实现：可延迟的兜底收尾

- [x] 2.1 在 `registerZhiyuRoutes(app, opts)` 增加可选 `deferNotFound`（默认 `false`）：为 `false` 时末尾照旧内联注册 404 兜底，为 `true` 时跳过；验证=10 套既有 `registerZhiyuRoutes` 调用方套件全绿（81/81 的一部分），未匹配路径仍同形 `404 {"error":"not found"}`。
- [x] 2.2 在返回对象上暴露 `registerNotFound()`，函数体只注册该 404 兜底、无鉴权无代理（D2）；验证=代码走查 + 3.3/3.5 测试覆盖。
- [x] 2.3 在 `gateway/index.js:866` 传 `deferNotFound: true`，并在 `registerFleetRoomBridge`（:889）之后、cell 代理（:1126）之前调用 `zhiyu.registerNotFound()`（:918）；验证=`grep` 顺序核对 + `npm run typecheck` 绿。
- [x] 2.4 确认 `gateway/fleet-room-bridge.js`、`gateway/zhiyu/store.js`、`gateway/zhiyu/im-bridge.js` 零改动；验证=`git diff --name-only -- gateway/ scripts/` 仅 `gateway/index.js` + `gateway/zhiyu/index.js`（新测试为 untracked 故不在 diff）。

## 3. 装配顺序集成测试（防回归闸）

- [x] 3.1 新增 `scripts/test-zhiyu-route-assembly.mjs`：同一 `express()` 按生产顺序装配，临时 SQLite + 固定 `resolveUser` + 自有团队 `sampleFleets` stub + 计命中数的 cell 代理 stub；验证=`node --test` **5/5 绿**。
- [x] 3.2 四条正例断言：GET/POST/DELETE subscriptions 与 POST summon(dryRun) 均非 404，进入既有所有权/成员闸（合法 201/200、DELETE 200、回读 1 行；非自有团队与陌生人同形 404）；验证=输出逐条 PASS。
- [x] 3.3 兜底正例：未匹配 `/api/zhiyu/*` 仍 `404 {"error":"not found"}` 且 cell 代理命中数 0；验证=PASS。初版把代理 stub 挂在兜底之前导致 599，已按 D4 修正——测试因此也验证了这条装配纪律。
- [x] 3.4 **负例回归闸**：把 `registerNotFound()` 提前到桥之前，四条桥端点全部回 404（复现缺陷形状）；验证=PASS。
- [x] 3.5 对照组：`deferNotFound` 缺省时内联兜底仍在、未匹配路径 404、代理零命中；验证=PASS。
- [x] 3.6 全量回归 13 个 zhiyu 套件（既有 12 + 新增 1）；验证=**81/81 PASS，0 fail**。

## 4. 本地门禁与出片

- [x] 4.1 触碰面门禁；验证=`npm run typecheck` 绿、`npx biome check` 三个文件 0 error（初版 1 个 `noUnusedFunctionParameters` 已修 `req`→`_req`）。全仓 `npm run lint` 的 7 errors / 3 warnings 落点全在 `facet/*` 与 `scripts/studio-*` 等**并发会话在途改动**，与本次三个文件无关，已核。
- [x] 4.2 `openspec validate fix-zhiyu-fleet-bridge-route-order --strict`；验证=`Change … is valid`，EXIT=0。
- [x] 4.3 提交改动并按仓内出片线滚 platform 镜像；验证=源提交 sha 与镜像 tag 对应、GitOps bump 后 pod `1/1 Running`。→ 提交 `f7d593c5e`（修复）+ `fb7fa7082`（快照闸维护）；双推 origin/gitee `15634c240`；`make-public-snapshot --init` 全门绿 → 镜像仓 `85e946f` + 恢复提交 `1f9335b` → run 42256943637 全绿（build+五道 smoke+push）；relay `OK yizuo/platform:sha-1f9335b (4s)`；ccr skopeo 硬门 digest `sha256:5c862edc`；GitOps `4fbf889` 双清单 → ArgoCD hard-refresh → 双 rollout 绿 → 双 pod imageID `5c862edcabe4` 逐字全等。
- [x] 4.4 出片后真机复验四条桥端点；验证=逐条证据落 `evidence.md`。→ 专用房 `zy_1ad879f94b7f3248e3`（owner `aloadtree@gmail.com`）：GET subscriptions **200**（修前 404）、POST 订阅 **201**（`fs_1793987849221_2qmcz2`）、DELETE 回读 200、dryRun 召唤 **200**（summonable 空 + cockpitOnly 分诊/处置岗如实分诊）；非自有团队同形 404、未匹配路径仍 404（兜底未丢）；`zy_fleet_subs` 从 0 → 1（生产首行）。公开演示房未触碰（day_turns 保持 8）。
- [x] 4.5 观察一轮拉取 tick 与频控/熔断纪律；验证=事件行流入或如实记录。→ 等 2 个 tick 后空间流出现两条桥事件行：`bridge=health to=abnormal deepLink=true`、`bridge=report deepLink=true`（带来源标注+驾驶舱深链），全部 `visibility=shared` 零 private 行；密集合并/熔断丢弃语义由 3.x 测试与 `fleet-room-bridge.js:24/26/244` 在码覆盖（本轮无密集窗口，未触发合并路径）。
- [x] 4.6 把 4.4/4.5 证据回填 `optimize-zhiyu-behavior-walkthrough/evidence.md` 与 `docs/registry-maintenance.md` §15.138，解锁该单 2.x/3.x/4.3；验证=两处更新在册。→ 见 §15.138 续记与本仓 evidence §6；走查单已解锁。

## 5. 收口

- [x] 5.1 确认 `optimize-zhiyu-behavior-walkthrough` 的 O0 可标「已解除」，其余 O1–O7 各自归属不变；验证=证据链闭环、零假绿。→ O0 已解除（真机四端点 + 订阅落库 + 事件行三证）；O1–O7 归属不变，走查单已解锁 2.x/3.x/4.3。
- [x] 5.2 `openspec archive fix-zhiyu-fleet-bridge-route-order`（`validate --strict` 先行）；验证=归档后 `openspec show fleet-room-bridge --type spec` 含新增需求与四场景。
