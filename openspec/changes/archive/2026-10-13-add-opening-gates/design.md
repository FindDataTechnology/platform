# Design: add-opening-gates

## Context

- 身份门现状：`gateway/packs.js` 的 publish（`:764`）与 deploy（`:963`）都是
  `isCreator(user)`；pause/resume（`:1814`）是 `isAuthor || isCreator`。facet 面
  `whoami`（`facet/index.js:95`）已回 creator/admin 布尔。
- 容量现状：部署路由已取 board 做选址（`scheduler.boardNow()` +
  `pickPlacement`），board runner 行带 `budget_mb/budget_mb_limit`（fleet.js:194-195
  心跳载荷）。水位线所需数据全在，缺的只是判定。
- 在役判定：`registry.deployments(packId)`（pack_deployments 表）即「该 pack 是否
  已有在役 child」的权威读数；部署处理器本就在用（升级路径）。

## Solution

### 身份门（一处判定，两档）

```js
// closed 默认；open 时 creator 组不再是门槛
const accessOpen = () => String(process.env.PACK_ACCESS_MODE || "").toLowerCase() === "open";
const mayPublish = (user) => isCreator(user) || accessOpen();
const mayDeploy = (user, id) => registry.authorEmail(id) === user.email || mayPublish(user);
```

- publish 路由：`if (!mayPublish(user)) return res.status(403).json({ error: "Creator group required" })`（closed 文案不变）。
- deploy 路由：`if (!isAuthor && !mayDeploy(user, id)) return 403 "Pack author or creator group required"`（同文案）。
- pause/resume：保持 `isAuthor || isCreator`——open 档的 pause 仍要求作者或 creator
  （pause 是生命周期动作，不是新入口；外来部署者在 open 档经 isAuthor 自然成立——
  见下方「外来部署者」）。
- **外来部署者**（open 档的关键路径）：facet 的 selfservice 对 foreignGreenfield
  注入 creators 组（`selfservice.js:186`）——open 档下这条注入**保留**（无害：
  它只是过同一门），但**语义修正**留到真实需要时再动；本片不碰 facade。

### 容量水位线（部署路由，选址之后、写盘之前）

```js
// 新增 child 才闸：在役 pack 的升级/重部署跳过
const waterlineMb = Number(process.env.FLEET_CAPACITY_WATERLINE_MB) || 512;
const inService = registry.deployments(id).length > 0;
if (!inService && scheduler && waterlineMb > 0) {
  try {
    const board = await scheduler.boardNow();
    const cands = /* 与选址同序：runnerPlacement 优先，然后 pickPlacement 序 */;
    const ok = cands.find((r) => headroom(r) >= waterlineMb);
    if (!ok) return res.status(503).json({ error: `fleet at capacity — best runner '${best?.id}' headroom ${bestHeadroom}MB below waterline ${waterlineMb}MB`, code: "FLEET_AT_CAPACITY" });
  } catch { /* board unreachable → degrade open */ }
}
```

判定点放选址之后（runnerPlacement 已知，闸能指名目标 runner）。多 runner 时先看
runnerPlacement 选中的，再看其余健康 runner——**任一过线即放行**（闸是全局水位，
不是单机水位）；全不过线才拒。

### facet whoami

`facet/index.js` whoami 响应加 `accessMode: String(process.env.PACK_ACCESS_MODE ||
"closed").toLowerCase() === "open" ? "open" : "closed"`。

## Risks / Trade-offs

- 水位默认 512MB：runner-serving 预算 3328，单个重 child ≈540-600MB——512 意为
  「余量连一个重 child 都放不下就拒绝」。可配；ops 可调。
- open 档发布垃圾：限流（10/h/author）+策展可见性（featured/category 由管理员
  授予）+经济闸承担；本片不新增滥用面（closed 默认零变化）。
- 升级豁免的边界：`registry.deployments(id).length > 0` 是「此 pack 有在役 child」
  的读数；外来绿地在 facet 侧已被 IN_SERVICE 拒（`selfservice.js:156`），到不了这里。

## Migration Plan

镜像三滚（platform/facet 面单滚+runner 不动）；开关默认关，零行为变化；开门=改
ConfigMap 环境变量（`PACK_ACCESS_MODE=open` / 水位值），rollout restart 即生效。
回滚=恢复环境变量。
