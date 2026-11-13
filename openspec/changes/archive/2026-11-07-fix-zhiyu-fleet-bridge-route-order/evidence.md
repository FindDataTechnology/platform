# Evidence: fix-zhiyu-fleet-bridge-route-order

> 执行 2026-11-06 本地 apply → 2026-11-07 出片 + 上产 + 真机复验 + 归档（21/21 全勾）。
> 状态：**P0 O0 已在生产解除**；`zy_fleet_subs` 从恒 0 落下生产第一行。

---

## 7. 出片与上产实录（2026-11-07，4.3）

| 环节 | 实证 |
|---|---|
| 通道判路 | `fd-build-channel`：公开免费线 tier1（`scs001/platform-image-verify` 探针 success，5 池共 10943 min 有余额）——**无需 cheap-3 旁路**，遵守「禁止节点本地 docker build」 |
| 提交 | `f7d593c5e`（修复）+ `fb7fa7082`（快照闸维护）；只 `git add` 本单 9 文件，并发会话零卷入 |
| 双推 | origin + gitee 同点 `15634c240`（`git ls-remote` 三端全等） |
| 快照闸 | 初跑两道拦（并发会话提交的 `docs/supply-domain-roadmap.md:188` 含 `cheap-3`、`scripts/test-facet-studio.mjs` 的 `sk-live-*` 占位常量）；按既有先例分别走 EXCLUDE_PATHS / `.gitleaks.toml` allowlist，重跑 **1817 文件零禁品 + gitleaks clean** |
| 出片 | 快照 `85e946f` force-push 后**立即恢复** `image-publish.yml`/`image.yml`/`live-supply-owner-acceptance.yml`（技能坑册：force-push 冲掉镜像仓 workflows）→ 恢复提交 `1f9335b` 触发 run 42256943637 **全绿**（build + 五道 smoke：/api/config、/api/ready、dsh contracts、browser lane、module identity） |
| relay | `2026-11-07T01:07:51+08:00 OK yizuo/platform:sha-1f9335b (4s)` |
| ccr 硬门 | `skopeo inspect --creds` 该 tag 解析成功，`Created 2026-11-06 17:00:22 UTC` 与构建吻合，digest `sha256:5c862edc`（**bump 前实证，非凭推断**） |
| GitOps | `4fbf889` 双清单（prod platform.yaml + platform-demo.yaml 对齐同镜像；demo 原落后两版，其间 facet-proxy knob 已在 prod 验证），gitee+github 同推 |
| 滚版 | ArgoCD hard-refresh → 双 rollout 绿 → **双 pod imageID `sha256:5c862edcabe4` 逐字全等**（`platform-589b87dfc7-cbnqj` / `platform-demo-cdd977999-fkj9z`） |
| 镜像内容验单 | pod 内 `registerNotFound` ×4、`deferNotFound: true` :879、`zhiyu.registerNotFound()` :918，装配序 889→918→1126 与本地一致 |

## 8. 真机复验（2026-11-07，4.4/4.5 —— O0 解除判据）

专用房 `zy_1ad879f94b7f3248e3`（owner `aloadtree@gmail.com`，reply_cap=3 / daily_budget_turns=20，复验后已 end；公开演示房 `zy_42ce690574b5423bd2` 未触碰，`day_turns` 保持 8）：

| 判据 | 修复前 | 修复后 |
|---|---|---|
| `GET /api/zhiyu/rooms/:id/fleet-subscriptions` | 404 | **200 `{"subscriptions":[]}`** |
| `POST …/fleet-subscriptions`（自有现役团队） | 404 | **201**（`fs_1793987849221_2qmcz2`「工单分诊集群·试跑」） |
| 回读 | — | 200，1 行 |
| `POST …/fleet-summon`（dryRun） | 404 | **200**，`plan.summonable=[]` + `plan.cockpitOnly=["分诊岗","处置岗"]`（如实分诊，不假装） |
| 非自有团队 | — | 同形 404 `{"error":"not found"}`，不泄漏存在性 |
| 未匹配 `/api/zhiyu/*` | 404 | 仍 404（兜底意图保留，cell 代理未兜住） |

**生产库**：`zy_fleet_subs` 从恒 0 → **1 行**（生产首行，`fleet_id=fleet_1793235503630_7n5a3u`）。

**事件行纪律（4.5）**：等 2 个拉取 tick（默认 60s）后空间流出现两条桥事件行，均带来源标注（fleetId）+ 驾驶舱深链：`bridge=health to=abnormal deepLink=true`（seq 3）、`bridge=report deepLink=true`（seq 4）；5/5 行 `visibility=shared`，零 `private:<id>`。密集合并（`MAX_PER_WINDOW=10`）与熔断丢弃（`DROPS_NOTE_MIN`）由 3.x 装配测试与 `gateway/fleet-room-bridge.js:24/26/244` 在码覆盖；本轮无密集窗口，合并路径未触发——如实记录，非「未观测到」挂账。

**会话纪律**：登录凭据仅用于本次会话，未落盘未入仓；临时会话文件已删（建议轮换该口令）。

## 9. 归档（5.2）

`openspec validate --strict` EXIT=0 → 21/21 全勾 → `archive --yes` → `2026-11-07-fix-zhiyu-fleet-bridge-route-order` → `fleet-room-bridge` spec 新增「团队订阅与召唤端点在平台网关完整装配下可达」（1 added，四场景）→ 全仓 **255/255** 绿。

---

## 1. 装配契约与回归基线

### 1.1 `registerZhiyuRoutes(app, …)` 全仓调用点 —— **10 处**（立案时窄 grep 只看到 5 处，apply 时更正）

| # | 文件:行 | 类型 | 是否依赖内联 404 兜底 |
|---|---|---|---|
| 1 | `gateway/index.js:866` | 生产 | **本次改为 defer** |
| 2 | `scripts/test-zhiyu-im-bridge.mjs:34` | 测试 | 是（默认 false 保持） |
| 3 | `scripts/test-zhiyu-e2e-chain.mjs:34` | 测试 | 是 |
| 4 | `scripts/test-zhiyu-billing.mjs:31` | 测试 | 是 |
| 5 | `scripts/test-zhiyu-room-memory.mjs:57` | 测试 | 是 |
| 6 | `scripts/test-zhiyu-notify.mjs:21` | 测试 | 是 |
| 7 | `scripts/test-zhiyu-duty.mjs:33` | 测试 | 是 |
| 8 | `scripts/test-zhiyu-router.mjs:37` | 测试 | 是 |
| 9 | `scripts/test-zhiyu-rooms.mjs:21` | 测试 | 是（:70/:111/:162 有 404 断言） |
| 10 | `scripts/test-zhiyu-widget.mjs:28` | 测试 | 是（:104/:273 有 404 断言） |

→ 只改生产 #1；9 套测试零改动。这也是 D1 选「可选 `deferNotFound` 默认 false」而非「直接删内联兜底」的硬依据。

### 1.2 装配边界（按 apply 时当前文件重核，行号较立案时有位移）

```
gateway/index.js:866  const zhiyu = registerZhiyuRoutes(app, { …, deferNotFound: true })
gateway/zhiyu/index.js:1241ish  registerZhiyuImBridge(app, …)   ← 在兜底之前，正常
gateway/index.js:889  registerFleetRoomBridge(app, { store: zhiyu.store, … })
gateway/index.js:918  zhiyu.registerNotFound()                 ← 新增，最后一个 zhiyu 注册
gateway/index.js:1126 app.use(async (req,res) => …dispatchToCell)  ← cell 代理全局兜底
```

`awk` 扫描 889~1126 之间**无任何 `/api/zhiyu/*` 路由注册**，确认收尾调用点完备（D4）。

### 1.3 修复前基线

- `node --test scripts/test-fleet-room-bridge.mjs` → **6/6 绿**（桥业务逻辑套件全绿，却测不到装配顺序——正是事故成因）。
- 生产四端点 404 的四路交叉实证（公网 curl / 浏览器同域 fetch / pod 内 :3100 直连 / 本地最小 Express 复现）见 `optimize-zhiyu-behavior-walkthrough/evidence.md` §3.5。
- **判据纪律**：以上「测试绿」不得当作「端点可达」；可达性须由 3.x 的装配顺序测试与出片后真机复验证明。

## 2. 实现（2.x）

| 文件 | 改动 |
|---|---|
| `gateway/zhiyu/index.js` | 函数签名新增 `deferNotFound = false`（带注释说明生产为何要 defer）；把内联 `app.all(/^\/api\/zhiyu(\/.*)?$/, …404)` 抽成 `const registerNotFound = () => {…}`；`if (!deferNotFound) registerNotFound();`；返回对象新增 `registerNotFound` |
| `gateway/index.js` | `registerZhiyuRoutes(app, {…})` 传 `deferNotFound: true`；在 `registerFleetRoomBridge` 块之后、cell 代理之前调用 `zhiyu.registerNotFound()`，带注释钉住顺序约束 |
| `gateway/fleet-room-bridge.js` / `gateway/zhiyu/store.js` / `gateway/zhiyu/im-bridge.js` | **零改动**（`git diff --name-only -- gateway/ scripts/` 仅两个预期文件） |

`registerNotFound()` 函数体只做 404，无鉴权、无代理（D2 已核）。

## 3. 装配顺序集成测试（3.x）

新增 `scripts/test-zhiyu-route-assembly.mjs`，同一 `express()` 按生产顺序装配，临时 SQLite `dataRoot`、固定 `resolveUser`、含一支自有团队的 `sampleFleets` stub、会记命中数的 cell 代理 stub。

```
node --test scripts/test-zhiyu-route-assembly.mjs   → 5/5 PASS

✔ production assembly: four fleet-bridge endpoints are reachable
✔ production assembly: ownership gate still rejects foreign fleets indistinguishably
✔ production assembly: unmatched /api/zhiyu/* still 404s and never reaches the cell proxy
✔ regression gate: moving the 404 guard before the bridge makes endpoints unreachable
✔ default assembly: inline 404 guard is unchanged when deferNotFound is omitted
```

覆盖 3.2（GET/POST/DELETE subscriptions + dryRun summon 均非 404；合法订阅 201、回读 1 行、DELETE 200；非自有团队与陌生人同形 404）、3.3（未匹配路径 404 且 cell 代理命中数 0）、3.4（**负例**：故意把兜底提前，四条端点全部回 404，复现缺陷形状）、3.5（对照组：不传 `deferNotFound` 时内联兜底仍在）。

**过程中抓到并修正一处测试自身缺陷**：初版把 cell 代理 stub 挂在 `registerNotFound()` 之前，未匹配路径先落到 599。这正是 D4「兜底必须在 cell 代理之前」的约束，把 stub 移到收尾之后即 5/5 绿——测试本身因此也验证了这条装配纪律。

### 3.6 全量回归

```
node --test <13 个 zhiyu 套件，含既有 12 + 新增 1>   → 81/81 PASS, 0 fail
```

其中 10 个 `registerZhiyuRoutes` 既有调用方套件全绿，证明默认内联兜底逐字节未变。

## 4. 本地门禁

| 门禁 | 结果 |
|---|---|
| `npm run typecheck`（`tsc --noEmit`） | 绿 |
| `npx biome check gateway/index.js gateway/zhiyu/index.js scripts/test-zhiyu-route-assembly.mjs` | 绿（初版 1 个 `noUnusedFunctionParameters` 警告已修：`req` → `_req`） |
| `npm run lint`（全仓） | **7 errors / 3 warnings**，落点全在 `facet/preview-sandbox.js`、`facet/studio.js`、`facet/web/src/StudioView.tsx`、`scripts/lib/test-fleet-promotion.mjs`、`scripts/studio-store-migrate.mjs`、`scripts/test-facet-studio.mjs` —— 并发会话在途改动，**与本次三个文件无关**；触碰文件单独 biome 0 error |
| `openspec validate fix-zhiyu-fleet-bridge-route-order --strict` | `Change … is valid`，EXIT=0 |

## 5. 未执行（需用户拍板）

- **4.3 出片 / 4.4 真机复验 / 4.5 tick 观察 / 4.6 回填走查单 / 5.1 O0 解除 / 5.2 归档** 全部未做。出片是生产动作，且依赖源提交 + 镜像构建 + GitOps 滚版（GH Actions 计费墙期间需走 cheap-3 旁路）；在本轮「apply」授权范围内只完成了本地代码与测试。
- 因此 `optimize-zhiyu-behavior-walkthrough` 的 O0 **仍为 P0 未解除**，该单 12/23 状态不变；本单任务 4.3–4.6、5.1–5.2 保持未勾，零假绿。

## 6. 结论

本地部分**已完整闭环**：三处代码改动 + 新增防回归闸 + 81 测试绿 + typecheck/biome/validate 绿。修复在**代码层**成立，但生产端点可达性尚未实证——必须出片后按 `optimize-zhiyu-behavior-walkthrough` 2.4/2.6 判据复验才能标 O0 已解除。
