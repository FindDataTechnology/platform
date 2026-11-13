## Why

外部技能市场（SkillHub ~25k 条、Smithery ~25k 条）里已经沉淀了大量高质量、热门、可再分发的技能；壹座今天能把它们**装进某个用户的实例**（`external-skill-sources` 刀二），却不能让它们**成为市场上的官方资产**。结果是：生态里有货，官方精选面（新人理解平台的样板）只能靠自研堆，广度上不去。

同时 `ecosystem-curation` 立了一道硬墙：未经审校的开源素材**不得**进入精选目录、不得被 pack manifest 引用。那道墙是对的，不能拆——但它的存在意味着「热门技能自动进精选」这条路从一开始就不成立。

本变更要的是墙内的那条路：**运营侧把真正好的热门外部技能，经审校后转正为官方 Agent 上架**。质量由评审保证（低量、人工），不靠自动包装引擎；法律由许可门保证；可追溯由「官方精选·已审校 + 上游 + 许可 + 钉定 commit」三合一 provenance 保证。

## What Changes

- **新增「官方精选·已审校」provenance 第三态**：今天只有「官方原创 vs 生态·未审」二态；转正产物是混合体（上游是第三方的，上架方是本平台），必须能被如实读出来——上游仓库 URL、上游名、许可证、钉定的 commit sha，与「官方原创」和「生态·未审校」三者互不混淆。
- **新增许可准入闸**：只有 MIT / Apache-2.0 / BSD 系允许转正；AGPL / 非商用 / 无许可声明**硬拒**并记失败轴。理由：转正是**再分发**，不是引用。
- **新增钉定 commit 的内联快照**：转正的那一刻把技能正文 + 辅助文件树整棵树固化进包版本，永不引用货架条目。上游 404 / 仓库被删（`frontend-design` 已有实证）不会让官方资产变成空壳。
- **新增运营侧转正通道**（鉴权必需，非公开面）：取包 → 审校 → 包成官方 Agent 草稿（技能内联 + 起草 persona，工具面默认 `chat`）→ mint + 定价门 → 精选市场上架。
- **扩展 curation provenance 契约**：`ecosystem-curation` 的 provenance 需求从二态扩为三态，并显式钉死「转正条目不削弱精选墙既有场景」（转正是**先过审校再上架**，不是绕过审校）。
- **阶段一不产品化管线**：先手工转正 2–3 枚真热门真宽松许可的技能，端到端跑通，用真实案例把 provenance/许可/快照模型校准到位；再把管线工具化。

**明确不做（Non-goals）**：

- 用户自助「一键把技能包成我的 Agent」（另一条车道，绕精选墙，需另立）。
- 批量/自动化导入任意热门条目。
- 团队级转正（一束技能 → 岗位树/边/节奏）。实测结论（design「Fork 结论 A」）：团队包 ≠ 几个 agent 并列，`fleet.members[].target` 指向的是 **pack-preset（persona）而非技能**，且节奏/边/KPI 槽位四类信息一个都不在技能文本里；「≥3 岗」是必要非充分条件，真闸是「节奏能否被陈述」。故团队形状交给既有 `fleet-architect` + blueprint studio，adoption 只负责内容（manifest 级，团队包同样适用）。等 Agent 级跑顺、≥3 真案例落库后另立。
- 把「热度」当准入信号：热度只能当**发现**，永远不当**上架资格**。
- 改动 `external-skill-sources` 的货架语义（货架仍是只读镜像 + 逐条安装）。

## Capabilities

### New Capabilities

- `official-adoption`: 运营侧把经审校的外部热门技能转正为官方 Agent 的治理与流程面——许可门、审校、钉定快照、provenance 三态标记、工具面收窄、鉴权通道。

### Modified Capabilities

- `ecosystem-curation`: provenance 从「官方 vs 生态」二态扩展为「官方原创 / 官方精选·已审校 / 生态·未审校」三态；转正条目必须先在审校面过关才可上架，且该扩展不得改变精选目录既有准入、排序与展示规则。

## Impact

- **代码（预期接触面，已按 2026-10-31 实测校准）**：
  - `lib/pack-manifest.js` — 新增可选 `provenance` 结构（上游 URL、上游名、许可证、commit sha、审校记录）；工具面默认收窄的校验。**不改** `lib/pack-badge.js`（类型徽章四值推导不变）。
  - `gateway/packs.js` — 官方性仍由 roster（`OFFICIAL_AUTHOR_EMAILS`）决定，本 change 不碰该判定；只在其上叠加来源轴投影。
  - `packs/` + 铸造链 — 官方 Agent 草稿的骨架来源（persona 起草复用 `packs/facade-builder` 的既有纪律）。
  - `external-sources.js` — 复用取包链路（`fetchPackage`，多文件树 + 脚本标注），并在取包时补取上游 LICENSE（货架 `licenseState` 实测恒 `unknown`，不能作为许可判定输入）。
  - `preset-pack-bridge.js` — 桥接已内联 `files`/`frontmatter`，但**不带** `origin_meta`；转正路径必须自己携 provenance（bridge 的这个问题作为已知坑记录，不在本 change 修桥本身语义）。
  - 市场和 facet 展示面 — 唯一投影 `describeProvenance(pack)` 合成三轴（类型徽章 / roster 官方性 / 来源 provenance），「官方精选·已审校」徽章 + 上游/许可/钉定 commit 的只读展示。
  - 运营侧通道（新增路由或脚本，鉴权必需）。
- **数据/API**：pack manifest 的 provenance 形状新增键（需与 facet 侧 `marketplace-json.js` 一致）；无破坏性 API 变更。
- **依赖**：无新增运行时依赖（`jszip` / `js-yaml` 已是直接依赖）。
- **治理**：受 `ecosystem-curation` 精选墙约束；受 `external-skill-sources`「未经本平台审校」标记纪律约束（两条面互不削弱）。
- **CI 额度**：本 change 为运营侧低量作业，不引入自动化的高频率 CI 消耗。
