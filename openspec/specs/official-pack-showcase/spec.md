# official-pack-showcase Specification

## Purpose
官方资产集合的判定、读面与未登录呈现：把官方团队模板、官方助手与官方精选从整架市场里聚合出来，
打「官方」徽章，**未登录即可浏览**——让受众在登录墙前就能看懂平台有什么、团队能干什么。
只读、零新存储、零可见性语义变更。

## Requirements

### Requirement: 官方判定源是部署侧名单而非作者自报

壹座 SHALL 以部署侧官方作者名单（运营配置，env 注入，默认含平台官方作者账号）判定一个 pack
是否为官方资产；判定 SHALL 只读 packs.db 既有行的作者字段，MUST NOT 引入作者可自报的
manifest 字段（自报官方=伪官方，MUST NOT 存在）。名单为空或未配置时官方集合 SHALL 为空集
且读面如实返回空列表（不是错误）。

#### Scenario: 名单内作者进官方集合

- **WHEN** 名单含 `official@finddatatech.cloud` 且该作者有一个 public 团队模板 pack
- **THEN** `GET /api/packs/official` 的模板段含该 pack

#### Scenario: 名单外作者不可自报官方

- **WHEN** 任一作者在其 manifest 里写任何「官方」类字段或名字含「官方」
- **THEN** 该 pack 不进官方集合；manifest 校验对「官方」类自报字段无任何认可语义

#### Scenario: 名单未配置返回空集

- **WHEN** 部署未配置官方名单
- **THEN** 官方集合端点返回 200 与空的三段列表，页面呈现「暂无官方资产」而非报错

### Requirement: 官方集合读面匿名可读且三段聚合

`GET /api/packs/official` SHALL 匿名可读，返回三段：`templates`（官方团队模板 packs，即携带
fleet 段的 pack）、`assistants`（官方助手 packs）、`featured`（curation featured 的官方 pack，
名单内作者优先、名单外精选按既有 featured 语义附注呈现）。每条 SHALL 只携带公开面字段
（名称、描述、标签、徽章、最新版本号、agentCount），MUST NOT 携带安装态、订阅态或任何
所有者视角字段。private/unlisted pack SHALL NOT 出现在任何段。

#### Scenario: 匿名读官方集合

- **WHEN** 未登录访客请求 `GET /api/packs/official`
- **THEN** 返回 200 与三段聚合，每段只含 public 且名单内（featured 段除外）的 pack 公开字段

#### Scenario: 私有包不进集合

- **WHEN** 名单内作者有一个 private pack
- **THEN** 该 pack 不出现在官方集合任何段，匿名探测与登录访客一致地不可见

### Requirement: 壹座市场匿名读与登录墙前呈现

壹座 gateway 的市场挂载 SHALL 支持部署侧开关的匿名读（默认关；开启后与谦面挂载同语义：
public 可浏览/查详情/读版本史/下载技能正文，private/unlisted 404，全部写路由 401）。
壹座 pre-login 壳 SHALL 呈现官方资产段（官方团队模板 + 官方精选卡片），未登录点击卡片
SHALL 呈现「登录后安装」引导而非触发写动作；已登录用户 SHALL 直达既有市场详情。
谦面市场列表 SHALL 增「官方」筛选片，命中官方集合的 pack 呈现官方徽章。

#### Scenario: 登录墙前看官方资产

- **WHEN** 未登录访客打开壹座产品页（pre-login 壳）
- **THEN** 官方资产段呈现官方团队模板与精选卡片，点击卡片出现登录引导，不产生任何写请求

#### Scenario: 匿名写仍被拒

- **WHEN** 未登录客户端对市场发发布/订阅/分类变更请求（匿名读开启的部署）
- **THEN** 一律 401，与匿名读关闭的部署逐字节同语义

#### Scenario: 开关关闭保持登录墙

- **WHEN** 部署未开启匿名读开关
- **THEN** 市场读面对未登录保持既有登录墙行为，官方资产段呈现但数据走匿名可读的官方集合端点
  （该端点不受开关影响——它只暴露公开面字段）


### Requirement: 官方集合以规格书呈现

官方集合呈现面 SHALL 以三桶规格书呈现每个官方条目（消费共享规格书契约：三桶恒显、类型徽章、三轴 provenance、引导来自文档数据），而非仅徽章加筛选。匿名访客 SHALL 能看到官方条目的规格书呈现（沿官方集合匿名读语义），且匿名面不得下发 manifest 敏感结构（沿 pack-visibility「探测教不出东西」纪律——匿名读面给什么，规格书就只能显示什么）。

#### Scenario: 匿名访客看懂一支官方团队

- **WHEN** 匿名访客打开官方集合
- **THEN** 每支官方团队以规格书呈现（角色/技能/工具三桶、类型徽章、provenance、引导），无需登录

#### Scenario: 匿名面不放大敏感结构

- **WHEN** 匿名读面对某官方条目只提供摘要投影
- **THEN** gallery 的规格书按该投影渲染，不出现要求完整 manifest 才有的细节

### Requirement: 官方条目带克隆入口

官方集合的每个条目 SHALL 提供「克隆到我的工作室」入口，行为沿 `agent-fork-lineage` 契约（种子来自可读 manifest、落壹座 Studio 工作文档、血缘盖章）。匿名访客激活克隆 SHALL 得到登录引导（沿既有登录墙语义），不得直接执行写动作。

#### Scenario: 登录用户克隆官方团队

- **WHEN** 已登录用户在官方 gallery 对一支官方团队激活克隆
- **THEN** 壹座 Agent Studio 打开以该 manifest 为种子的可编辑工作文档，且未产生任何市场/部署实体

#### Scenario: 匿名访客的克隆是登录引导

- **WHEN** 匿名访客激活克隆入口
- **THEN** 呈现登录引导而非执行 fork；登录后重复该动作可完成克隆

### Requirement: starter 序列在 gallery 可见

官方集合 SHALL 标记五支官方 starter 团队的序列位置（说明卡数据与种子 manifest 同源，沿 `official-starter-teams` 既有语义），使新用户可循序列从 gallery 进入「装—看—学」路径。序列标记 SHALL 为呈现层注记，不改变三段聚合端点契约。

#### Scenario: 循序列学平台

- **WHEN** 新用户打开官方 gallery
- **THEN** 五支 starter 团队带序列标记且说明卡与市场详情同源；从任一卡可进入其市场详情与引导
