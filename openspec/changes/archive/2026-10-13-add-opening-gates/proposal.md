# Proposal: add-opening-gates — 开放前置双件（身份门 + 容量水位线）

## Why

M4⑤「开放前置」余项两件工程件（挂账于伞文档，与「开放动作」绑定叙述）。**关键澄清**：
「开放动作」（对外开门的产品决策）不需要先发生——这两件是**开门前就该建好的门本身**；
建成后默认全部为现行语义（逐字节不变），开门那天只是把开关拧到 open。本 change 把
「待拍板」从工程路径上移除：门造好、默认关、开关和闸值可配。

1. **身份门**：今天「谁能发布/部署」硬编码为 creator 组（`isCreator`）。开门需要的是
   同一处代码在 open 档位下放行任意登录用户（经济闸=部署者自己的计费键仍在，是真正
   的滥用约束）。没有这个开关，开门动作意味着改代码+滚镜像，而不是拧开关。
2. **容量水位线**：部署路由今天不做容量判断——机群余量见底时部署照常落条目，runner
   侧 child 起不来或互相挤（M2 实测：每 active child ≈540-600MB）。开门后部署量不再
   由内部人自觉控制，需要**部署闸**：目标 runner 余量低于水位时拒绝新 child 的部署，
   并用结构化错误指名余量与水位，让部署者知道等什么。

## What Changes

- **`PACK_ACCESS_MODE` 准入档位（packs.js，默认 `closed`）**：`closed`=现行 creator
  门逐字节不变；`open`=任意已认证用户可发布（publish）与部署（deploy）**自己可见的
  pack**。两档共用同一实现点（`isCreator || accessOpen`），拒绝在 closed 档仍是既有
  403 文案（兼容既有测试与 e2e）；open 档不做任何额外放行——私有 pack 可见性、
  订阅者语义、计费键校验全部原样。
- **`FLEET_CAPACITY_WATERLINE_MB` 部署水位（packs.js 部署路由，默认 512）**：**新增
  child** 的部署（该 pack 无在役部署）在最优候选 runner 余量（`budget_mb_limit −
  budget_mb`）低于水位时拒绝，`503 FLEET_AT_CAPACITY`，错误文案带 runner id、余量、
  水位；**纯升级/重部署跳过该闸**（不新增 child，且绝不能因水位把在役服务卡死）；
  多 runner 时按调度器候选序选第一个余量过线者，全都不过线才拒绝；**观测缺口降级开**
  （调度器未武装/board 不可达 → 闸跳过，与 roster 门同纪律——观测缺陷不阻断部署）。
- **facet 面 `whoami` 暴露 `accessMode`**：壳与运维面可观测当前档位（closed/open），
  运维动作（拧开关）有据可查；不改变任何视图行为（`#/mine` 门仍按登录态）。
- **不动面**：sub2api 计费键校验、模型双门、部署锁、billing 门、unpublish 语义、
  `PACK_CREATOR_GROUPS` 配置全部原样。壹座侧（server.js 注册点）同享默认 closed。

## Impact

- 受影响 spec：pack-marketplace（MODIFIED「Publishing is identity-gated」——加档位与
  默认档场景）；a2a-agent-serving（ADDED「Deploy is capacity-gated」+ ADDED「Access
  mode switches the deploy identity gate」）。
- 受影响代码：`gateway/packs.js`（两处门+whoami 经 facet/index.js 暴露）、
  `facet/index.js`（whoami 加字段）；测试：新套件 `test-opening-gates.mjs` + 既有
  套件回归（publish/deploy 的 closed 档文案零漂移）。
- 风险：open 档的滥用面（任意登录用户发布垃圾 pack）由既有发布限流（per-author
  10/h）+计费键经济闸+策展可见性承担；水位线可能误拒（阈值可配，默认 512MB≈一个
  重 child，远低于 pod 总预算 3328）。
