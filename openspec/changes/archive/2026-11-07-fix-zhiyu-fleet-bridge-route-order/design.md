# Design: fix-zhiyu-fleet-bridge-route-order

## Context

生产装配序列（`gateway/index.js`）：

```
859  const zhiyu = registerZhiyuRoutes(app, { dataRoot, ... })
       └─ gateway/zhiyu/index.js 内 30+ 条 /api/zhiyu/* 路由
       └─ :1230  registerZhiyuImBridge(app, …)        （IM 桥，在兜底之前，正常）
       └─ :1236  app.all(/^\/api\/zhiyu(\/.*)?$/, …404)  ← 问题所在
878  registerFleetRoomBridge(app, { store: zhiyu.store, … })
       └─ gateway/fleet-room-bridge.js:111/119/142/156 四条端点
1109 app.use(async (req,res) => { … dispatchToCell(...) })  ← cell 代理兜底
```

`:1233-1235` 的注释写明兜底的原意：「The prefix is owned: unmatched /api/zhiyu/* paths must 404 here (JSON), never proxy into a cell where a same-named route could answer with a different meaning.」这个意图**必须保留**——否则未匹配路径会落到 cell 代理。问题只是它注册得太早，把之后才挂载的桥也挡了。

**不能简单把 `registerFleetRoomBridge` 提到 `registerZhiyuRoutes` 之前**：桥需要 `store: zhiyu.store`，而该 store 是 `registerZhiyuRoutes` 内部 `createZhiyuStore({ file: path.join(dataRoot, "zhiyu.db") })`（`gateway/zhiyu/index.js:46`）创建并随返回值交出的。提前注册就拿不到 store。

**878 之后 `gateway/index.js` 不再注册任何 `/api/zhiyu/*` 路由**（已逐行核对；1130/1144 的 widget 消息路由属于 `gateway/zhiyu/index.js` 内部，在兜底之前）。因此把兜底挪到 `registerFleetRoomBridge` 之后是完备的。

`scripts/test-fleet-room-bridge.mjs` 把桥挂在独立 `express()` 上（:44-46），只测业务逻辑（订阅 CRUD / 拉取 tick / 频控 / 召唤），从不模拟生产装配，所以全绿也发现不了此缺陷——与 `docs/registry-maintenance.md` §15.84「测试绕过 registerAuth 中间件」同类。

## Goals / Non-Goals

**Goals:**

- 四条桥端点在生产装配下可达，进入既有所有权/成员闸逻辑。
- 未匹配的 `/api/zhiyu/*` 仍 404 且不误入 cell 代理（原兜底意图零改动）。
- 用一条按生产顺序装配的集成测试把「注册顺序」钉成契约，防止回归。
- 改动面最小：不动任何业务语义、不动 store/DB、不动 `fleet-room-bridge.js` 内部逻辑。

**Non-Goals:**

- 不重写 `fleet-room-bridge.js` 的业务逻辑；不新增能力 spec。
- 不修 `optimize-zhiyu-behavior-walkthrough` 里登记的其它观察项（CSP `http://` 源、官网席位文案、Purpose 残留等），各归各单。
- 不回填生产 `zy_fleet_subs` 的 0 行（那是真实状态，不是丢数据）。
- 不在本单跑真机走查（由 `optimize-zhiyu-behavior-walkthrough` 在出片后接手）。

## Decisions

### D1 · 抽出兜底为可延迟的显式收尾函数，默认行为保持不变

`registerZhiyuRoutes(app, opts)` 新增可选参数 `deferNotFound`（默认 `false`）：

- **默认 false**：函数末尾照旧内联注册 `app.all(/^\/api\/zhiyu(\/.*)?$/ …)`，行为与今天逐字节一致。9 个现有测试调用方（`scripts/test-zhiyu-{im-bridge,e2e-chain,billing,room-memory,notify,duty,router,rooms,widget}.mjs`）**零改动**继续依赖这个兜底。
- **生产 `gateway/index.js:866` 传 `deferNotFound: true`**：内联兜底跳过，改由返回对象上的 `zhiyu.registerNotFound()` 在 `registerFleetRoomBridge(...)` 之后（:878）显式调用。

全仓 `registerZhiyuRoutes(app, …)` 共 **10 个调用点**（1 生产 `gateway/index.js:866` + 9 套测试：`test-zhiyu-{im-bridge,e2e-chain,billing,room-memory,notify,duty,router,rooms,widget}.mjs`），apply 阶段用全仓 grep 复核（立案时的窄 grep 只看到 5 处，已更正）。**只改生产那一个**；9 套测试全部继续依赖默认内联兜底。

- 备选 A：把 `registerFleetRoomBridge` 提到 `registerZhiyuRoutes` 之前 → **拒绝**，桥依赖前者创建的 `zhiyu.store`，顺序倒置拿不到 store。
- 备选 B：把兜底从正则 `app.all` 改为「只在所有已知 zhiyu 路由都不匹配时才 404」的动态判断 → 拒绝，等于重写路由语义、易漏，且偏离原注释意图。
- 备选 C：给桥单独挂一个 `Router` 并 `app.use` 到 `/api/zhiyu` 之前 → 拒绝，仍需处理 store 依赖，且引入新的前缀层，改动面更大。
- [备选 D 回归面比立案时估计的更大] 直接删掉内联兜底、要求所有调用方都显式调用收尾 → **拒绝**，会让 **9 套**测试（不是 4 套）的未匹配路径请求穿透到它们的 `app` 默认 404（HTML）或其它兜底，改变断言形状（`test-zhiyu-rooms.mjs:70/111/162`、`test-zhiyu-widget.mjs:104/273` 等已有 404 断言），属无谓的回归面。

选可延迟参数的理由：兜底意图完全保留、注册顺序在生产侧变得显式可读、store 依赖不变、既有 4 套测试零改动、改动仅三处（参数分支、导出收尾、生产调用）。

### D2 · 收尾函数只做 404，不做任何鉴权或代理

`registerNotFound()` 内只保留原 `app.all(/^\/api\/zhiyu(\/.*)?$/, (_req,res) => res.status(404).json({error:"not found"}))`。理由：它本来的职责就是「前缀归属收口」，任何新增逻辑都会让「最后一道闸」变成业务面。

### D3 · 新增独立装配顺序测试，不改既有单测

新增 `scripts/test-zhiyu-route-assembly.mjs`：同一 `express()` 上以 `deferNotFound: true` 调 `registerZhiyuRoutes`（临时 `dataRoot` 与最小 stub 依赖）→ `registerFleetRoomBridge` → `zhiyu.registerNotFound()`，断言四条桥端点非 404、未匹配路径 404；并加一条**负例**断言：故意把 `registerNotFound()` 提前到桥之前注册时，桥端点变 404（证明测试真的能捕获装配顺序回归）。同时保留一条 `deferNotFound` 缺省（false）的对照，确认现有 4 套测试依赖的内联兜底行为未变。

- 备选：改 `scripts/test-fleet-room-bridge.mjs` 让它按生产顺序装配 → 拒绝，该套件的价值是隔离测桥的业务逻辑（可控 sample、tick、频控），混入网关装配会让测试变脆、且需要大量 stub（`callAgent`/`resolveUser`/`registry`…）。
- 备选：只靠出片后真机 curl 手工验 → 拒绝，没有 CI 闸，同类回归会再次发生（这正是本次事故的成因）。

### D4 · 兜底调用点必须在 cell 代理 `app.use` 之前

`gateway/index.js:1109` 的 `app.use(async (req,res) => { … dispatchToCell(...) })` 是全局兜底。D1 的收尾必须落在 878 之后、1109 之前；否则未匹配 `/api/zhiyu/*` 会先被 cell 代理吞掉，原注释意图失效。tasks 中对此加一条显式断言。

## Risks / Trade-offs

- [`registerZhiyuRoutes` 的其它调用方可能依赖内联兜底] → 全仓 grep 共 10 处（1 生产 `gateway/index.js:866` + 9 测试：im-bridge / e2e-chain / billing / room-memory / notify / duty / router / rooms / widget）。D1 用 `deferNotFound` 默认 false 保持它们零改动；tasks 3.6 逐套跑一遍确认（六套件 + 补跑 notify/duty/router/rooms/widget）。
- [新增集成测试需要 stub 网关依赖] → 用最小 stub（`resolveUser` 返回固定 owner、`sampleFleets` 返回含一支自有团队的 overview、`store` 走临时 SQLite），只断言路由可达性，不触碰回合/计费。
- [修复后订阅桥开始真正写入] → 属预期行为恢复；`zy_fleet_subs` 从 0 起增长、拉取 tick 开始产生事件行，是功能上线而非数据异常。需在出片后观察一轮，确认频控与熔断纪律（既有 spec 需求）在生产成立。
- [出片线受 GH Actions 计费墙影响] → 沿用仓内既有旁路（cheap-3 本地构建）配方，见 `docs/registry-maintenance.md` §9.2；不在本单处理账单问题。

## Migration Plan

无 schema 迁移、无数据回填。部署序：

```
本地：三处代码改动 + 新测试 → node --test 两套件绿 → typecheck/lint
出片：源提交 → 镜像 → GitOps tag bump → ArgoCD 滚 platform
验收：真机 GET/POST 四条桥端点非 404 → 交回 optimize-zhiyu-behavior-walkthrough 跑 2.4/2.6
回滚：revert 三处代码改动并回滚镜像 tag；已写入的订阅行可用既有 DELETE 端点解除，不需要数据回滚
```

## Open Questions

（无。修法、调用点、测试形态均已由代码实证确定。）
