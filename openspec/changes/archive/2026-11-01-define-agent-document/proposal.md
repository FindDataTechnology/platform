## Why

「智能体 = 角色预设 + 技能 + MCP 工具」这条原子公式，在数据层其实已经是真的：`lib/pack-manifest.js` 的 manifest 就是 `agents[].persona + skills[] + mcpServers[]`，并且发布门与安装门共用同一校验器。问题不在模型，而在**面（surface）**——同一个模型被包装成 5 个名词（预设 / 能力包 / 蓝图 / 团队模板 / 分身）、6 个互不复用的构建入口、4 个互不共享的展示面，导致：三桶（角色/技能/工具）从未被当作一个单元呈现；没有可视化构图面；蓝图与 pack 是两套编辑 UX；官方智能体读起来是徽章而非规格书；市场/谦面只能安装、不能学习或克隆。

路线 v4 已把「能力包」改称「智能体」，词表先行收敛，剩下的缺口是结构性的：**一个模型、多个面**。先把这根脊梁定义清楚，后建立各面才不会各自发明形状。

## What Changes

- **定义 Agent Document（智能体文档）为唯一组合模型**：每个 agent = `persona + skills + mcp` 三桶，团队形态附加 `fleet` 图，外加信封字段（`guide` / `i18n` / `provenance` / `serving` / `bots`）。它是既有 pack manifest 的命名与边界化，不新增数据形状。
- **定义四个发射口（emit targets）**，全部来自同一份文档：① 自建预设（cell 本地，不发布）② pack 草稿（→ 智能体市场）③ 团队模板（→ 部署舰队）④ 蓝图（→ 批准 / 铸造 / 迭代）。四个发射口**必须过同一套既有校验器**，禁止第二校验器。
- **声明「编辑器 / 生命周期分离」不变式**：未来只有一个可视化构建器（Agent Studio），但四条生命周期保持独立——蓝图的 validate→approve→cast→迭代 管线**不合并、不砍掉**；合并的只是编辑面。
- **声明「三桶规格书」展示不变式**：任何呈现 agent 的面（市场详情、官方 gallery、选择器）都必须能把 persona / skills / mcp 作为一个单元渲染。
- **明确 Non-goals（本 change 不交付）**：不实现可视化构建器（那是 `add-agent-studio`）；不改任何生命周期；不删除 4 个聊天内 builder persona；不迁移 `packGuides.ts`（那是 `move-pack-guides-to-manifest`）。
- **非 BREAKING**：内容模型零改，本 change 只做命名、边界化与不变式声明。

## Capabilities

### New Capabilities
- `agent-document`: 统一组合模型（三桶 + 信封 + 可选 fleet 图）、四个发射口及其契约、编辑器/生命周期分离不变式、三桶规格书展示不变式——后续所有构建器与展示面都要引用它。

### Modified Capabilities
<!-- 无：下游 change 才会修改 pack-marketplace / custom-presets / agent-fleet-templates /
     agent-fleet-architect / agent-catalog；本脊梁只新增被它们引用的能力。 -->

## Impact

- **Specs**：归档后新增 `openspec/specs/agent-document/spec.md`。
- **Code**：本 change 零代码改动。
- **下游（点名，不在本 change 交付）**：`add-agent-studio`、`fold-blueprint-into-studio`、`move-pack-guides-to-manifest`、`add-agent-spec-sheet`、`add-agent-fork-lineage`、`add-official-agent-gallery`。
- **Docs**：`docs/roadmap-agents-native-teams.md` §6 立案次序补引本脊梁。
