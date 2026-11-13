# Design: add-fleet-cockpit-projection

## 决策（六决策点照 explore 报告办）

| # | 决策 | 落定 |
|---|------|------|
| D1 | 方向 | A1 事件流延伸：新事件品种 `cell_fleets` 沿既有 cell-sampler → fleet-observer 缝，零新凭据、只读、容错。不做 A2 拉取代理（新攻击面）/B 拍板同形生产者（双向写缝，留后续）。 |
| D2 | 投影粒度 | compact 卡：fleet 名/状态/健康 chips/待拍板数+top3 题面(≤80字)/各岗 latest 一行（志题切槽≤4 项、摘要≤120字）+深链 `/fleets/:id`；不全量复刻 cockpit 树。 |
| D3 | 休眠 cell 语义 | 只采样**活 cell**（与 cell_stats 同律：cell 缺席=本 tick 缺席，不重试不重放不唤醒——唤醒是隐性税）。payload 带 sampledAt，console 呈样龄，绝龄（>3×tick）卡转 stale 呈现。 |
| D4 | paas 端点 | 新 `GET /api/fleets/overview`：每 cell 全舰队 compact 有界聚合（无界点止=50 fleets/3 决策/行 120字），owner-scoped（仅本舱主的舰队；admin 在场同律）。sampler 不逐贯 cockpit。 |
| D5 | UI 落点 | OpsView 新「壹座舰队镜像」段（机群总览下，与短期执行同级）；独立 nav view 留 v2。只读+「动作回壹座」深链。observer 缺席 → 段隐去（与 cells 段同降级律）。 |
| D6 | 受众 | v1 = ops 面（ops Bearer token gate，与 board 同构）。agent=cell:<email> 天然已为 deployer 视角留口，届时 façade gate 过滤即可，无 schema 债。 |

## payload schema（v:1，版本化以跨滚动窗口保鲜）

```json
{ "v": 1, "sampledAt": <ms>, "fleets": [
  { "id","name","state",
    "counts": {"onDuty":n,"paused":n,"missing":n,"vacant":n,"passive":n,"failing":n},
    "openDecisions": {"count":n,
      "top": [{"question":"≤80字","severity","expiresAt":"?ms","memberTitle"}]},
    "stream": [{"title","status","reasonSnip":"?≤80字","at","source",
                "metrics":{"k":≤24字}≤4,"summarySnip":"≤120字"}]
  } ] }
```

## 两仓实现要点

**paas**：
- `GET /api/fleets/overview`（routes/fleets.js，owner 全部区间, `requireOwnedFleet` 同企不含在舱主**且非** admin 的他人请停 403——实际是 resolveUser 后按 ownerEmail==user.email 过滤；实测测试身份信道）。
- 聚合复用 `deriveMemberStatus` + db.latestReportFor + open-decision 排序（severity→临期，复用 cockpit 既有排序 helper，不新造排序语义）。
- cell-sampler: `fleet-cells.js` 加第二路 tick（`overview()`fetch，间隔 env `FLEET_CELL_FLEETS_SAMPLE_SECS` 默认 60，与 cell_stats tick 同错处理：log-only）。品种 `cell_fleets`，agent `cell:<email>`。
- **并发保健**：抽样端点本身 O( fleets × members ) 读 SQLite——cell 内 SQLite 存取本就同进程串行；不加缓存 v1。

**萬星**：
- store.js `EVENT_KINDS += "cell_fleets"`（枚举白名单，ingest 对未知 kind 400——品种注册是本 change 的萬星侧第一行）。
- 新读端 `GET /api/fleet/v1/cell-fleets`（requireToken 同 board）：raw kind 窗（默认 6h）→ 每 agent 最新一份快照；`stale = sampledAt < now - 3×tick`。
- OpsView 镜镜像段：fetch 以上端点，与 board 同 <刷新30s>周期纳入现有 useEffect；卡片 data-testid：`fleet-mirror-fleet-<id>`、`fleet-mirror-decision-*`、`fleet-mirror-stale`。

## 风险

1. **隐私粒度**：题面/Fleet 名送 ops 面，与 cell_stats 同级但更深（题面或含业务名）；折叠题面至 80 字、不外传摘要全文；本轮受众=ops 面（D6）已按「运营可视」接受。
2. **滚动窗口 schema 失配**：sampler/observer 独立滚版——payload `v:1`；observer 未升级时 sampler 发来的 payload 被 ingest 400（log-only，连续失败跳一轮，无破坏无害）——因此**部署顺序 = 先 observer（白名单先行）后 platform（sampler 开发送）**。
3. payload 上限：50 fleets/cell 硬框。

## 上产顺序（应对风险 #2 的部署纪律）

**先萬星 observer（先认新 kind）→ 再 platform（sampler 开始发送）→ 最后 facade/web（UI）**。回滚反序；paas sampler 可用 env `FLEET_CELL_FLEETS_ENABLE=0` 即时停发。