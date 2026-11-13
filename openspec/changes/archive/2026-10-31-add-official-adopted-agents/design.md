## Context

见 `proposal.md` — Why。设计上要贴合三条既有事实：

1. **取包链路已存在**：`external-sources.js` 的 `fetchPackage` 已按源实测定案（SkillHub 302→COS zip；Smithery gitUrl→GitHub contents 逐文件，含符号链接中间段解析、逃逸即拒、超限 omitted）。转正**复用**它，不新增适配器、不新增外部依赖。
2. **精选墙已存在**：`ecosystem-curation` 规定未审校素材不得进精选目录、不得被 pack manifest 引用；「外部镜像货架」是**命名独立面**。转正必须落在墙内——先审后上，不是绕过。
3. **skill→pack 的机械链路已存在但漏 provenance**：`preset-pack-bridge.js` 已把「自有技能（`origin_pack_id` 为空）连同 `files`/`frontmatter` 内联」进 pack 草稿（`add-packaged-skills` 4.3），但**不带 `origin_meta`（source/上游 URL/上游名/许可）**。这是转正路径的核心缺口：直接复用桥会丢归属与许可，导致无授权的再分发。

### 代码实测校准（2026-10-31，三条推翻/修正提案期的假设）

- **徽章真源 = `lib/pack-badge.js`**（不是 facet）：`deriveBadge` / `badgeFromFlags` 四值 `blueprint→facade→assistant→toolkit`，纯**类型轴**、作者不可自报。provenance 是**与徽章正交的第二轴**——转正不是新增第五种 badge。
- **`official` 来自部署 roster**（`gateway/packs.js` 的 `officialAuthors`，env `OFFICIAL_AUTHOR_EMAILS`；`/api/packs/official` 三段聚合）。作者不可自报。故「官方-adopted」= **roster-official=true ∧ manifest 携带 adopted provenance**，不是 manifest 里自称一个 `kind`。
- **热度字段已存在**：归一化 Entry 早已带 `downloads`/`stars`（SkillHub）、`totalActivations`/`externalStars`（Smithery），只是没被用于排序。探索期「未见热度字段」的判断是错的，删除该开放问题。
- **`licenseState` 两源均硬编码 `unknown`**：SkillHub API 无许可字段、Smithery 许可在上游仓库 LICENSE（`external-sources.js:472` 注释已注明"刀二 upgrade path fetches it"）。**转正的许可门不能依赖货架 `licenseState`，必须去上游仓取 LICENSE 文件判定。**

## Goals / Non-Goals

**Goals:**
- 让「经审校的外部热门技能」成为可上架、可追溯、可更新的**官方 Agent**，且全程可审计（谁取包、谁审、谁铸、谁批、钉在哪个 revision）。
- provenance 三态在数据面与展示面都落到位（官方原创 / 官方精选·已审校 / 生态·未审校），三者可辨、不可混。
- 许可门、快照钉定、工具面收窄三件事在**转正那一刻**强制，且失败时零副作用。
- 阶段一能纯手工跑通（运营逐枚转正 2–3 枚），阶段二再把同一套动作产品化成运营通道。

**Non-Goals:**
- 不做用户自助一键包（另一车道，绕精选墙，另立变更）。
- 不做团队级转正（≥3 岗/边/节奏），Agent 级跑顺后另立。
- 不把「热度」当准入——热度只可做发现排序，永不做上架资格。
- 不改 `external-skill-sources` 货架语义（仍只读镜像 + 逐条安装）。
- 不修 `preset-pack-bridge.js` 本身的语义（它服务自建预设一键流）；转正路径自己携带 provenance，桥的「丢 origin_meta」作为已知坑记录。

## Decisions

### D1 · provenance 是 manifest 上的新键，与徽章/roster 两轴正交

- **决策**：在 pack manifest 增加可选 `provenance` 结构：`{ kind: "official-adopted", upstreamUrl, upstreamName, license, revision, adoptedBy, reviewedBy, reviewedAt }`。它**不参与** `lib/pack-badge.js` 的四值类型推导，**也不替代** roster-official 判定；展示层的「官方精选·已审校」= `official(roster)===true ∧ provenance.kind==="official-adopted"`。三者是三条正交轴：**类型徽章**（结构推导）、**官方性**（部署 roster）、**来源**（provenance）。
- **理由**：`official` 今天只由 `OFFICIAL_AUTHOR_EMAILS` roster 决定，作者不可自报；把"adopted"塞进 manifest 自报的 `kind` 会开一个「自称官方」的口子。让 adopted 只是**来源标注**、官方性仍走 roster，才不破坏既有「作者不可自报官方」的铁律。manifest 又是版本真相，钉定 revision 与许可必须随版本冻结。
- **替代**：①把 adopted 加进 `pack-badge` 第五值——否，徽章是类型轴，混入来源会让"分身/蓝图"语义失真；②建独立 provenance 表——否，版本回滚后"当时哪份许可"会失真；③manifest 自报 official 布尔——否，违反 roster-only 纪律。

### D2 · 快照内联 + 钉 commit，不复用货架引用

- **决策**：转正时把技能正文 + 辅助文件树整棵内联进 pack 版本，并记录上游 `revision`（commit sha）与 `upstreamUrl`。运行期不读货架、不回源。
- **理由**：货架条目会 404（`frontend-design` 上游目录已删的既有实证）；引用式会让官方资产在上游消失时变空壳，违反「官方」承诺。
- **替代**：存 `(source, slug)` 引用、安装时现取——否，官方资产的可用性不能依赖第三方存活。

### D3 · 许可门落在「进池前」，且许可必须从上游仓取，不看货架 `licenseState`

- **决策**：许可判定在**取包后、写任何官方资产前**执行，硬拒 AGPL/非商用/无声明；拒绝时记失败轴 + 观测到的许可原文（或显式「未声明」）。判定输入**不是**货架的 `licenseState`——实测两源均硬编码 `unknown`（`external-sources.js:419/443/491/517`），SkillHub API 无许可字段、Smithery 许可在上游仓库 LICENSE。转正必须在取包时**同时取 LICENSE 文件**（或 `package.json`/仓库元数据）做判定。
- **理由**：越早拒越不污染数据；与 `ecosystem-curation` 的「license landmine 在审校面拒」对齐，避免先存后删。若信 `licenseState` 会得到「全部 unknown → 全部拒绝」的死局，或被迫放宽成"unknown 也算过"的合规漏洞。
- **替代**：①上架门才校验——否，未授权内容先落库，回滚成本与合规风险都高；②直接用 `licenseState`——否，实测恒为 unknown，等于无数据；③让运营肉眼读 README 判断——否，不可审计、不可复现。

### D4 · 工具面默认收窄（chat），放宽要留审校记录

- **决策**：转正产出的 Agent 默认 `toolFace: "chat"`（无 shell/文件/浏览器/子代理触手）；要放宽必须由审校者显式记录理由。
- **理由**：外部技能正文是**不可信第三方文本**，会进模型提示词；无触手默认把注入面收在「说错话」而非「动手做」，与 `facade-builder`「接待裁工具面」的既有纪律同构且自示范。工具面枚举已由 `lib/pack-manifest.js` 的 tool-face tiers（`add-serving-tool-face`）定义，本 change 只需给转正产物钉一个默认值，不新增档位。
- **替代**：默认全工具面——否，等于把第三方文本直接接到执行面。

### D5 · 运营通道鉴权必需，先手工后工具化

- **决策**：阶段一走**运营侧手工/脚本**（复用 `fetchPackage` + 手工编辑 manifest + 现有 mint/定价门），每枚产出都留 adoptedBy/reviewedBy；阶段二再收敛成带鉴权的内部端点或脚手架。官方性仍必须走 roster（`OFFICIAL_AUTHOR_EMAILS`）——转正包发布所用账号必须在 roster 内，否则 `official` 徽章不会亮，这是既有纪律，不另开后门。
- **理由**：低量手工能先用真实案例把 provenance/许可/快照模型校准到位，避免对着想象案例设计管线；`ecosystem-curation` 明确允许 operator-side ingestion 但要求鉴权；`gateway/packs.js:1159` 的「作者不可自报 official」铁律不得破坏。
- **替代**：一上来建批量端点——否，模型未定就自动化会把错误固化。

### D6 · 更新走「diff → 重铸 vN+1 → 订阅者显式跟新」

- **决策**：上游变更不作为自动替换；以「与钉定快照的 diff」呈现给运营审，通过后铸 vN+1；订阅者留在旧版本直到显式跟新。
- **理由**：完全复用 `fleet-owner-iteration` 的 draft→diff→approve→vN+1 与市场版本跟新语义，不发明新机制；符合「AI/自动不得静默改已生效资产」的不变式。

## Risks / Trade-offs

- **[许可池变窄]** 只有宽松许可能转正，AGPL/无许可的热门技能进不来 → **缓解**：把「许可预筛」放在发现步最前，短名单从第一步就只含可再分发者；对不可转正的爆款，另走「引导用户自行安装到实例」而非官方转正。
- **[广度=评审时间]** 每枚要人工审 + 写 persona → **缓解**：persona 起草复用 `facade-builder` 纪律（interview→persona），运营只做审校与定稿；阶段二把起草半自动化。
- **[provenance 展示漂移]** 三条轴（类型徽章 `lib/pack-badge.js` / 官方性 roster `gateway/packs.js` / 来源 provenance manifest）若各处自行拼装「官方精选·已审校」，易不一致 → **缓解**：唯一投影函数 `describeProvenance(pack)` 在服务端拼出三轴合成结果，平台面与 facet 面都只读它；`deriveBadge` 不动、roster 不动，新增只在投影层。测试钉矩阵（类型×官方性×来源 3 组合各一条断言）。
- **[工具面默认过严]** chat 面可能不足以承载某些技能的真实用途 → **缓解**：放宽有审校记录通道，不是永封；先用 chat 起步观察，按需放宽。
- **[上游快照与后续更新脱节]** 钉死后上游持续演进，官方资产变旧 → **缓解**：D6 的 diff 通道 + 详情页展示「钉定 revision / 日期」，把「旧」如实说出（同 `facade` 的「语料截至」诚实姿态）。
- **[许可判定误读]** MIT 判定靠文本匹配，可能把「MIT OR Apache」双许可或 `LICENSE` 缺失但 `package.json` 声明 license 的边缘案例判错 → **缓解**：判定器接受多来源（LICENSE 文件 / package.json `license` / 仓库 manifest），命中任一宽松许可即过；双许可取宽松者；全部缺失才判 not-declared。每次判定把**读到的原文片段**存进审校记录，可人工复核推翻。
- **[热度排序失真]** `downloads`/`stars` 跨源口径不一（SkillHub downloads vs Smithery totalActivations，stars 也不同源），直接混排会失真 → **缓解**：阶段一不用热度做自动排序，热度只作人工挑选的参考展示；若日后排序，按源内分位归一后再比。

## Migration Plan

- 纯新增：新 `provenance` 键对旧 manifest 无影响（旧包无 `provenance` = 官方原创/生态，按既有 `deriveBadge` + roster 规则推导，逐字节不变）。
- `lib/pack-badge.js` 与 roster 判定**零改动**；新逻辑全部落在校验器的新增可选键 + 投影层。阶段一产出以真实 pack 版本落库，无 schema 迁移需求。
- 回滚：删除一枚官方转正包即回到上架前状态；不涉及存量数据改写。

## Open Questions

- 阶段一具体转正哪 2–3 枚（真热门 × 真宽松许可 × 质量过硬）——待运营挑选，接入真实上游后定。
- `describeProvenance` 的三轴合成结果要不要进 `GET /api/packs/official` 的三段聚合（还是仅详情页/列表徽章呈现）——可等阶段一第一枚落地后按真实 UI 需要定，不改变 spec。

## Fork 结论（2026-10-31 实测，记录在此不另立单）

### Fork A · 团队级转正（≥3 岗）—— 不是机械扩量，本单明确不做

实测 `docs/fleet-templates/*.seed.json` 与 `lib/pack-manifest.js`：**一个团队包 ≠ 几个 agent 并列**，而是四件套——

```
fleet.members[]      ref / title / parentRef / target / kpiSlots / cadence
fleet.orchestration  edges[]: {kind:"trigger"|"dispatch", from, to, cron}
fleet.params[]       cron 参数（ceoCron / dailyBriefCron …）
fleet.requires[]     a2a 依赖（如 wanxing-cluster）
```

关键结构事实：**每个 member 的 `target` 是 `{kind:"pack-preset", packId, presetId}`——岗位是"预设（persona）"，不是技能。** 所以：

- 技能只提供「怎么干」；团队还要求「谁干 / 多久干一次 / 向谁报 / 报什么」，**这四样一个都不在技能文本里**。
- 「≥3 岗」是**必要条件但远不够**。真正的闸是「**节奏能否被陈述**」：一个没有 cadence、没有 edges、没有 kpiSlots 的团队，只是几个并列 persona —— 正是舰队已有的「空输出空转 / 团队空转」反模式。
- 因此团队级转正的正确接法**不是**再造一条团队采纳管线，而是：**adoption 管线只管内容**（取包 / 许可 / 快照 / provenance，manifest 级、团队包同样适用），**团队形状交给既有 `fleet-architect`**（自然语言 → 岗位树/边/节奏草稿 → diff → apply）+ blueprint studio。
- 立项时机：Agent 级跑顺、≥3 真案例落库之后。届时复用本单 provenance 机制即可，无需改模型。

### Fork B · 热度排序 —— 字段现成，但跨源口径不一

- 字段**已存在**并归一化（SkillHub `downloads`/`stars`；Smithery `totalActivations`/`externalStars`），只是未用于排序。
- **不可跨源直接混排**：downloads ≠ totalActivations、stars 与 externalStars 不同源，直接比会失真。
- 热度 ≠ 可转正：许可仍是硬门，热门但 AGPL 依旧进不来。
- 结论：可作**独立小单**（源内分位归一 → 仅用于发现排序），与转正解耦，不阻塞本单。
