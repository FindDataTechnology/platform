# Tasks — fix-zhiyu-seat-settle-missing-billing-key

> 本单当前阶段=记录与定性。修复方案需一次决策后再动手，故 2.x 保持未勾。

## 1. 取证与定性（已完成）

- [x] 1.1 抓取 404 的完整响应形态（`curl -i`，pod `platform-7db8449c78-zr7gf`）：
      `HTTP/1.1 404 Not Found` / `Content-Type: application/json; charset=utf-8` / `Content-Length: 30` /
      `ETag: W/"1e-8ouT8eCVcN2daXbYJt2Dcg5Z28I"` / body `{"error":"no such deployment"}`
- [x] 1.2 抓取同一端点的 200 对照（`wx-alpha`）：`Content-Length: 50` / body `{"settled":true,"duplicate":false,"amountUsd":0.1}`
- [x] 1.3 面量化：`intro-guide|intro-yizuo|intro-lex|intro-wire|intro-facet` 五席全 404；`wx-alpha`(v2, skills 非空)、`data-scout`(v1, skills 非空) 200
- [x] 1.4 根因到行：`facet` 的 `/app/gateway/packs-internal-routes.js:93` 由 `deploymentKeyForAgent()` 返回 null 触发；
      该函数（`/app/gateway/packs.js:1118`）查 **`deployment_keys`** 表而非 `deployments` —— intro 五席有部署行、无计费键行
- [x] 1.5 记下文案缺陷：404 body 说 `no such deployment`，但部署其实存在，缺的是计费键——错误文案掩盖真因

## 2. 方案（待决策）

- [x] 2.1 决策（2026-11-10 用户拍板）：**走 ② 结算侧降级，不补键、不动 `deployment_keys`**——它有多消费者（wanxing facade / matters / admin 管理面），擅动会连带中断
- [ ] 2.2 【挂起 · 未采纳】若选①才做：幂等补键脚本（按 `deployments` 生成 `deployment_keys`）。用户裁决为 ②，故**本项保持未勾且不动 `deployment_keys`**；若将来要补，先确认 deployer 与部署行一致，否则带 `deployed_by` 的查询仍落空
- [x] 2.3 ②已实现：`gateway/packs-internal-routes.js` 的 `!key` 分支先查 `registry.deployments(packId)`——部署行在但无键 → **409 `{code:"NO_BILLING_KEY"}`**；部署行也没有 → 404 `{code:"NO_SUCH_DEPLOYMENT"}`（保留原语义）。验证：最小脚本 PASS（34ms，见 proposal「裁决与 A/B 结论」）
- [x] 2.3b `gateway/zhiyu/agent-lane.js`：把 409 的 `code` 抬成 `err.code` 并置 `err.unbilled`，不再只拼一句 `HTTP 409: {...}`
- [x] 2.4 运维可见：`gateway/zhiyu/room-router.js` 收到 `NO_BILLING_KEY` 时落一行 `settle_unbilled` 事件（kind=event，含 memberId/display/seq/code/minutes）+ 一条点名 warn + 回合记录带 `detail.unbilled`；`server/observe-tap.js` 扩展为可承载有界 `detail`（只收 string/number/boolean，≤8 键、键≤32 字符、值≤120 字符），避免该字段被静默丢弃

## 2.5 顺序（proposal「两条路线的影响面、回滚成本与先后顺序」一节已展开）

- [x] 2.5 顺序（**不适用**）：该条只对「两件都做」有意义；用户已裁决只做 ②、不做 ①，故无先后可言。保留此行以示该分支曾评估过

## 3. 验证与收口

- [x] 3.1 上产后真机复验（2026-11-10 21:31，platform `sha-f5764d0` + facet 同片 `sha-f5764d0`）：
  - ① `grep -c NO_BILLING_KEY /app/gateway/packs-internal-routes.js`：platform **1**、facet **1**（facet 换片后）。
  - ② 日志：`2026-11-10T21:30:53.483826547+08:00 [zhiyu] settle unbilled (no billing key) for …intro-guide in zy_42ce690574b5423bd2 (seq 114)`；`settle unbilled` 命中 **1**，旧文案 `settle failed … 404` 仅剩换片前那条（21:13:03）。
  - ③ 房间多一行 `settle_unbilled`（seq 115，meta `{event, memberId, display, seq:114, code:"NO_BILLING_KEY", minutes}`）；`pack_host_settlements` **保持 12 行 / zyr- 4 行不变**（降级不是补账）。第二轮作答再验幂等：事件行 1→2、结算表仍 12/4。
  - 访客侧不可见：390×844 打开 embed 两次，body 均不含 `settle_unbilled` / `未计费`（`EVENT_LABEL` 无此键即被过滤）。
  - 探针已清理：两轮共 12 行（seq 109–120）+ 3 个 guest 删除，房尾回 108 / guest 23（备份 `/data/cells/zhiyu-3.1-accept-backup.json`）。
  - 关键判别：第一轮（facet 未换片）①过②败，日志是 facet 吐的旧 404；facet 换到同一镜像后 ①②③ 全过。**同镜像双入口（`node facet/index.js`）意味着"给 facet 出片"= 升 facet 的 tag，不需要另剪快照。**

- [x] 3.2 `openspec validate fix-zhiyu-seat-settle-missing-billing-key --strict` 绿（`skip_specs: true`）。2.3 只改错误码与房间标注，未改「计费与配额挂钩」的要求语义（仍是发言计费，只是无键时如实标注未计费），故不补 spec delta

## 取证记录（2026-11-10）

| 项 | 值 |
|---|---|
| 平台镜像 | `sha-0ef03c7`（基线 `f2c66d444`） |
| 观察 pod | `platform-7db8449c78-zr7gf` |
| 触发回合 | 演示房 `zy_42ce690574b5423bd2` seq 112（产品向导作答后结算） |
| 平台侧日志 | `[zhiyu] settle failed for bTnrv2P_JhmCzqqXCF0GIA:intro-guide in zy_42ce690574b5423bd2 (seq 112): host-settle HTTP 404: {"error":"no such deployment"}` |
| facet 侧 | 成功结算会打 `[packs] host-settle <usage_id>: …`；404 的**不打日志**（只在响应里），所以只看 facet 日志会以为没有结算请求 |

## 4. 验证记录（2026-11-10）

- **A/B（挂起归因）**：`git stash push` 只挪我改的 5 个文件 → 原始代码上跑 `scripts/test-platform-billing.mjs` 同一条 host-settle 用例：cancelled / 100s / 退出码 124；另跑一条与 host-settle 无关的用例同样挂（90s）；空过滤 1s 正常退出。⇒ 挂起属该套件 harness 收尾问题（`server.close(cb)` 等 keep-alive 连接），与本次改动无关，也与该用例内容无关。
- **契约本体**：最小脚本（`createPackRegistry` + `recordDeployment` 只写部署行不写键 + `registerInternalPackRoutes`）→ keyless **409 NO_BILLING_KEY**、never-deployed **404 NO_SUCH_DEPLOYMENT**，34ms，`server.closeAllConnections()` 干净收尾，verdict PASS。
- **回归**：test-zhiyu-billing 3/3、test-zhiyu-rooms 17/17、test-zhiyu-room-lifecycle 11/11、test-zhiyu-router 8/8，cancelled 全 0。
- **lint**：`npx biome check` 五个改动文件，无告警。
