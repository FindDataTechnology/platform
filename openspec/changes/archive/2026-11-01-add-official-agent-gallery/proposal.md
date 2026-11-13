## Why

官方资产今天在市场里只是一个筛选维度（official chip + 徽章，`official-pack-showcase` 已上产匿名读与三段聚合），但新人无法「一屏看懂平台有哪些官方智能体、各自由哪三桶构成、怎么克隆」。规格书（`add-agent-spec-sheet`）与克隆（`add-agent-fork-lineage`）落地后，官方集合需要一个把它们用起来的呈现面——这就是「官方 agent 展示优化」的最后一块。

## What Changes

- **官方集合升级为 gallery**：`/api/packs/official` 三段聚合数据不变，呈现面从「筛选+徽章」升级为规格书卡墙——每个官方条目渲染完整三桶规格书（含徽章、provenance、引导）。
- **官方条目可克隆**：gallery 卡面带 fork 入口（消费 `agent-fork-lineage` 契约）；匿名访客沿登录墙语义（fork 走登录引导，不泄露更多 manifest 结构）。
- **starter 序列在 gallery 可见**：五支官方 starter 团队的序列标记与说明卡同源呈现（`official-starter-teams` 数据，零第二真源）。
- **官方资产由 Studio 产出（dogfood）**：官方资产改用 Agent Studio 编排产出（manifest 仍是唯一真源、种子测试照旧钉住）——这是流程约定，不引入新代码路径。
- **明确 Non-goals**：不改官方判定源（部署侧名单）；不改三段聚合端点契约；不做评分/排行/推荐算法；匿名面不下发 manifest 敏感结构（沿 `pack-visibility`「探测教不出东西」纪律）。
- **非 BREAKING**：匿名可读、登录墙、官方判定语义全部照旧。

## Capabilities

### New Capabilities
<!-- 无 -->

### Modified Capabilities
- `official-pack-showcase`: 新增需求——官方集合以规格书呈现、官方条目带克隆入口、starter 序列标记可见（既有判定源/匿名读/三段聚合需求零改）。

## Impact

- **Web**：官方集合呈现面重构（消费 `agent-spec-sheet` 共享组件 + fork 入口）。
- **Server**：零改（`/api/packs/official` 契约不变；fork 走 `agent-fork-lineage` 既有面）。
- **依赖**：`add-agent-spec-sheet`、`add-agent-fork-lineage`、`move-pack-guides-to-manifest`（引导来自数据）先行或同批。
