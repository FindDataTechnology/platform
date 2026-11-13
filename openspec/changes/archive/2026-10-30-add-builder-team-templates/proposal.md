# add-builder-team-templates

## Why

路线线2要两类「帮用户建团队」的官方 Builder teams，现状是三块残片：
①**团队架构师**已是 bundled 一等 builder（`server/fleet-architect-mcp.js` 五工具，种子自激活），
但它只会把 NL 编译成**现役团队**草稿——编不了**可复用模板**；②**蓝图（模板）的 NL 起草**是纯复制
粘贴流：蓝图构造间给一段提示词（`blueprints.draft.promptIntro`），用户拿去问任意会话、把返回 JSON
**粘回来**——没有工具面、没有校验反馈回路、不落草稿池直通；③**智能体作者**缺位：分身工坊只造分身
（facade），通用 pack（技能+MCP 引用+角色）的对话式创作没有官方 builder，创作入口只有空表单编辑器。

用户愿景：「帮助我们的用户基于我们的各种基础设施和模板快速构造自己的 agents teams」。Builder teams
本身就该是平台的一等公民模板，而不是散落的三件工具。

## What Changes

- **官方 Builder teams 集（四员，定位收纳）**：
  - **团队架构师**（已有，升格定位）：NL → 现役团队草稿 → diff → 批准落地。管编制不管作战。
  - **蓝图构造师**（新官方 pack）：NL → **模板蓝图**草稿。persona 收编现有 promptIntro+constraints
    文案并扩为完整纪律；新工具面 `blueprint_draft`（按蓝图 schema 组稿）→ `blueprint_validate`
    （走 `fleet-blueprint-studio` 既有校验链，逐条错误返回）→ `blueprint_save`（草稿落蓝图草稿池，
    与手工粘贴同一池同一链）——把「复制粘贴」升级为「对话内直通」。
  - **智能体作者**（新官方 pack）：面试式通用 pack 创作——采访能力域 → 技能草稿 → MCP 引用从
    市场目录**选取**（v1 内容边界：不能自带端点，沿 pack 编辑器同一纪律）→ 角色 persona → 产出
    **过 `validatePackManifest` 的 manifest 草稿**落入既有 pack 草稿池；发布仍走既有发布门（builder
    不自行发布）。
  - **分身工坊**（已有，收纳进集）：定位「建分身」，与作者分工明确（分身= facade，作者=通用 pack）。
- **发现与入口接线**：四员全部带官方徽章（消费 `add-official-pack-showcase` 的 `official` 判定）；
  创建入口空态直达对应 Builder——创建团队空态→架构师/蓝图构造师，pack 草稿空态→智能体作者，
  分身入口→分身工坊；蓝图构造间的粘贴引导文案改为「可在会话里让蓝图构造师直接起草」。
- **明确不做（防漂移边界）**：不做可视化 pack IDE；Builder 不自行发布/铸造（发布门与双钥匙试跑闸
  原样）；不新增调度器或第二校验链（校验全部复用）；架构师工具面零改动。

## Capabilities

### New Capabilities

- `builder-team-templates`: 官方 Builder teams 集——成员定义、工具面边界（只产草稿不发布）、
  官方徽章消费与创建入口接线。

### Modified Capabilities

- `fleet-blueprint-studio`: NL 起草通道从「复制粘贴」扩为「builder 工具面直通」——草稿经工具落
  既有草稿池，校验链、批准闸、铸造通道零变化。

## Impact

- **新 MCP 工具面**：`server/blueprint-author-mcp.js`（blueprint_draft/validate/save，loopback 桥
  身份沿架构师惯例=cell owner）与 `server/pack-author-mcp.js`（draft create/update/validate/list
  market servers，走既有 `/api/pack-drafts*` 语义与 `requireMcpManage` 同权限）；`platform.bundle.json`
  登记两段（bundled 自激活，同架构师）。
- **新种子**：`docs/blueprint-architect.seed.json`（蓝图构造师）、`docs/pack-author.seed.json`
  （智能体作者）——过 pack 清单校验，en 副轨随 `official-locale-coverage` 门（门须把两份新种子纳入）。
- **web**：三处创建空态接线 + 蓝图粘贴引导文案改写（i18n 五语言）。
- **测试**：两段新 MCP 工具面单测（草稿落池、校验逐条返回、越权/越界拒绝）；种子过校验器测试；
  locale 门扩两份种子。
- **不影响**：架构师五工具、蓝图校验/批准/铸造/试跑链、pack 发布门、分身工坊。
