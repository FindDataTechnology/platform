# Design: fix-zhiyu-summon-serving-face

## D1 · 缺陷根因与「为什么不改 spec 语义」

`gateway/fleet-room-bridge.js:171`：`serving = (await sampleFleets(user.email, "/api/fleets/overview"))?.servingMembers?.(fleetId) ?? []`。`sampleFleets`（`gateway/index.js:893`）返回 `res.json()`——纯 JSON，不存在可调用的 `servingMembers`；全仓该标识符零生产者（唯一引用即此行）。测试（`test-fleet-room-bridge.mjs:160`）stub 对第二路径参数返回 null、断言「summonable=[] 诚实降级」——正路径从未被覆盖。这与 O0（路由序）同款：**单测全绿、生产永不达**。

spec 语义本身是对的（如实呈现可召唤/仅驾驶舱），坏的是取数实现——所以本案是纯修复，不改需求的「如实」骨架，只把「可召唤面」的判定语义写实（delta 中补充判定句与三个新场景）。

## D2 · 数据流与对齐键（servingPath 全等，不做 targetId 反解）

```
cell /api/fleets/overview
  formation.members[]: { id, title, targetKind, status }        ← 现状
                      + { targetId, servingPath }               ← 本案新增（a2a 岗）
                              │
gateway registerFleetRoomBridge
  summon plan:
    candidates = members.filter(targetKind==="a2a" && servingPath)
    rows       = await servingDeployments()                     ← 新缝（packs internal deployments）
    summonable = candidates.flatMap(m =>
      rows.filter(r => r.agentPath === m.servingPath)
          .map(r => ({ ref: `${r.packId}:${r.agentId}`, title: m.title, onBehalfOf: r.deployedBy }))
    )
    cockpitOnly = fleet.stream.map(s => s.title)                ← 不变（persona 等全体）
```

**为什么用 servingPath 全等而非 targetId 字符串反解**：targetId 形态随目录源漂移（生产实况同时存在 `registry-packs-<packId>-<agentId>` 与 `packs-<packId>-<agentId>`，`pathToName` 是有损清洗）——反解是在对显示名做字符串考古。而 registry agent path（`/packs/<packId>/<agentId><suffix>`，`lib/agent-serving.js:678`）与 `pack_deployments.agentPath` 是同一字符串的两次落库（部署时 mint、registry 注册），全等连接键稳定且与席位解析（agent-lane 的 deployments 匹配）同源。

**cell 侧怎么得 servingPath**：overview 已做 `memberView` 解析（`resolveTarget` 拿到 entry）。a2a entry 的 url 形态 = `${REGISTRY_URL}/agent<path>/`（`registry-bridge.js:421`），cell 解析自己目录条目的 url 取 `<path>` 即 servingPath；url 不是该形态（agents.json 外部 a2a 服务）→ null → 如实排除。cell 不需要访问 pack_deployments（那是 gateway 的库）。

## D3 · 装配缝：`servingDeployments` 窄缝

桥不做 HTTP。`gateway/index.js` 在注册桥时传：

```js
servingDeployments: async () => {
  // 同 zhiyu agent-lane 的 deployments 取数：packsInternalBase + packsInternalToken，
  // 短超时、失败返 null（调用方降级）——不在桥内复制凭据逻辑。
}
```

桥侧 `rows == null` → summonable=[]（诚实降级，dryRun 仍 200）。测试以 seam stub 注入正/负两态。

## D4 · 执行段零改动

`plan.summonable` 之后的 invite 循环、`onBehalfOf`、订阅随行、部分失败逐成员——语义全部保留（既有握手与策略应答，spec「部分失败不掩盖」已有场景）。本案只换「summonable 从哪来」。

**实施偏离（2026-11-07 apply 实录）**：执行段并非「零改动」可达——正路径测试当场抓出执行段**从未可能跑通**的两处死点：
1. `inviteCreate` 缺 `idemKey`（`zy_room_invites.idem_key NOT NULL UNIQUE`，缺省必撞 NOT NULL）——补 kernel 路由同款约定 `${roomId}:agent:${ref}` + 撞键时戳 bump；
2. `onBehalfOf` 写死召唤者——席位 lane 按 `deployedBy === onBehalfOf` 匹配部署行（agent-lane），非部署者召唤的席位永远开不了口——改带台账部署者（自部署=召唤者本人，常态不变）；
3. 顺手加在座守卫（kernel 409 同语义 `already a member`），防重复召唤堆垃圾 invite 行。

三处均为执行段「首次可达」的必要最小修复，spec 语义零变化；O8 之下的这个次生缺陷已记入台账（执行段死点被 serving 恒空完全遮蔽）。

## D5 · 兼容与安全面

- formation.members 新增字段只增不改；现役消费者（编队画布 TeamsOverviewBoard/FleetCanvas）不读未知字段。overview 本就是 cell owner/admin-only，targetId/servingPath 与成员页已展示的 target.id 同级，无新泄漏面。
- 所有权闸不变：serving 候选仍只从 `resolveUser` 自己的 overview 取（桥先按 user.email 拉自己 cell），他人团队的部署行不会进入计划。
- `pack_deployments` 只读。

## D6 · 测试策略

1. `test-fleet-room-bridge.mjs` summon 用例改双态：
   - 正路径：overview stub 带一支含 a2a 岗（servingPath=`/packs/p1/a1`）的队 + `servingDeployments` stub 返回该行 → dryRun plan.summonable=`[{ref:"p1:a1",…}]`，cockpitOnly 仍含 persona 岗；执行（非 dryRun）走 store.inviteCreate 断言 invite ref/onBehalfOf。
   - 排除态：servingPath 无对齐行 / servingPath=null → 不入 summonable。
   - 降级态（保留现断言）：servingDeployments 返 null → summonable=[]。
2. `test-zhiyu-route-assembly.mjs`：装配级正路径一条（生产序装配 + 双 stub → dryRun 200 且 summonable 非空）。
3. cell 侧：`server/routes/fleets.js` 的 overview 若有既有测试文件则补 formation.members 字段断言；无则以 e2e 冒烟覆盖（5.x 真机 dryRun 对含 a2a 岗的队）。

## Risks

- **servingPath 解析的 url 形态依赖**：若某源给 a2a entry 的 url 不是 `${REGISTRY_URL}/agent<path>/`，会被如实排除——这正是语义（只有 pack 部署可被房间席位召唤）。风险是漏召，不是假召；e2e 真机对现役 a2a 岗验证兜住。
- **多部署者同 pack/agent**：同一 servingPath 唯一（pathSuffix 含部署者段），天然一对一行，无歧义。
