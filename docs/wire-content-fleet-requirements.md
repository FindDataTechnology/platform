# 萬星/壹座侧需求：柏讯内容舰队（wire-content-fleet）

> 来源：`fd-wire` change `wire-content-fleet`（已实施 16/28，代码侧全绿）
> 对象：paas（壹座 + 萬星）仓
> 状态：**待评审**。本文只列 paas 侧必须做的事，柏讯侧改动已完成，不在本文范围。

## 一、背景（一段话）

柏讯把三段生产能力（爬虫构建、看板/文本产物创建、内容持续迭代）打包成功能集，其中「柏讯 · 产物构建」包内嵌了一支 **3 岗舰队模板**（巡线岗主动日节奏 + 内容岗/源岗被动，源岗绑定已部署的 spider-heal A2A 服务）。该 pack 已构建完成并通过本地校验，下一步要装进 cell 真跑。

柏讯侧已就位：`wire-build-mcp` 新增看板/文档两个写入工具（17 工具），产物版本行新增 `source_ref` 生产来源指针列，两篇技能稿与两个 pack manifest 已产出并通过 `check_presets.py` / `check_tool_surface.py` 双闸。

## 二、已核实：不需要 paas 改动的部分

以下三件我们逐个读了代码确认**已经支持**，列出来是为了避免重复开发：

| 事项 | 证据 | 结论 |
|---|---|---|
| pack 携带 `fleet` 段可发布 | `gateway/packs.js:148` 调 `parseFleetTemplate`，失败即 400 | 现成，无需改 |
| `pack-preset` 目标位解析 | `server/fleet-provisioner.js:57-61` 用 `presetId` 查 `catalogAgentIds()`；`catalog.js:207` 把 pack 的 `manifest.agents[].id` 原样作为 catalog 条目 id | 现成，无需改 |
| `existing-a2a` 目标位解析 | `fleet-provisioner.js:68-71` + `routes/fleets.js:469-471`：`catalog.getAgentEntry(id)` 且 `mode === "a2a"` | 现成，无需改 |

另外：模板里的 `packId: "{{PACK_ID}}"` **不会被任何代码替换**——`pack-preset` 分支只读 `presetId`，`packId` 是死字段（`parseFleetTemplate` 只要求非空）。柏讯侧保留它作为书写约定，paas 无需实现替换。

## 三、需求

### P1 · 岗位身份必须可注入（阻断级）

**问题**：产物构建 MCP 的写入工具支持 `source_ref` 入参（部署/岗位/回合三元组），缺省读环境变量 `WIRE_SOURCE_REF`。但 agent 在回合内**不知道自己是谁**：`{{fleetContext}}` 只注入下级报数与待送达拍板（`routes/fleets.js:684`），不含岗位身份；runner 也没有为成员回合设置任何身份环境变量。

**后果**：`source_ref` 只能由模型自己编一个字符串，审计价值归零；`wire-content-fleet` 的「产物携带生产来源」要求（spec `artifact-lifecycle` 新增需求）在真跑时无法兑现。

**要求**：舰队成员回合开始时，岗位身份必须对 agent 可见，至少包含 `fleetId`、岗位 `ref`/`title`、`memberId`。二者择一或都给：

- **R1-a（推荐）** 在 `promptTemplate` 占位符里补 `{{fleetPost}}`（或 `{{fleetIdentity}}`），注入形如 `fleet=<id>;post=<ref>;title=<title>` 的一行；
- **R1-b** 为成员回合设置环境变量 `WIRE_SOURCE_REF`（若 runner 支持 per-member env），回合结束清除。

**验收**：
1. 起一个真实成员回合，回合内可读到自己所属 fleet 与岗位标识（占位符渲染或 env 均可）；
2. 该回合调用 `wire_artifact_dashboard_create` 时能带上 `source_ref`，产物版本行可读出三元组；
3. 非舰队回合（普通对话）不注入该身份，行为与现状一致。

**边界**：只注入身份，不注入凭据；不得把 fleet/岗位身份写进对外可见的 AgentCard 或公开目录。

---

### P2 · 「等价节奏」冲突校验的落点（**已按实情改写，paas 侧已交付只读端点**）

**问题**：柏讯侧 spec 要求「岗位节奏与某产物的刷新调度等价且目标同一产物时，配置校验拒绝并指向既有刷新调度」。但**刷新调度是柏讯的数据**（`fd-wire` 的 `refresh_schedules` 表），paas 侧看不到；paas 的岗位节奏 paas 自己知道。单侧都判不了。

**候选方案**（请 paas 侧选一个，柏讯按选择补对应一侧）：

| 方案 | 做法 | 代价 |
|---|---|---|
| **A（推荐）** | paas 提供只读接口：给定 fleetId，返回各岗位的 `{ref, title, cron, tz, targetRef}`；柏讯在**创建刷新调度**时调它，命中等价节奏则 409 并指向该岗位 | paas 加一个只读端点 + 柏讯加一次远程校验 |
| B | 柏讯提供只读接口：给定 artifactId 返回其刷新调度；paas 在**建岗/改节奏**时调它 | 反向依赖（paas 依赖柏讯），与既有借用契约方向相反，不推荐 |
| C | 只做构建期 lint：套件 manifest 内「岗位节奏 vs 声明刷新」自查 | 抓不到跨系统冲突，只能防同一个 pack 内的笔误 |

**若选 A，验收**：
1. 给定 fleetId 的只读接口返回全部在岗岗位的节奏与目标位，不含凭据与运行数据；
2. 柏讯侧对等价节奏返回 409，错误文案指名冲突岗位与既有刷新调度；
3. 不等价（间隔不同或目标不同）时正常放行。

**实施后记（2026-10-23）**：paas 已交付方案 A 的只读端点 `GET /api/fleets/:id/cadence`（成员 `{ref,title,cron,tz,targetRef}`，被动岗 cron=null，KPI 槽不外泄）。
但柏讯侧复核后发现**该要求的前提不成立**：岗位 `targetRef` 指向执行者（persona/cluster/a2a），刷新调度指向产物，目标域不相交，「同一目标等价」永远不成立。
因此柏讯侧把 spec 改为可执行形式——物化节奏唯一归刷新调度、由既有间隔地板（artifact ≥360 分钟）兜底——不再做跨系统等价校验。
该端点保留作舰队控制台的观测面（看谁在什么节奏上跑），**不是**校验依据。此项对 paas 无进一步要求。

---

### P3 · `mcpServers` 上限 5（可选，非阻断）

**问题**：`lib/pack-manifest.js:41` 的 `maxMcpRefs: 5`。柏讯 22 个既有分析套件里，`wire-equity-research`、`wire-factor-selection`、`wire-industry-linkage`、`wire-sentiment` 四个已达 5 个 server，无法再声明产物构建服务（`wire-build-mcp`），因此这四个套件的分析结论**无法沉淀为产物**。其余 18 个已完成追加。

**要求**（二选一）：
- 把 `maxMcpRefs` 提到 6（并评估工具面膨胀对模型选择的影响）；
- 或允许 manifest 显式声明「替换某 server」的语义，让套件自己决定取舍。

**若都不做**：四个套件保持只读，功能不完整但一致，柏讯侧接受并在文档中注明。

## 四、验证项（不写代码，但需要 paas 侧确认）

| # | 事项 | 怎么验 |
|---|---|---|
| V1 | spider-heal 的 registry A2A 条目 id 是否等于 `packs-kkcie7nlrhluo4likpnn0w-spider-heal` | 在装好的 cell 里查 `catalog.getAgentEntry("packs-kkcie7nlrhluo4likpnn0w-spider-heal")` 是否返回 `mode === "a2a"`；不等则柏讯改模板里的 id |
| V2 | pack 安装后两个 agent 是否都以 `status: "installed"` 进 catalog | 装「柏讯 · 产物构建」后查 catalog，应有 `wire-fleet-patrol`、`wire-fleet-content` 两条 |
| V3 | 3 岗舰队实例化结果 | 装包 → 建队，应得 3 岗：巡线（有 cron `0 9 * * *`）、内容（无 cron）、源（无 cron，目标位 a2a）；源岗若 V1 未通过会降级为待补岗 |

## 五、非目标

- 不改 `refresh-scheduler` 的间隔地板与配额；
- 不新建 agent 运行时、调度器或事件总线；
- 不放开「带内容一步创建」的平台租户限制（柏讯走两步 + 补偿）；
- 不为内部/外部各做一份 pack（同一模板，凭据与信号在运行时区分）。

## 六、柏讯侧对应文件（供对照）

```
docs/wire-presets/suites/wire-artifact-build.json      # 3 岗 fleet 模板
docs/wire-presets/pack-manifests/wire-artifact-build.json  # 构建产物（发布用）
docs/wire-presets/skills/wire-artifact-build/SKILL.md
wire-build-mcp/wire_build_mcp/tools_console.py         # _source_ref / 两个新工具
fd-wire/api/alembic/versions/20261023_0040_artifact_source_ref.py
fd-wire/openspec/changes/wire-content-fleet/           # 契约与任务
```
