# retire-search-relay-direct — 任务清单

> 承接 search-relay-via-ciyuan 3.3（观察起点 2026-10-15）。到期判据双门缺一不退：
> ①车道稳定（reachable=true、breakerOpen 长期 false、无回退事故）；②`upstream.fallbacks`
> 长期为 0（或仅演练产生）。**复检时点：2026-10-22 前后。**

- [x] 1.1 复检判据：stats 面板 + relay 日志（reachable/breakerOpen/fallbacks）+ 中途
       是否已有 platform 出片（2.1 面板行在产则跳过该项）
       实证（2026-10-21，cheap/fd-prod `search-relay-8ccf955c7-cnfbt`，port-forward 4597 直打 `/v1/stats`）：
       **双门全过，可退役。** ①`mode=ciyuan reachable=true breakerOpen=false`；pod 自 10-15 07:32 启动
       `upstream=ciyuan-lane, 1 standby serpapi key(s)` 起连续运行 6.69 天 **0 重启**（内存计数器覆盖整个观察窗）。
       ②`fallbacks=4 / laneFailures=3`——日志时间戳证明 4 笔 `route=direct-fallback` **全部落在 10-15 07:35:41–51**
       （即 3.2 验收演练：account 37 置不可调度→3 连败→breaker OPEN 60s→冷备接管 4 笔），**此后 6.7 天零回退、零新增
       车道失败**；窗口内路由分布 12 lane / 4 direct-fallback（后者全演练），`errors.upstream=0 poolDry=0`。
       ③面板行已在产：生产 facet（platform:sha-02082df）前端产物含 `upstreamFallbacks`/`upstreamLaneDown` 键与
       「冷备接管 {{count}} 次」文案——该项跳过。坑：本机 18099 被他会话 Python 占着（IPv4），kubectl 绑 IPv6 同口导致
       curl 打错进程「Empty reply」，换口即可。
- [x] 2.1 代码删除：直连路径 + serpapi 池与 breaker 直连分支（services/search-relay/）
       实证：`index.js` 删 `serpapiSearch/poolSearch/directSearchWithOverride`、per-key 与 override 冷却、`stats.keyFailures/poolDry/lane.fallbacks`、
       `SERPAPI_KEYS/GLM_KEYS` 读取、`createHash` 依赖（-170 行）；`loadKeys` 对残留 `serpapi/glm` 键**忽略**；启动守卫改「无车道即拒启」；
       启动/重载日志去 standby 行；breaker 降级为**纯可达性信号**（不再旁路路由，每请求即探活）；车道故障→503
       `search upstream unavailable (websearch lane): <车道原文>`；热重载丢车道走既有「keeping last-known」路径；BYOK 继续骑车道、
       三态由车道裁决（契约不变）。`keys.example.json` 收敛为 `{ciyuan, tokens}`。
- [x] 2.2 面板 keys 段隐藏（WebSearchSection.tsx）；embed 脚本 keys 形状收敛
       实证：组件已迁为 `SearchServiceCard.tsx`——删 `websearch-pool-keys`（per-key 冷却视图）与 `websearch-pool-dry` 行、上游行去
       fallbacks 计数改显 `laneFailures`（`upstreamLaneErrors`，补齐 spec「车道侧错误计数」）、`upstreamLaneDown` 文案不再说冷备接管；
       `websearch-api.ts` 类型去 `keys/fallbacks/poolDry`、mode 收窄 `"ciyuan"`；`server/routes/misc.js` pool 代理去 `keys` 投影；
       五语言包各 -4 键（poolKeys/poolDry/upstreamDirect/upstreamFallbacks）+1 键；**顺带修 `services/ops-console/index.js`**（读
       `poolDry`/`keys[].failures` 的两行改为 lane up/down + laneFailures）。embed 脚本本身不含 keys 逻辑（只嵌 index.js/scoped-token.js），
       keys 形状收敛落在 keys.example.json（本项）与生产 secret（2.3）。tsc/biome 全绿。
- [x] 2.3 单测收敛 + 出片滚产（fd-build-channel 判路 → 快照池）+ configmap/secret 重嵌
       （keys.json 只留车道凭据）
       实证：单测 lane 6/6（重写：可达性信号不旁路、残留 `serpapi[]` 惰性、丢车道重载 keep-last-known）+ byok 11/11（relay 段改车道桩，
       三态由桩按 `x-serpapi-key` 裁决）+ scoped 10/10（+无车道拒启守卫）；tsc/biome 绿。**出片**：`fd-build-channel` 判公开仓免费线 →
       快照 `768cb21` 强推 scs001/platform-image-verify 冲掉 `image-publish.yml`（已知坑，文件实名 image-publish.yml 非 image.yml）→ 从
       `ed371ff` 取回恢复提交 `384a979` 跑 image 成功 → relay `sha-384a979 OK` → skopeo 硬门 digest `a7e380a6` → fd-infra-deploy
       `0188252` 三清单（platform/platform-demo/facet）滚 → ArgoCD Synced → 三 pod imageID 均 `a7e380a6`。**relay**：修 embed 脚本
       `?? … ||` 语法错（1871fbd3 引入，之后没人跑过）→ 重嵌 fd-infra-deploy `96819e3`（python yaml 校验 + index.js/scoped-token.js
       与源**逐字节一致**）→ gitee push → ArgoCD hard refresh Synced → subPath ConfigMap 不触发滚动，显式 `rollout restart` →
       新 pod `5bb6444b74-k5bwh` 内 `/app/index.js` md5 = 本地。**secret** `search-relay-keys`：去 `serpapi/glm`，tokens/scoped_master
       原样（备份 `~/.secrets/…bak-2026-10-22` 0600，不入仓）。快照超集核验：`7cd3a444`（上版 ed371ff 源）是 589930aa 祖先，中间仅 docs。
- [x] 2.4 台账 + 主 spec 同步（web-search 退役段并入）
       实证：`DEPLOY.md`「Web search relay」节供给拓扑/期望/stats 三段改车道单上游；台账 `docs/sub2api-fork-patches/README.md` §六
       新增「直连退役（2026-10-22）」条目（判据/代码/生产/验收/回滚/词元侧零动作）；主 spec `openspec/specs/web-search/spec.md` 两条
       MODIFIED 需求整块合入（「本 change」指代改点名 change），`openspec validate web-search` 有效。
- [x] 3.1 生产验收：启动日志无 standby 行；普通搜索 200（route=lane）；BYOK 三态不变；
       车道故障路径返回明确错误
       实证（2026-10-22 00:48–00:54，cheap/fd-prod 新 pod，port-forward 28317:4597）：①启动行 `upstream=ciyuan-lane, 1 static
       token(s), scoped=on, 0 revoked scope(s), cap 300/day`——**无 standby**；②真搜 200 `x-search-source: pool`、日志 `route=lane`、
       stats `upstream{mode:ciyuan,reachable:true,breakerOpen:false}` 且**无 keys/fallbacks/poolDry**；③BYOK 三态：无 key→pool、
       坏 key→`pool-after-user-failure`（200）、好 key（退役的 standby key 充当用户 key）→`user`（200），key 值在 pod 日志 0 次；
       ④演练：secret 临时换无效 `ciyuan.key`→t+85s 首个 503 `search upstream unavailable (websearch lane): lane HTTP 401`
       →立即回填→t+178s 回 200、`reachable=true`（窗口 93s，17 笔 laneFailures 全系演练探针；kubelet 目录挂载同步各 ~1 分钟）。
       facet 产物：`upstreamLaneErrors` 在、`upstreamFallbacks/poolKeys/poolDry/upstreamDirect` 0 文件。
