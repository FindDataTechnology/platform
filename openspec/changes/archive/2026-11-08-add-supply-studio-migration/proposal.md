# Proposal: add-supply-studio-migration

## Why

供给域路线第二波（`docs/supply-domain-roadmap.md` W2，前置 W1 已于 2026-11-05 归档）：创作面仍在壹座——`/studio` 三栏工作区与 `/agents` 四区的创作半边（构建区/我的创作区）要求创作者先成为壹座用户，外部创作者从「看到素材」到「自己发布」的漏斗在身份处断裂。roadmap D2 裁定创作面整体迁入谦面成为供给域 Studio 面，试跑不依赖壹座；roadmap 同时提示 agent-builder-workspace 刚建成（11-01~11-03 三批），在其生命周期最早期迁移成本最低。壹座退为纯运行域：装机、调优、执行。

## What Changes

- **Studio 面迁入谦面**：三栏工作区（文档库/画布/检查器）与创作半边整体成为供给域 Studio 面，宿主为谦面（facet 应用）；蓝图文档存储宿主随迁（壹座 per-cell SQLite `blueprints.db` → 谦面侧存储，存量文档迁移、owner 身份映射），「凭据禁带闸」不变量随存储走。
- **创作者身份一张票**：注册→创作→试跑→发布全程用谦面身份（Logto 轻账号），**不需要壹座账号**；发布走谦面既有发布闸（manifest 校验+注释层强制，与 pack 同闸）。
- **预览沙箱（供给域自有）**：发布前的试跑=ephemeral 预览沙箱——限额（每身份每日配额、单次时长/token 帽）、不落库、非免费算力口；v1 范围=静态校验+manifest 组装+LLM 起草干跑，不含 cell 实执行。
- **壹座侧解体与退役**：`/agents` 四区解体（构建/我的创作/供给 → 供给域深链；调优 → 壹座原生调优面，独立于四区门面）；sidebar「智能体构建器」一级入口改为「智能体市场」深链 + 装机动作面板；壹座 `/studio` 路由退役为到供给域 Studio 的重定向（`?doc=` 文档 id 跨迁移保持稳定）。
- **铸→部署跨域闭环**：供给域 Studio 的「部署团队」动作经壹座装机+from-template 通道落成 born-paused 团队（壹座会话在装机瞬间承接）；舰队详情「来源蓝图」芯片回链供给域 Studio 文档（`_casting.blueprintId` 保留）。
- **晋升通道（D7）**：壹座实例 → Studio 草稿的单向晋升——fork 实例状态（preset/配置/skills）成草稿带来源出处；记忆与会话历史默认不 fork；运行中实例永不被 Studio 编辑反向改动。
- **AI 起草随迁**：蓝图 AI 起草与逐字段采用写门迁至谦面侧，模型走谦面网关配置（sub2api 同源）；判官车道为外部依赖照旧接。

**Non-goals**：域名/品牌归一与机器面静态化（W3）；registry 与 pack store 物理存储合并（`add-supply-store-unification` 另单在册）；调优行为本身不迁移（留在壹座，`skill-self-evolution` 契约不变）；不做供给域自有 cell 执行（v1 预览=干跑）。

## Capabilities

### New Capabilities
- `supply-studio`: 供给域创作面契约——三栏工作区唯一创作面、谦面身份一张票的完整创作漏斗、文档存储宿主与凭据禁带闸、自动保存/生命周期/校验/深链/结构图既有语义的承接、发布经供给域发布闸、铸→部署跨域闭环与回链。
- `studio-preview-sandbox`: ephemeral 预览沙箱——不落库、限额、非免费算力、诚实降级。
- `agent-promotion-channel`: 壹座实例→Studio 草稿的单向晋升——fork 范围 v1 划定、单向闸门、来源出处如实。

### Modified Capabilities
- `agent-builder-workspace`: 壹座侧创作面退役——工作区 UI 九项需求随迁供给域（REMOVED，迁移指 supply-studio）；「铸造到运行的闭环与回链」改写为跨域形态（MODIFIED）。
- `agent-builder-hub`: `/agents` 四区解体——门面入口改「智能体市场」深链+装机面板（MODIFIED）；四区结构/供给三柜/我的创作退役（REMOVED）；调优区改原生调优面（MODIFIED）；入口收编守卫兑现退役（REMOVED）。

## Impact

- **facet/ + gateway/（谦面，paas 仓）**：Studio 面（web 组件随迁 + 服务端文档存储/生命周期/校验/起草端点）、预览沙箱、发布闸复用、身份（既有 Logto）。
- **壹座（server + web/src）**：`/agents` 四区解体、`/studio` 重定向、sidebar 入口换装、原生调优面、from-template 装机通道承接跨域部署、舰队详情芯片改链。
- **数据迁移**：`blueprints.db` 存量文档（特性上线数日、量小）迁谦面侧；owner email 映射到谦面身份；壹座侧原库转只读归档。
- **模型依赖**：谦面侧新增 LLM 起草通道（sub2api 内网），判官车道（`BLUEPRINT_JUDGE_MODEL`）为外部域照旧。
- **风险**：跨域部署在装机瞬间需要壹座会话（无壹座账号的创作者在「部署」步如实引导注册——发布不需要、运行需要）；六客户端装包链路回归；`?doc=` 旧链接经重定向保持可用；调优面新入口的词表与可发现性。
