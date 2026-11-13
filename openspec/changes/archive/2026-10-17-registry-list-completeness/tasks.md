# registry-list-completeness — 任务清单

> 目标：registry 列表读取按分页契约取全量，截断可观测。生产当前 `/api/agents` 裸读丢 3 条
> （含活跃条目 `daas-analyst`），`/api/servers` 在 `facet/cli` 侧丢 2 条。

## 1. 测试先行（红）

- [x] 1.1 `scripts/test-registry-bridge.mjs` 的桩响应补齐 `total_count`/`limit`/`offset`/
       `has_next` 信封，且按 `offset` 返回切片；跑 `node scripts/test-registry-bridge.mjs`
       现有用例仍全绿（证明信封改动未破坏既有断言）
- [x] 1.2 新增多页用例：桩里放 25 个 agent（`limit=20` 语义下两页），断言
       `getAgentEntries()` 取回全部 enabled 条目；在当前实现上跑**必须红**（证明用例有效，
       不是恒真断言）
- [x] 1.3 新增截断告警用例：桩返回 `has_next=true` 但只给一页，断言捕获到 warn 且消息含
       端点名与 `total_count`；当前实现上跑必须红

## 2. 实现（绿）

- [x] 2.1 `registry-bridge.js` 新增 `fetchAllPages(endpoint)`：`limit=500` 起读，按
       `has_next` 推进 `offset`，返回 `{items, complete}`；终止条件覆盖"本页 0 条"与
       "`offset` 未推进"两种死循环防护；`has_next` 缺失时按 `total_count` 退化判定；
       **非 2xx（尤其 limit 越界的 422）必须抛错而非当空页**，走 last-good
- [x] 2.2 `doRefresh()` 三处读取统一改用该助手（servers / skills / agents），删掉 agents 的
       裸读；`complete === false` 时 `console.warn` 含端点、`total_count`、实际条数
- [x] 2.3 其余四处 `limit=500` 硬顶改走同一读法（普查所得，同一假设的潜伏副本）：
       `lib/agent-serving.js`（端口占用，失败降级）、`agent-runner/registry.js`
       （runner 分片）、`gateway/packs.js`（fleet scheduler）、
       `server/routes/wanxing-fleet.js`（8s 超时，截断时返回已取部分并告警）
- [x] 2.4 `facet/cli/facet.js` 的 `verifyCallerKey` 可见 server 列表改走同一读法（best-effort
       语义不变：失败仍不阻断验活）；跑 `node scripts/test-registry-bridge.mjs` 全绿
- [x] 2.5 突变自检：临时把助手改成"只读一页"，1.2/1.3 必须转红，确认断言非恒真后还原
       （实测：突变后 1.2/1.3 转红、其余 7 用例保持绿，已还原全绿）

## 3. 出片与验收

- [x] 3.1 `fd-build-channel` 判路 → 出片（GitHub Actions，禁节点本地 build）→ 滚产
       （公开快照线构建验证绿；镜像实走 `testaction002/build-pool`——首跑红为池 repo
       变量 `BUILD_CONTEXT=web` 残留，删后 rerun 绿；tag `sha-d1c1cb3` ≙ paas `a1c1a60c`）
- [x] 3.2 生产验收（模块级）：pod imageID = hkccr digest `2f767fb1` 全等；cell 内通道
       `/api/catalog` registry-sourced agents 11→12 与 registry enabled 口径一致；
       pod 日志无截断 warn。**只断言条数完整**——`daas-analyst` 是孤儿（pack 404、
       `num_skills=0`），未断言其"可用"
- [x] 3.3 生产验收（真机）：模块级已走 cell 内真实鉴权通道（gateway secret + 真实
       cell 端口 + 真实 registry 数据）；浏览器眼见留待下次真机试用顺带复核
       （module-vs-e2e-acceptance-gap 口径：本轮验证的是数据面完整性，UI 渲染层
       未改动）
- [x] 3.4 台账 `docs/registry-maintenance.md` §12.11 记录本次修正（sha-d1c1cb3 /
       digest 2f767fb1 / 三条教训）

## 4. 跨仓后续（不在本仓实施，登记以免丢失）

- [x] 4.1 `finddata-skills`（Gitee）`scripts/register_skills.py` 裸读版已修：判重与
       verification 两处改走分页 `all_skills()`（has_next 翻页/limit=100 推进 offset/
       兼容裸数组），保留本仓 SKILLS 清单与 payload 字段。**收尾加做**：修好的
       wire-presets 版 register 脚本首次进 gitee 仓 `wire-presets/register_skills.py`
       （load_description 适配仓内布局），双拷贝隐患消除
- [x] 4.2 `--rescan` NameError 已修：`all_skills()` 返回 `(names, items)` 二元组，
       `--rescan` 改用 items 拼扫描 URL；stub 离线验证 17 个 scan 请求全发出、rc=0
- [x] 4.3 网关侧（mcp-gateway-registry `5af96c16`，分支 fd-product-home）：三列表端点默认
       `limit` 20→500（上限 2000 不动；不加告警头——信封 `total_count`/`has_next` 已是
       完备性契约）。出片 `sha-bfd0de4` → digest `c740d37a` hkccr=ccr 全等 → 滚产（digest
       引用）。生产实测：skills 216/216、servers 23/23、agents 23/23 裸读全量、
       `has_next=false`；paas 回归 catalog 12 条与 enabled 口径一致。出片途中两次事故
       （relay 竞态盖同名 tag / fd-build-snapshot 默认分支陷阱）已实录台账 §12.12

> **交接完成（2026-10-17）**：4.1/4.2 由独立 session 按
> `~/finddata/docs/handoff/registry-pagination-register-scripts.md` 执行完毕并核销——
> gitee `finddata-skills` `21c8740 → 7d4fc94`（双远端已在 main/master）；验收实跑：
> 两脚本 `existing skills on gateway: 212` + 19/19、17/17 全 SKIP + verification
> missing=none；干净 clone 复跑同证。4.3 已于同日收口（见上）。**全组任务完结。**
