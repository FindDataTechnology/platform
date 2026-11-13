## Why

官方与社区智能体今天只能「订阅=装快照」或「从空白起」，不能「看懂后克隆成自己的可编辑草稿」——学习与二创缺入口。同时克隆若无血缘记录，会出现「冒充原创」与「改版漂移不可考」两个真问题：fork 必须带 `forkOf` 血缘，且官方身份绝不能因 fork 而获得。

## What Changes

- **「克隆到我的工作室」动作**：在规格书/市场详情/官方 gallery 提供 fork 入口——以调用者可读的 manifest 为种子，生成 Agent Studio 工作文档（emit 目标走既有发射口，不直接发布）。
- **血缘盖章 `provenance.forkOf`**：fork 产物可选携带 `{ packId, version }` 血缘块；`kind` 仍限于既有三态（fork 一律落 `community` 语义，官方性只由 roster 判定，fork 永不进官方）；校验器白名单扩一键，发布门/版本不可变零改。
- **血缘可见且随版本保留**：呈现 fork 产物的面显示「forked from X vN」；血缘随重发布版本保留。
- **跨域深链**：谦面 facet 的 fork 入口是深链——登录（Logto SSO）后跳壹座 Studio 打开 fork 草稿；**写动作只发生在壹座 cell**，facet 无写面。
- **权限沿读可见性**：能读到完整 manifest（公开包匿名可读、私有包按既有读门）才可克隆；fork 不绕任何读门。
- **明确 Non-goals**：不迁移上游 license 语义之外的权利判断（fork 保留上游 license 字段）；不做 fork 网络/图谱页；不改三态 provenance 语义。
- **非 BREAKING**：`forkOf` 为可选键，无血缘的 pack 零影响。

## Capabilities

### New Capabilities
- `agent-fork-lineage`: 克隆动作的行为契约——种子来自可读 manifest、落为可编辑工作文档、血缘盖章与保留、跨域深链写面边界、fork 不获官方身份。

### Modified Capabilities
<!-- 无：provenance 白名单扩 forkOf 是本新能力的契约（既有三态语义零改，
     official-adoption / pack-marketplace 的需求文本不需要变）。 -->

## Impact

- **`lib/pack-manifest.js`**：`validateProvenance` 键白名单 + `forkOf`（可选，形状校验）；单一校验器扩展，发布门/安装门自动同享。
- **Web**：规格书/详情/官方 gallery 的 fork 入口；Studio 接收种子文档；facet 深链。
- **协调**：血缘显示落在 `add-agent-spec-sheet` 的共享组件（该 change 在途，归档序协调）；Studio 工作文档来自 `add-agent-studio`。
